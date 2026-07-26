// watcher.js — 扫描 + 实时监听 ~/.codex/sessions 下的 JSONL 会话文件
// 启动时回放最近 48h（或最近 30 个）会话建立快照；之后增量 tail（fs.watch + 轮询兜底）。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

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
    this.files = new Map();   // 文件路径 -> { offset, pending, threadId, live }
    this.known = new Set();   // 所有扫描见过的路径
    this.watcher = null;
    this.timer = null;
    this._pending = new Map(); // watch 事件去抖
    this._stopped = false;
  }

  async start() {
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
    const before = new Set(this.known);
    const list = await this._scan();
    for (const f of list) {
      if (!before.has(f.path) && !this.files.has(f.path)) {
        // 新出现的会话文件：从头读并按实时处理
        this.files.set(f.path, { offset: 0, pending: Buffer.alloc(0), threadId: null, live: true });
      }
    }
    for (const f of list) {
      const st = this.files.get(f.path);
      if (!st) continue;
      try {
        const s = await fsp.stat(f.path);
        if (s.size !== st.offset) await this._readMore(f.path, s.mtimeMs);
      } catch { /* 文件可能被清理 */ }
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
      if (size < st.offset) { st.offset = 0; st.pending = Buffer.alloc(0); } // 文件被截断
      if (size === st.offset) {
        if (st.threadId) this.store.touchThread(st.threadId, mtimeMs || Date.now());
        return;
      }
      const len = size - st.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.offset);
      st.offset = size;
      const data = st.pending.length ? Buffer.concat([st.pending, buf]) : buf;
      let start = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0x0a) {
          const line = data.subarray(start, i).toString('utf8').trim();
          start = i + 1;
          if (!line) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          try { this.store.processLine(obj, st); } catch { /* 单行错误不阻塞 */ }
        }
      }
      st.pending = data.subarray(start);
      if (st.threadId) this.store.touchThread(st.threadId, mtimeMs || Date.now());
    } finally {
      await fh.close();
    }
  }
}
