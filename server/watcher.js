// watcher.js — 扫描 + 实时监听 ~/.codex/sessions 下的 JSONL 会话文件
// 启动时回放最近 48h（或最近 30 个）会话建立快照；之后增量 tail（fs.watch + 轮询兜底）。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// 单次读取上限：超大文件分多次消化，避免一次性把几百 MB 读进内存
const MAX_READ_BYTES = 8 * 1024 * 1024;
// 单行上限：写入中的半截行会暂存在 pending，防止异常长行撑爆内存
const MAX_LINE_BYTES = 2 * 1024 * 1024;

export class SessionWatcher {
  constructor({
    dir,
    store,
    pollMs = 3000,
    windowMs = 48 * 3600 * 1000,
    maxFiles = 30,
  } = {}) {
    this.dir = dir;
    this.store = store;
    this.pollMs = pollMs;
    this.windowMs = windowMs;
    this.maxFiles = maxFiles;
    this.indexFile = path.resolve(dir, '..', 'session_index.jsonl'); // 会话标题索引
    this._indexMtime = 0;
    this.files = new Map();   // 文件路径 -> { offset, pending, threadId, live }
    this.known = new Set();   // 所有扫描见过的路径
    this.watcher = null;
    this.timer = null;
    this._pending = new Map(); // watch 事件去抖
    this._stopped = false;
  }

  async start() {
    await this._loadNames().catch(() => {}); // 先加载标题索引，回放时即可用真名
    const list = await this._scan();
    const now = Date.now();
    const recent = list.filter((f) => now - f.mtimeMs <= this.windowMs);
    const chosen = new Set([...recent, ...list.slice(0, this.maxFiles)].map((f) => f.path));
    // 按时间升序回放，父子关系更稳
    const initial = list.filter((f) => chosen.has(f.path)).sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of initial) {
      const st = { offset: 0, pending: Buffer.alloc(0), threadId: null, live: false };
      this.files.set(f.path, st);
      await this._readMore(f.path, f.mtimeMs).catch(() => {});
    }
    this.store.afterReplay();
    // 回放结束，之后的新内容均为实时
    for (const st of this.files.values()) st.live = true;

    // fs.watch（macOS 支持 recursive），失败则只靠轮询
    try {
      this.watcher = fs.watch(this.dir, { recursive: true }, (_ev, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;
        const full = path.join(this.dir, filename);
        clearTimeout(this._pending.get(full));
        this._pending.set(full, setTimeout(() => {
          this._pending.delete(full);
          this._onChanged(full).catch(() => {});
        }, 150));
      });
      this.watcher.on('error', () => {});
    } catch {
      this.watcher = null;
    }
    this.timer = setInterval(() => this._poll().catch(() => {}), this.pollMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this._stopped = true;
    if (this.watcher) this.watcher.close();
    if (this.timer) clearInterval(this.timer);
    for (const t of this._pending.values()) clearTimeout(t);
  }

  // 加载 ~/.codex/session_index.jsonl：{ id, thread_name } → 交给 store 命名厨房
  async _loadNames() {
    const st = await fsp.stat(this.indexFile);
    if (st.mtimeMs === this._indexMtime) return;
    const text = await fsp.readFile(this.indexFile, 'utf8');
    const names = new Map();
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        if (o.id && o.thread_name) names.set(o.id, o.thread_name);
      } catch { /* 忽略坏行 */ }
    }
    this._indexMtime = st.mtimeMs;
    this.store.applyThreadNames(names);
  }

  async _scan() {
    const out = [];
    const walk = async (dir, depth) => {
      if (depth > 5) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) {
          try {
            const s = await fsp.stat(full);
            out.push({ path: full, mtimeMs: s.mtimeMs });
          } catch { /* 忽略 */ }
        }
      }
    };
    await walk(this.dir, 0);
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const f of out) this.known.add(f.path);
    return out;
  }

  async _poll() {
    if (this._stopped) return;
    await this._loadNames().catch(() => {}); // 标题可能迟到，轮询时补齐
    const before = new Set(this.known);
    const list = await this._scan();
    for (const f of list) {
      if (!before.has(f.path) && !this.files.has(f.path)) {
        // 新出现的会话文件：从头读并按实时处理
        this.files.set(f.path, { offset: 0, pending: Buffer.alloc(0), threadId: null, live: true });
      }
    }
    // 遍历「已跟踪」的文件（而非本次扫描结果），这样被删除的文件也能被察觉
    for (const [fpath, st] of this.files) {
      try {
        const s = await fsp.stat(fpath);
        if (s.size !== st.offset) await this._readMore(fpath, s.mtimeMs);
      } catch {
        // 文件被删除/轮转：摘掉跟踪状态；同名文件若重建会被当作新文件从头读
        this.files.delete(fpath);
        this.known.delete(fpath);
      }
    }
  }

  async _onChanged(full) {
    if (this._stopped) return;
    if (!this.files.has(full)) {
      this.known.add(full);
      this.files.set(full, { offset: 0, pending: Buffer.alloc(0), threadId: null, live: true });
    }
    await this._readMore(full, Date.now());
  }

  // 从 offset 增量读取；按 \n 字节切分，天然兼容 UTF-8 多字节
  async _readMore(file, mtimeMs) {
    const st = this.files.get(file);
    if (!st) return;
    const fh = await fsp.open(file, 'r');
    try {
      const { size } = await fh.stat();
      if (size < st.offset) { st.offset = 0; st.pending = Buffer.alloc(0); } // 文件被截断/轮转
      if (size === st.offset) {
        if (st.threadId) this.store.touchThread(st.threadId, mtimeMs || Date.now());
        return;
      }
      // 超大文件分块消化：本次最多读 MAX_READ_BYTES，剩余部分下轮 poll/watch 继续
      const len = Math.min(size - st.offset, MAX_READ_BYTES);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, st.offset);
      st.offset += bytesRead;
      if (bytesRead <= 0) return;
      const data = st.pending.length ? Buffer.concat([st.pending, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let start = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0x0a) {
          const line = data.subarray(start, i).toString('utf8').trim();
          start = i + 1;
          if (!line) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; } // 坏行跳过
          try { this.store.processLine(obj, st); } catch { /* 单行错误不阻塞 */ }
        }
      }
      // 半截行（写入中）暂存 pending；必须拷贝出来——subarray 会共享底层
      // 8MB 读缓冲，几十上百个被跟踪文件各钉住一个整块就是几百 MB 驻留
      // （真实数据冒烟实测 RSS 从 ~60MB 飙到 ~630MB 的元凶）
      st.pending = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
      // 但若 pending 超过单行上限，说明该行异常（或无换行的垃圾数据），丢弃以防内存膨胀
      if (st.pending.length > MAX_LINE_BYTES) st.pending = Buffer.alloc(0);
      if (st.threadId) this.store.touchThread(st.threadId, mtimeMs || Date.now());
    } finally {
      await fh.close().catch(() => {});
    }
  }
}
