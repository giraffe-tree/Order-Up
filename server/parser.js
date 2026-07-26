// parser.js — JSONL 记录 → 厨房/厨师状态 与 标准事件
// 严格遵守 plan.md 的 SSE 契约。

import path from 'node:path';

export const ACTION_KINDS = ['read', 'edit', 'exec', 'search', 'tool', 'think', 'speak', 'serve', 'burn', 'join', 'idle'];

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

// 从 apply_patch 文本中提取涉及文件
function patchFiles(text) {
  const files = [];
  const re = /\*\*\*\s*(?:Update|Add|Delete)\s+File:\s*(.+)/g;
  let m;
  while ((m = re.exec(String(text ?? '')))) files.push(base(m[1].trim()));
  return files;
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
  }

  // ---------- 基础 API（真实数据与 demo 模拟器共用） ----------

  upsertKitchen({ id, name, cwd }) {
    let k = this.kitchens.get(id);
    if (!k) {
      k = {
        id, name: name || base(cwd) || id, cwd: cwd || '',
        chefs: [], servedCount: 0, active: true, lastTs: 0, lastWrite: 0,
      };
      this.kitchens.set(id, k);
    } else {
      if (name) k.name = name;
      if (cwd) { k.cwd = cwd; if (!name) k.name = base(cwd); }
    }
    return k;
  }

  upsertChef(kitchenId, { id, name, role = null, depth = 0 }, { live = true } = {}) {
    const k = this.kitchens.get(kitchenId);
    if (!k) return { chef: null, isNew: false };
    let chef = k.chefs.find((c) => c.id === id);
    let isNew = false;
    if (!chef) {
      chef = {
        id, name: name || '厨师 ' + String(id).slice(-4), role,
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
      if (name) chef.name = name;
      if (role !== undefined && role !== null) chef.role = role;
      if (typeof depth === 'number') chef.depth = depth;
    }
    return { chef, isNew };
  }

  action(kitchenId, chefId, kind, label, detail, ts) {
    const k = this.kitchens.get(kitchenId);
    const chef = k?.chefs.find((c) => c.id === chefId);
    if (!k || !chef) return;
    ts = ts || Date.now();
    const action = { kind, label, detail: trunc(detail), ts };
    chef.lastAction = action;
    k.lastTs = Math.max(k.lastTs, ts);
    const newStatus = kind === 'serve' ? 'done' : (kind === 'burn' || kind === 'idle') ? 'idle' : 'cooking';
    const changed = chef.status !== newStatus;
    chef.status = newStatus;
    this.emit({ type: 'chef_action', kitchenId, chefId, action });
    if (changed) this.emit({ type: 'chef_status', kitchenId, chefId, status: chef.status });
  }

  serve(kitchenId, chefId, name, ts) {
    const k = this.kitchens.get(kitchenId);
    const chef = k?.chefs.find((c) => c.id === chefId);
    if (!k || !chef) return;
    ts = ts || Date.now();
    k.servedCount += 1;
    const dish = { name: trunc(name, 24) || `第 ${k.servedCount} 道菜`, by: chef.name, ts };
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
      k.active = k.lastWrite > 0 ? (now - k.lastWrite < 10 * 60 * 1000) : k.active;
      for (const chef of k.chefs) {
        if (chef.status === 'cooking' && now - (chef.lastAction?.ts || 0) > 5000) {
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
      chefs: k.chefs.map((c) => ({ ...c })),
      servedCount: k.servedCount, active: k.active, lastTs: k.lastTs,
    };
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
    if (!parent && cwd) { k.cwd = cwd; k.name = base(cwd); } // 根线程权威命名
    this.threadKitchen.set(threadId, kitchenId);
    const depth = spawn?.depth ?? 0;
    const name = p.agent_nickname || spawn?.agent_nickname ||
      (depth === 0 ? '主厨 ' + String(threadId).slice(-4) : '厨师 ' + String(threadId).slice(-4));
    const role = spawn?.agent_role ?? null;
    this.upsertChef(kitchenId, { id: threadId, name, role, depth }, { live });
  }

  // fileState: { threadId, live }
  processLine(obj, fileState) {
    if (!obj || typeof obj !== 'object') return;
    const ts = Date.parse(obj.timestamp) || Date.now();
    const p = obj.payload || {};
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
    // turn_context / world_state / compacted 等忽略
  }

  _locate(threadId) {
    const kid = this.threadKitchen.get(threadId);
    const k = kid && this.kitchens.get(kid);
    const chef = k?.chefs.find((c) => c.id === threadId);
    return (k && chef) ? { k, chef } : null;
  }

  _act(p, ts, threadId, live, kind, label, detail) {
    if (!live) {
      // 历史回放：只更新状态，不发事件
      const loc = this._locate(threadId);
      if (!loc) return;
      const action = { kind, label, detail: trunc(detail), ts };
      loc.chef.lastAction = action;
      loc.k.lastTs = Math.max(loc.k.lastTs, ts);
      loc.chef.status = kind === 'serve' ? 'done' : (kind === 'burn' || kind === 'idle') ? 'idle' : 'cooking';
      if (kind === 'serve') loc.k.servedCount += 1;
      return;
    }
    const kid = this.threadKitchen.get(threadId);
    if (!kid) return;
    this.action(kid, threadId, kind, label, detail, ts);
  }

  _eventMsg(p, ts, threadId, live) {
    switch (p.type) {
      case 'task_started':
        this._act(p, ts, threadId, live, 'think', '开工', '接到新订单，开始干活');
        break;
      case 'task_complete': {
        const first = trunc(String(p.last_agent_message || '').split('\n')[0], 24);
        this._act(p, ts, threadId, live, 'serve', '出餐', first || '任务完成，上菜');
        if (live) {
          const kid = this.threadKitchen.get(threadId);
          const k = kid && this.kitchens.get(kid);
          const chef = k?.chefs.find((c) => c.id === threadId);
          if (k && chef) this.serve(kid, threadId, first || `第 ${k.servedCount + 1} 道菜`, ts);
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
      case 'exec_command_begin':
        this._act(p, ts, threadId, live, 'exec', '开火上灶', p.command || p.cmd || '执行命令');
        break;
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
        }
        break;
      default:
        break; // token_count 等忽略
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
          this._act(p, ts, threadId, live, 'think', '等队友', '等待协作 agent 反馈');
          break;
        case 'send_message':
          this._act(p, ts, threadId, live, 'speak', '给队友传话', args.message || args.text || '');
          break;
        default:
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
    }
    // function_call_output / reasoning / message 等忽略（由 event_msg 覆盖）
  }
}
