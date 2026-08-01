// parser.js — JSONL 记录 → 厨房/厨师状态 与 标准事件
// 严格遵守 plan.md 的 SSE 契约。

import path from 'node:path';
import { CHEF_NAMES, chefNameIndex } from './chef-names.js';
import { pickDish } from '../web/js3d/dishes.js';

export const ACTION_KINDS = ['read', 'edit', 'exec', 'search', 'tool', 'think', 'speak', 'talk', 'serve', 'burn', 'join', 'idle'];

// 暖色调色板（低饱和），按 chef id 哈希稳定分配
const PALETTE = [
  '#D96C4F', '#C98A3D', '#B85C48', '#E0925A', '#A9713F', '#D97945',
  '#C1533F', '#E3A76A', '#B4764D', '#CE6B52', '#8F5B3A', '#DB8E6B',
];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function colorFor(id) {
  return PALETTE[hashStr(String(id)) % PALETTE.length];
}

export function trunc(s, n = 80) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function base(p) {
  if (!p) return '';
  const b = path.basename(String(p).replace(/[/\\]+$/, ''));
  return b || String(p);
}

// 从 custom_tool_call 的 JS input 中提取 exec_command 的 cmd 参数
function extractCmd(input) {
  const m = /"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(input ?? ''));
  if (!m) return null;
  try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
}

// 从最后一条 agent 消息里提取有信息量的菜名：
// 跳过代码围栏 / JSON 输出行，剥离 markdown 标题、加粗、列表与链接语法；
// 取不到就返回 ''，由调用方走「线程标题 → 厨房名 → 第 N 道菜」兜底链。
// （真实数据抽样：约 1/3 的 task_complete 首行是 **加粗标题** 或 ``` 围栏 / {"outcome":...} 之类的 JSON）
export function dishNameFrom(message) {
  const lines = String(message ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let line of lines) {
    if (line.startsWith('```')) continue;          // 代码围栏
    if (/^[{[]/.test(line)) continue;              // JSON / 数组输出
    line = line
      .replace(/^#{1,6}\s+/, '')                   // ## 标题
      .replace(/^[-*+]\s+/, '')                    // 列表符
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')     // [文字](链接) → 文字
      .replace(/^\*\*(.+?)\*\*\.?$/, '$1')         // **整行加粗**
      .replace(/[*_]/g, '')                        // 残余强调符
      .trim();
    if (line.length >= 2) return trunc(line, 24);
  }
  return '';
}

// 读文件类命令（cat/sed/rg 等）归为 read，其余归 exec
const READ_CMD_RE = /^(cat|bat|sed|head|tail|less|more|nl|wc|ls|ll|find|rg|grep|tree|file|stat)\b/;

function parseArgs(raw) {
  try { return JSON.parse(raw); } catch { return {}; }
}

export class KitchenStore {
  constructor({ emit } = {}) {
    this.emit = emit || (() => {});
    this.kitchens = new Map();      // kitchenId -> kitchen（内部多 lastWrite 字段）
    this.threadParent = new Map();  // threadId -> parentThreadId
    this.threadKitchen = new Map(); // threadId -> kitchenId
    this.threadNames = new Map();   // threadId -> thread_name（来自 session_index.jsonl）
    // threadId -> { path, nick }：session_meta 里 subagent 的 agent_path / agent_nickname。
    // 真实数据里协作工具 target 绝大多数是 agent_path（/root/<slug>、裸 slug）或 '/root'，
    // 而不是 threadId——没有这个索引 _collabTarget 几乎永远解析不到（本机 952 个会话抽样核实）
    this.threadAlias = new Map();
  }

  // 会话标题索引（可在回放后反复调用；名字变化时发 kitchen_updated）
  applyThreadNames(names) {
    if (!names) return;
    for (const [id, name] of names) this.threadNames.set(id, name);
    for (const k of this.kitchens.values()) {
      if (!k.id.startsWith('t:')) continue;
      const rootId = k.id.slice(2);
      const real = this.threadNames.get(rootId);
      if (real && k.baseName !== real) {
        this._setBaseName(k, real);
        k.named = true;
      }
    }
  }

  // ---------- 基础 API（真实数据与 demo 模拟器共用） ----------

  upsertKitchen({ id, name, cwd }) {
    let k = this.kitchens.get(id);
    if (!k) {
      k = {
        id, name: name || base(cwd) || id, baseName: name || base(cwd) || id, cwd: cwd || '',
        chefs: [], servedCount: 0, active: true, lastTs: 0, lastWrite: 0,
      };
      this.kitchens.set(id, k);
      this._resolveNames(k.baseName); // 新厨房可能与既有厨房重名
    } else {
      if (name) this._setBaseName(k, name);
      if (cwd) { k.cwd = cwd; if (!name && !k.named) this._setBaseName(k, base(cwd)); }
    }
    return k;
  }

  // 重名消歧：baseName 是未加后缀的原始名；同一 baseName 有多间厨房时
  // 自动追加「 #短id」（README 承诺的行为）。名字变化时发 kitchen_updated。
  _setBaseName(k, bn) {
    if (!bn || k.baseName === bn) return;
    const old = k.baseName;
    k.baseName = bn;
    if (old) this._resolveNames(old); // 旧组可能只剩一间，应摘掉后缀
    this._resolveNames(bn);
  }

  _resolveNames(bn) {
    const group = [...this.kitchens.values()].filter((x) => x.baseName === bn);
    for (const x of group) {
      const short = x.id.replace(/^[a-z]+:/i, '').slice(-4);
      const want = group.length > 1 ? `${bn} #${short}` : bn;
      if (x.name !== want) {
        x.name = want;
        this.emit({ type: 'kitchen_updated', kitchen: this._pubKitchen(x) });
      }
    }
  }

  upsertChef(kitchenId, { id, role = null, depth = 0 }, { live = true } = {}) {
    const k = this.kitchens.get(kitchenId);
    if (!k) return { chef: null, isNew: false };
    let chef = k.chefs.find((c) => c.id === id);
    let isNew = false;
    if (!chef) {
      chef = {
        id, name: this._assignChefName(k, id), role,
        depth, status: 'idle', color: colorFor(id), lastAction: null,
      };
      k.chefs.push(chef);
      this.threadKitchen.set(id, kitchenId);
      isNew = true;
      if (live) {
        this.emit({ type: 'chef_added', kitchen: this._pubKitchen(k), chef: { ...chef } });
        this.action(kitchenId, id, 'join', '新厨师入职', `${chef.name} 系上围裙报到`, Date.now());
      }
    } else {
      // 名字入职时由 hash 一次性定死，之后绝不改（重名消歧/标题迟到都不再波及厨师名）
      if (role !== undefined && role !== null) chef.role = role;
      if (typeof depth === 'number') chef.depth = depth;
    }
    return { chef, isNew };
  }

  // 128 人厨师池（chef-names.js）：hash(thread 稳定 id) 取基准位；
  // 同一厨房内名字已被占用则顺延（index+1 mod 128）直到空闲。
  // 确定性：同一 id 在同一厨房永远拿到同一个名字——休息退场后重新入职、
  // 历史回放、断线重连补拉，名字都保持一致。
  _assignChefName(k, id) {
    const taken = new Set(k.chefs.map((c) => c.name));
    let idx = chefNameIndex(id);
    while (taken.has(CHEF_NAMES[idx])) idx = (idx + 1) % CHEF_NAMES.length;
    return CHEF_NAMES[idx];
  }

  action(kitchenId, chefId, kind, label, detail, ts, target) {
    const k = this.kitchens.get(kitchenId);
    const chef = k?.chefs.find((c) => c.id === chefId);
    if (!k || !chef) return;
    ts = ts || Date.now();
    const action = { kind, label, detail: trunc(detail), ts };
    // 协作动作（talk / 等队友的 think）带 target=队友厨师 id；未解析到则为 null
    if (target !== undefined) action.target = target;
    chef.lastAction = action;
    k.lastTs = Math.max(k.lastTs, ts);
    const newStatus = kind === 'serve' ? 'done' : (kind === 'burn' || kind === 'idle') ? 'idle' : 'cooking';
    const changed = chef.status !== newStatus;
    chef.status = newStatus;
    this.emit({ type: 'chef_action', kitchenId, chefId, action });
    if (changed) this.emit({ type: 'chef_status', kitchenId, chefId, status: chef.status });
  }

  serve(kitchenId, chefId, taskName, ts) {
    const k = this.kitchens.get(kitchenId);
    const chef = k?.chefs.find((c) => c.id === chefId);
    if (!k || !chef) return;
    ts = ts || Date.now();
    k.servedCount += 1;
    // 菜名从菜品池按任务确定性挑选：同一任务在同一厨房永远同一道菜，不同任务均匀分布。
    // dish.task 保留原任务摘要（兜底链结果），供订单流水展示。
    const d = pickDish(String(taskName || '') + '@' + kitchenId);
    const task = trunc(taskName, 24) || `第 ${k.servedCount} 道菜`;
    // chefId 随 dish 一起下发：厨师名在跨厨房场景下可能重复（_assignChefName 只在厨房内去重），
    // 前端「出餐」工单要与「完工」工单同色，必须按稳定 id 找厨师，不能只认名字。
    const dish = { name: d.name, task, by: chef.name, chefId: chef.id, ts };
    this.emit({ type: 'dish_served', kitchenId, dish });
  }

  touchThread(threadId, ts) {
    const kid = this.threadKitchen.get(threadId);
    const k = kid && this.kitchens.get(kid);
    if (k) k.lastWrite = Math.max(k.lastWrite, ts);
  }

  // 每 1s 由服务器调用：5s 无事件厨师 → idle；10min 无写入厨房 → active:false
  tick() {
    const now = Date.now();
    for (const k of this.kitchens.values()) {
      // 歇业状态翻转要主动广播：否则前端只能等下次快照/重连才知道厨房歇业，
      // 期间 store 又被 chef_action 乐观置活，歇业门牌随重建时机忽亮忽暗（「门牌闪烁」根因之一）
      const wasActive = k.active;
      k.active = k.lastWrite > 0 ? (now - k.lastWrite < 10 * 60 * 1000) : k.active;
      if (k.active !== wasActive) this.emit({ type: 'kitchen_updated', kitchen: this._pubKitchen(k) });
      for (const chef of k.chefs) {
        // cooking 与 done（出餐后定格）都要能回 idle，否则厨师出完餐永远罚站
        if ((chef.status === 'cooking' || chef.status === 'done') &&
            now - (chef.lastAction?.ts || 0) > 5000) {
          // 先发 idle 动作（契约 action.kind 含 idle），再发 chef_status
          this.action(k.id, chef.id, 'idle', '歇口气', '忙完一阵，擦擦手待命', now);
        }
      }
    }
  }

  // 历史回放结束后调用：把所有厨师静默置 idle（不发事件）
  afterReplay() {
    const now = Date.now();
    for (const k of this.kitchens.values()) {
      for (const chef of k.chefs) {
        if (chef.status === 'cooking') {
          chef.status = 'idle';
          if (chef.lastAction && now - chef.lastAction.ts > 5000) { /* 保持历史动作 */ }
        }
      }
    }
  }

  snapshot() {
    const kitchens = [...this.kitchens.values()]
      .map((k) => this._pubKitchen(k))
      .sort((a, b) => b.lastTs - a.lastTs);
    return { kitchens };
  }

  _pubKitchen(k) {
    return {
      id: k.id, name: k.name, cwd: k.cwd,
      project: k.cwd ? base(k.cwd) : '', // 项目名 = cwd 目录名，供前端「项目 → 会话」分组
      chefs: k.chefs.map((c) => ({ ...c })),
      servedCount: k.servedCount, active: k.active, lastTs: k.lastTs,
      lazy: !!k.lazy, // true=还有会话文件未完整回放（占位厨房），点击后按需加载
    };
  }

  // 占位厨房（懒加载）：只登记线程归属/父子关系/厨房壳与待加载文件清单，
  // 不建厨师、不发事件；前端点击后由 watcher.loadKitchen() 完整回放并广播 kitchen_updated。
  placeholderMeta(p, file, mtimeMs) {
    const threadId = p.id || p.session_id;
    if (!threadId) return;
    const spawn = p.source?.subagent?.thread_spawn;
    const parent = spawn?.parent_thread_id || p.parent_thread_id || p.forked_from_id || null;
    if (parent && parent !== threadId) this.threadParent.set(threadId, parent);
    const kitchenId = 't:' + (parent ? this.resolveRoot(threadId) : threadId);
    const k = this.upsertKitchen({ id: kitchenId, cwd: p.cwd || '' });
    if (!parent && p.cwd) {
      // 根线程权威命名：优先 session_index 里的会话标题，拿不到再用目录名；已命名不降级
      const real = this.threadNames.get(threadId);
      if (real) { this._setBaseName(k, real); k.named = true; }
      else if (!k.named) this._setBaseName(k, base(p.cwd));
    }
    this.threadKitchen.set(threadId, kitchenId);
    const aliasPath = spawn?.agent_path || null;
    const aliasNick = spawn?.agent_nickname || p.agent_nickname || null;
    if (aliasPath || aliasNick) this.threadAlias.set(threadId, { path: aliasPath, nick: aliasNick });
    if (!k.lazyFiles) k.lazyFiles = new Map(); // file -> { threadId, mtimeMs }
    k.lazyFiles.set(file, { threadId, mtimeMs: mtimeMs || 0 });
    k.lazy = true;
    // 纯占位厨房默认歇业（历史文件）；已活跃厨房来新占位文件时不强行打烊
    if (!k.lastWrite) k.active = false;
    if (mtimeMs) k.lastTs = Math.max(k.lastTs || 0, mtimeMs);
  }

  // ---------- 真实 JSONL 记录解析 ----------

  resolveRoot(threadId) {
    let cur = threadId;
    const seen = new Set();
    while (this.threadParent.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.threadParent.get(cur);
    }
    return cur;
  }

  processMeta(p, ts, live) {
    const threadId = p.id || p.session_id;
    if (!threadId) return;
    const spawn = p.source?.subagent?.thread_spawn;
    const parent = spawn?.parent_thread_id || p.parent_thread_id || p.forked_from_id || null;
    if (parent && parent !== threadId) this.threadParent.set(threadId, parent);
    const cwd = p.cwd || '';
    let kitchenId;
    if (parent) {
      kitchenId = 't:' + this.resolveRoot(threadId);
    } else if (threadId) {
      kitchenId = 't:' + threadId;
    } else {
      kitchenId = 'cwd:' + cwd;
    }
    const k = this.upsertKitchen({ id: kitchenId, cwd });
    if (!parent && cwd) {
      k.cwd = cwd;
      // 根线程权威命名：优先 session_index 里的会话标题，拿不到再用目录名；已命名不降级
      const real = this.threadNames.get(threadId);
      if (real) { this._setBaseName(k, real); k.named = true; }
      else if (!k.named) this._setBaseName(k, base(cwd));
    }
    this.threadKitchen.set(threadId, kitchenId);
    const depth = spawn?.depth ?? 0;
    // 协作目标解析用别名：agent_path（/root/<slug>）与 agent_nickname（如 'Locke'）
    const aliasPath = spawn?.agent_path || null;
    const aliasNick = spawn?.agent_nickname || p.agent_nickname || null;
    if (aliasPath || aliasNick) this.threadAlias.set(threadId, { path: aliasPath, nick: aliasNick });
    // 厨师名统一走 128 人厨师池（upsertChef 内部 hash(threadId) 分配，厨房内撞名顺延）。
    // 不再用会话标题当主厨名（标题是厨房名/招牌，归 _setBaseName 管），也不再用
    // agent_nickname / agent_path——真实数据里它们常是「019f9e57…」这类线程 id 前缀。
    const role = spawn?.agent_role ?? null;
    this.upsertChef(kitchenId, { id: threadId, role, depth }, { live });
  }

  // fileState: { threadId, live }
  processLine(obj, fileState) {
    if (!obj || typeof obj !== 'object') return;
    // timestamp 可能是 ISO 字符串或毫秒数字
    const rawTs = obj.timestamp;
    const ts = (typeof rawTs === 'number' && Number.isFinite(rawTs)) ? rawTs
      : (Date.parse(rawTs) || Date.now());
    // payload 偶尔可能是字符串等非对象，统一兜底为 {}
    const p = (obj.payload && typeof obj.payload === 'object') ? obj.payload : {};
    const live = fileState ? fileState.live : true;
    if (obj.type === 'session_meta') {
      this.processMeta(p, ts, live);
      if (fileState && (p.id || p.session_id)) fileState.threadId = p.id || p.session_id;
      return;
    }
    const threadId = fileState?.threadId;
    if (!threadId) return;
    if (obj.type === 'event_msg') this._eventMsg(p, ts, threadId, live);
    else if (obj.type === 'response_item') this._responseItem(p, ts, threadId, live);
    // 其余顶层类型按语义忽略（基于本机最近 30 个真实会话抽样核实）：
    // - turn_context / world_state：每回合的 cwd/模型/权限快照，无动作语义；
    // - compacted：上下文压缩后的替换历史，伴随的 event_msg(context_compacted) 已单独映射；
    // - inter_agent_communication_metadata：跨 agent 消息的信封元数据（正文加密），
    //   协作语义已由 spawn_agent / send_message / sub_agent_activity 覆盖。
  }

  _locate(threadId) {
    const kid = this.threadKitchen.get(threadId);
    const k = kid && this.kitchens.get(kid);
    const chef = k?.chefs.find((c) => c.id === threadId);
    return (k && chef) ? { k, chef } : null;
  }

  _act(p, ts, threadId, live, kind, label, detail, target) {
    if (!live) {
      // 历史回放：只更新状态，不发事件
      const loc = this._locate(threadId);
      if (!loc) return;
      const action = { kind, label, detail: trunc(detail), ts };
      if (target !== undefined) action.target = target;
      loc.chef.lastAction = action;
      loc.k.lastTs = Math.max(loc.k.lastTs, ts);
      loc.chef.status = kind === 'serve' ? 'done' : (kind === 'burn' || kind === 'idle') ? 'idle' : 'cooking';
      if (kind === 'serve') loc.k.servedCount += 1;
      return;
    }
    const kid = this.threadKitchen.get(threadId);
    if (!kid) return;
    this.action(kid, threadId, kind, label, detail, ts, target);
  }

  // 协作事件目标队友解析：args 里的 thread/agent id、路径（/root/<slug>）、昵称 → 同厨房厨师 id。
  // 真实数据抽样（本机 952 个会话）：
  //   send_message     { target }      target 形态：/root（59%）、/root/<slug>（31%）、裸 slug（10%）
  //   followup_task    { target, message }   同上，路径形态
  //   interrupt_agent  { target }      同上
  //   wait_agent       { targets:[threadId…] }（偶发 { ids:['/root/<slug>'] }）——数组，取第一个
  // 解析不到返回 null（前端退化为「找最近的另一位厨师」）。
  _collabTarget(threadId, args) {
    let raw = args?.thread_id ?? args?.threadId ?? args?.target_thread_id
      ?? args?.agent_id ?? args?.agentId ?? args?.agent ?? args?.target
      ?? args?.targets ?? args?.ids ?? args?.receiver ?? args?.to;
    if (raw == null || raw === '') return null;
    const kid = this.threadKitchen.get(threadId);
    const k = kid && this.kitchens.get(kid);
    if (!k) return null;
    // wait_agent 的 targets/ids 是数组（同时等多人）：逐个尝试，走向第一个能解析到的
    const raws = Array.isArray(raw) ? raw : [raw];
    for (const r of raws) {
      const hit = this._matchChef(threadId, k, r);
      if (hit) return hit;
    }
    return null;
  }

  _matchChef(threadId, k, raw) {
    if (raw == null || raw === '') return null;
    const s = String(raw);
    const others = k.chefs.filter((c) => c.id !== threadId);
    // 1) 完整/截断 threadId 互配（wait_agent 的 targets 就是完整 threadId）
    let hit = others.find((c) => c.id === s || c.id.endsWith(s) || s.endsWith(c.id));
    // 2) 路径形态：'/root' → 根线程主厨；'/root/<slug>' / 裸 slug → agent_path 或昵称匹配
    if (!hit) {
      if (s === '/root' || s === 'root') {
        hit = others.find((c) => 't:' + c.id === k.id);
      } else {
        const slug = s.startsWith('/') ? s.split('/').pop() : s;
        if (slug) {
          hit = others.find((c) => {
            const a = this.threadAlias.get(c.id);
            return !!a && (a.path === s || (a.path && a.path.split('/').pop() === slug)
              || (a.nick && (a.nick === s || a.nick === slug)));
          });
        }
      }
    }
    // 3) 厨师名宽匹配（兜底）
    if (!hit) hit = others.find((c) => c.name === s || s.includes(c.name) || c.name.includes(s));
    return hit ? hit.id : null;
  }

  _eventMsg(p, ts, threadId, live) {
    switch (p.type) {
      case 'task_started':
        this._act(p, ts, threadId, live, 'think', '开工', '接到新订单，开始干活');
        break;
      case 'task_complete': {
        // 任务摘要兜底链：最后一条消息里的有效标题行（剥离 markdown、跳过 JSON/围栏）
        // → 线程标题 → 厨房名 → 第 N 道菜；菜名则由 serve() 按任务摘要从菜品池确定性挑选
        const first = dishNameFrom(p.last_agent_message);
        const fallback = this.threadNames.get(threadId) || '';
        this._act(p, ts, threadId, live, 'serve', '出餐', first || fallback || '任务完成，上菜');
        if (live) {
          const kid = this.threadKitchen.get(threadId);
          const k = kid && this.kitchens.get(kid);
          const chef = k?.chefs.find((c) => c.id === threadId);
          if (k && chef) this.serve(kid, threadId, first || fallback || k.name || `第 ${k.servedCount + 1} 道菜`, ts);
        }
        break;
      }
      case 'turn_aborted':
        this._act(p, ts, threadId, live, 'burn', '糊了', `订单中断（${p.reason || '未知原因'}）`);
        break;
      case 'agent_reasoning':
        this._act(p, ts, threadId, live, 'think', '想菜单', p.text || '思考中');
        break;
      case 'agent_message':
        this._act(p, ts, threadId, live, 'speak', '喊话', p.message || '');
        break;
      case 'user_message':
        this._act(p, ts, threadId, live, 'speak', '顾客点单', p.message || '');
        break;
      case 'patch_apply_end': {
        if (p.success === false) {
          this._act(p, ts, threadId, live, 'burn', '糊了', '补丁应用失败');
        } else {
          let files = p.changes ? Object.keys(p.changes).map(base) : [];
          if (!files.length && p.stdout) {
            files = p.stdout.split('\n').map((l) => l.trim())
              .filter((l) => /^[AMD]\s+/.test(l)).map((l) => base(l.slice(2)));
          }
          this._act(p, ts, threadId, live, 'edit', '切菜炒菜', files.length ? `修改 ${files.slice(0, 3).join('、')}` : '应用补丁');
        }
        break;
      }
      case 'exec_command_begin': {
        // 旧版 codex 的 command 是 argv 数组，新版是字符串
        const cmd = Array.isArray(p.command) ? p.command.join(' ') : (p.command || p.cmd);
        // 与 response_item 路径一致：只读命令分流到案板，避免 cat/rg 被误标「开火」
        if (cmd && READ_CMD_RE.test(cmd.trim())) this._act(p, ts, threadId, live, 'read', '看菜谱', cmd);
        else this._act(p, ts, threadId, live, 'exec', '开火上灶', cmd || '执行命令');
        break;
      }
      case 'web_search_end':
        this._act(p, ts, threadId, live, 'search', '打电话订食材', p.query || '搜索资料');
        break;
      case 'mcp_tool_call_end': {
        const inv = p.invocation || {};
        this._act(p, ts, threadId, live, 'tool', '高压锅', `调用 ${inv.server || 'MCP'}.${inv.tool || ''}`);
        break;
      }
      case 'sub_agent_activity':
        if (p.kind === 'started') {
          this._act(p, ts, threadId, live, 'join', '派出小厨师', base(p.agent_path) || '子 agent 开工');
        } else if (p.kind === 'interrupted') {
          this._act(p, ts, threadId, live, 'burn', '糊了', '小厨师被叫停，菜撒了一地');
        }
        break;
      case 'context_compacted':
        // 上下文压缩：厨师把旧菜谱收进抽屉，腾出案板
        this._act(p, ts, threadId, live, 'think', '收拾台面', '上下文压缩，旧菜谱收进抽屉');
        break;
      case 'thread_goal_updated': {
        const obj = String(p.goal?.objective || '').split('\n')[0];
        this._act(p, ts, threadId, live, 'think', '更新订单目标', obj || '更新线程目标');
        break;
      }
      case 'image_generation_end':
        this._act(p, ts, threadId, live, 'tool', '画招牌', p.revised_prompt || '生成图片');
        break;
      case 'thread_rolled_back':
        this._act(p, ts, threadId, live, 'think', '复盘', '回滚了若干回合，重新来过');
        break;
      default:
        break; // 忽略：token_count（纯计数噪音）、thread_settings_applied（模型/权限配置快照，无动作语义）
    }
  }

  _responseItem(p, ts, threadId, live) {
    if (p.type === 'function_call') {
      const args = parseArgs(p.arguments);
      switch (p.name) {
        case 'exec_command': {
          const cmd = args.cmd || args.command || '';
          if (READ_CMD_RE.test(cmd.trim())) this._act(p, ts, threadId, live, 'read', '看菜谱', cmd);
          else this._act(p, ts, threadId, live, 'exec', '开火上灶', cmd || '执行命令');
          break;
        }
        case 'apply_patch':
          break; // 与 patch_apply_end 重复，跳过
        case 'view_image':
          this._act(p, ts, threadId, live, 'read', '看图片', args.path || '查看图片');
          break;
        case 'update_plan': {
          const step = (args.plan || []).find((s) => s.status === 'in_progress');
          this._act(p, ts, threadId, live, 'think', '想菜单', step ? `规划：${step.step}` : '更新计划');
          break;
        }
        case 'wait':
        case 'wait_agent':
          // 等队友：走到那位队友厨师旁边面对面等（前端见 action.target）
          this._act(p, ts, threadId, live, 'think', '等队友', '等待协作 agent 反馈', this._collabTarget(threadId, args));
          break;
        case 'send_message': {
          // 给队友传话：走到目标厨师身边交谈（talk）。
          // 真实数据里 message 正文 100% 是 gAAAAA… 密文（跨 agent 信封加密），
          // 直接上气泡是一串乱码 → 密文时改用「给 <目标> 发了条加密消息」做展示
          const msg = String(args.message || args.text || '');
          const encrypted = /^gAAAAA/.test(msg) || /^[A-Za-z0-9_\-+/=]{120,}$/.test(msg);
          const toName = base(String(args.target ?? '')) || '队友';
          const detail = encrypted ? `给 ${toName === 'root' ? '主厨' : toName} 发了条加密消息`
            : (msg || `给 ${toName} 传话`);
          this._act(p, ts, threadId, live, 'talk', '给队友传话', detail, this._collabTarget(threadId, args));
          break;
        }
        case 'write_stdin': {
          // 长命令运行期间的终端交互：chars 为空=查看输出，非空=输入
          const chars = String(args.chars ?? '');
          if (chars.trim()) this._act(p, ts, threadId, live, 'exec', '喂柴火', `向终端输入 ${trunc(chars, 24)}`);
          else this._act(p, ts, threadId, live, 'exec', '盯灶台', '查看终端输出');
          break;
        }
        case 'list_agents':
          this._act(p, ts, threadId, live, 'think', '点名', '查看队友名单');
          break;
        case 'spawn_agent':
          this._act(p, ts, threadId, live, 'join', '派出小厨师', args.task_name || args.agent_type || '派出子 agent');
          break;
        case 'followup_task':
          this._act(p, ts, threadId, live, 'talk', '给队友派活', base(args.target) || '追加后续任务', this._collabTarget(threadId, args));
          break;
        case 'interrupt_agent':
          this._act(p, ts, threadId, live, 'talk', '叫停队友', base(args.target) || '打断协作 agent', this._collabTarget(threadId, args));
          break;
        case 'get_goal':
          this._act(p, ts, threadId, live, 'think', '看订单', '查看当前目标');
          break;
        case 'create_goal':
          this._act(p, ts, threadId, live, 'think', '想菜单', '立下新目标');
          break;
        case 'update_goal':
          this._act(p, ts, threadId, live, 'think', '想菜单', '更新目标');
          break;
        case 'imagegen':
          this._act(p, ts, threadId, live, 'tool', '画招牌', args.prompt || '生成图片');
          break;
        default:
          // 兜底：run / js / _get_site / _deploy_* / automation_update 等低频或
          // 下划线内部工具（本机抽样各 1~2 次），统一按「特殊厨具」展示即可
          this._act(p, ts, threadId, live, 'tool', '特殊厨具', `使用工具 ${p.name}`);
      }
    } else if (p.type === 'custom_tool_call') {
      if (p.name === 'exec') {
        const cmd = extractCmd(p.input) || '执行命令';
        if (READ_CMD_RE.test(cmd.trim())) this._act(p, ts, threadId, live, 'read', '看菜谱', cmd);
        else this._act(p, ts, threadId, live, 'exec', '开火上灶', cmd);
      } else if (p.name === 'apply_patch') {
        // 与 patch_apply_end 重复，跳过
      } else {
        this._act(p, ts, threadId, live, 'tool', '特殊厨具', `使用工具 ${p.name || 'custom'}`);
      }
    } else if (p.type === 'tool_search_call') {
      this._act(p, ts, threadId, live, 'think', '找厨具', '查找可用工具');
    }
    // 忽略：function_call_output / custom_tool_call_output / reasoning / message /
    // agent_message（response_item 里的 agent_message 与 event_msg 重复）
  }
}
