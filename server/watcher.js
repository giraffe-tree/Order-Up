// watcher.js — 扫描 + 实时监听 ~/.codex/sessions 下的 JSONL 会话文件
// 启动懒加载：默认只回放最近 replaySessions 个会话文件，且每个文件只回放
// 「首行 session_meta + 尾部 replayLines 行」（尾部偏移用从后往前读块定位，不整文件读入）；
// 其余旧会话只读首行建「占位厨房」（无厨师、不回放历史），前端点击后走
// loadKitchen() 按需完整回放；占位文件之后若有新写入会自动触发完整加载（活跃会话不掉线）。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// 单次读取上限：超大文件分多次消化，避免一次性把几百 MB 读进内存
const MAX_READ_BYTES = 8 * 1024 * 1024;
// 单行上限：写入中的半截行会暂存在 pending，防止异常长行撑爆内存
const MAX_LINE_BYTES = 2 * 1024 * 1024;
// 读取首行（session_meta）时的最大探测字节：超出视为不可用首行
const FIRST_LINE_MAX_BYTES = 256 * 1024;
// 定位尾部 N 行时的反向读块大小
const TAIL_CHUNK_BYTES = 64 * 1024;

export class SessionWatcher {
  constructor({
    dir,
    store,
    pollMs = 3000,
    replaySessions = 5,
    replayLines = 100,
  } = {}) {
    this.dir = dir;
    this.store = store;
    this.pollMs = pollMs;
    this.replaySessions = replaySessions;
    this.replayLines = replayLines;
    this.indexFile = path.resolve(dir, '..', 'session_index.jsonl'); // 会话标题索引
    this._indexMtime = 0;
    this.files = new Map();   // 文件路径 -> { offset, pending, threadId, live }
    this.known = new Set();   // 所有扫描见过的路径
    this.watcher = null;
    this.timer = null;
    this._pending = new Map(); // watch 事件去抖
    this._loading = new Map(); // kitchenId -> 进行中的按需加载 Promise（幂等防重）
    this._stopped = false;
  }

  async start() {
    await this._loadNames().catch(() => {}); // 先加载标题索引，回放时即可用真名
    const list = await this._scan();
    // 启动只回放最近 replaySessions 个会话（mtime 新到旧取前 N）
    const chosen = new Set(list.slice(0, this.replaySessions).map((f) => f.path));
    // 按时间升序回放，父子关系更稳
    const initial = list.filter((f) => chosen.has(f.path)).sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of initial) await this._replayFile(f).catch(() => {});
    this.store.afterReplay();
    // 回放结束，之后的新内容均为实时
    for (const st of this.files.values()) st.live = true;

    // 其余旧会话：只读首行建「占位厨房」（无厨师、不回放历史），
    // 前端点击后由 GET /api/kitchen/<id>/history → loadKitchen() 按需完整加载。
    // 同样按 mtime 升序注册，父子归并更稳。
    const rest = list.filter((f) => !chosen.has(f.path)).sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of rest) await this._placeholderFile(f).catch(() => {});

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
            out.push({ path: full, mtimeMs: s.mtimeMs, size: s.size });
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
        if (st.placeholder) {
          // 占位文件：被截断则对齐 offset；有新写入则自动完整加载（活跃会话不掉线）
          if (s.size < st.offset) st.offset = s.size;
          else if (s.size > st.offset && st.kitchenId) await this.loadKitchen(st.kitchenId).catch(() => {});
          continue;
        }
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
    const st = this.files.get(full);
    if (st.placeholder) {
      const s = await fsp.stat(full).catch(() => null);
      if (!s) return;
      if (s.size > st.offset && st.kitchenId) await this.loadKitchen(st.kitchenId).catch(() => {});
      return;
    }
    await this._readMore(full, Date.now());
  }

  // ---------- 启动懒加载：尾部回放 / 占位厨房 / 按需完整加载 ----------

  // 回放一个选中的会话文件：首行（session_meta）先行，再回放尾部 replayLines 行。
  // 首行必回放——否则尾部窗口不含 session_meta 时整间厨房会凭空消失。
  async _replayFile(f) {
    const st = { offset: 0, pending: Buffer.alloc(0), threadId: null, live: false };
    this.files.set(f.path, st);
    const first = await this._readFirstLine(f.path).catch(() => null);
    if (first) try { this.store.processLine(first.obj, st); } catch { /* 忽略 */ }
    const headEnd = first ? first.end : 0;
    const tail = await this._tailStart(f.path, this.replayLines).catch(() => 0);
    st.offset = Math.max(headEnd, tail);
    await this._readToEnd(f.path, f.mtimeMs);
  }

  // 旧会话占位：读首行 session_meta 注册占位厨房（无厨师），文件 offset 置于文件尾
  async _placeholderFile(f) {
    const st = {
      offset: f.size || 0, pending: Buffer.alloc(0), threadId: null,
      live: true, placeholder: true, kitchenId: null,
    };
    const first = await this._readFirstLine(f.path).catch(() => null);
    let payload = null;
    if (first && first.obj && first.obj.type === 'session_meta'
        && first.obj.payload && typeof first.obj.payload === 'object') {
      payload = first.obj.payload;
    } else {
      // 首行不可用时用文件名里的 uuid 兜底（rollout-<ts>-<uuid>.jsonl）
      const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(path.basename(f.path));
      if (m) payload = { id: m[1], cwd: '' };
    }
    const threadId = payload && (payload.id || payload.session_id);
    if (!threadId) return; // 无法定位线程：放弃占位（文件后续变更会按新文件从头读）
    this.store.placeholderMeta(payload, f.path, f.mtimeMs);
    st.kitchenId = this.store.threadKitchen.get(threadId) || null;
    if (!st.kitchenId) return;
    this.files.set(f.path, st);
  }

  // 按需完整加载某间厨房的所有未加载会话文件。
  // 幂等：加载中复用同一 Promise；已加载（无待加载文件）直接返回现状，不重复解析。
  async loadKitchen(kitchenId) {
    const k = this.store.kitchens.get(kitchenId);
    if (!k) return null;
    if (!k.lazyFiles || !k.lazyFiles.size) return this.store._pubKitchen(k);
    if (!this._loading.has(kitchenId)) {
      const job = (async () => {
        // mtime 升序回放，父子关系更稳
        const files = [...k.lazyFiles.entries()]
          .sort((a, b) => (a[1].mtimeMs || 0) - (b[1].mtimeMs || 0));
        for (const [file] of files) {
          let fst = null;
          try { fst = await fsp.stat(file); } catch { continue; } // 文件已删除：跳过
          const st = this.files.get(file) || {};
          st.offset = 0;
          st.pending = Buffer.alloc(0);
          st.threadId = null;
          st.live = false;
          st.placeholder = false;
          st.kitchenId = null;
          this.files.set(file, st);
          await this._readToEnd(file, fst.mtimeMs).catch(() => {});
          st.live = true;
        }
        k.lazyFiles.clear();
        k.lazy = false;
      })();
      this._loading.set(kitchenId, job);
      try { await job; } finally { this._loading.delete(kitchenId); }
    } else {
      await this._loading.get(kitchenId).catch(() => {});
    }
    // 广播完整厨房（含 chefs），所有在线客户端同步刷新
    this.store.emit({ type: 'kitchen_updated', kitchen: this.store._pubKitchen(k) });
    return this.store._pubKitchen(k);
  }

  // 从 st.offset 分块读到文件尾（每块 ≤ MAX_READ_BYTES），带无进展保护
  async _readToEnd(file, mtimeMs) {
    const st = this.files.get(file);
    if (!st) return;
    for (;;) {
      const before = st.offset;
      let size = 0;
      try { size = (await fsp.stat(file)).size; } catch { return; }
      if (size <= st.offset) break;
      await this._readMore(file, mtimeMs);
      if (st.offset <= before) break; // 无进展防死循环
    }
  }

  // 只读文件首行：返回 { obj, end }（end = 首行之后含换行的字节偏移），不可用返回 null
  async _readFirstLine(file) {
    const fh = await fsp.open(file, 'r');
    try {
      const { size } = await fh.stat();
      if (!size) return null;
      const len = Math.min(size, FIRST_LINE_MAX_BYTES);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, 0);
      if (bytesRead <= 0) return null;
      const nl = buf.indexOf(0x0a);
      const end = nl >= 0 ? nl + 1 : bytesRead;
      const text = buf.subarray(0, nl >= 0 ? nl : bytesRead).toString('utf8').trim();
      if (!text) return null;
      try { return { obj: JSON.parse(text), end }; } catch { return null; }
    } finally {
      await fh.close().catch(() => {});
    }
  }

  // 从后往前读块定位「最后 n 行」的起始字节偏移，避免整文件读入。
  // 文件末尾的半截行（写入中、无换行）计入 n——它会被 _readMore 暂存 pending。
  async _tailStart(file, n) {
    const fh = await fsp.open(file, 'r');
    try {
      const { size } = await fh.stat();
      if (!size || n <= 0) return n <= 0 ? size : 0;
      let pos = size;
      let count = 0;
      let firstChunk = true;
      while (pos > 0) {
        const len = Math.min(TAIL_CHUNK_BYTES, pos);
        pos -= len;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, pos);
        if (firstChunk) {
          firstChunk = false;
          if (buf[len - 1] !== 0x0a) count = 1; // 末尾半截行算一行
        }
        for (let i = len - 1; i >= 0; i--) {
          if (buf[i] === 0x0a) {
            count++;
            if (count > n) return pos + i + 1; // 最后 n 行从该换行之后开始
          }
        }
      }
      return 0; // 行数不足 n：从头回放
    } finally {
      await fh.close().catch(() => {});
    }
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
