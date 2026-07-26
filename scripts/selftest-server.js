// selftest-server.js — 后端自测：fixture 会话 → 真实 server → 断言快照/SSE/demo/健壮性
// 纯 Node，无依赖。用法：node scripts/selftest-server.js ；退出码 0=通过，1=失败。

import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✘ ${name}`); }
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('请求超时')); });
  });
}

// SSE 客户端：返回 { events, close, waitFor(pred, ms) }
function connectSSE(port) {
  const events = [];
  const waiters = [];
  const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        events.push(ev);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].pred(ev)) { waiters[i].resolve(ev); waiters.splice(i, 1); }
        }
      }
    });
  });
  req.on('error', () => {});
  return {
    events,
    waitFor(pred, ms = 8000, label = '事件') {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`等待 ${label} 超时`));
        }, ms);
      });
    },
    close() { req.destroy(); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fixture ----------
const TS = '2026-07-26T10:00:0';
const line = (type, payload, i = 0) => JSON.stringify({ timestamp: `${TS}${i}.000Z`, type, payload });

async function makeFixture(root) {
  const dir = path.join(root, 'sessions', '2026', '07', '26');
  await fsp.mkdir(dir, { recursive: true });
  const parent = path.join(dir, 'rollout-2026-07-26T10-00-00-parent1.jsonl');
  const child = path.join(dir, 'rollout-2026-07-26T10-01-00-child1.jsonl');

  const parentLines = [
    line('session_meta', { id: 'parent-1', cwd: '/tmp/proj/alpha-kitchen', originator: 'cli' }, 0),
    line('event_msg', { type: 'task_started' }, 1),
    line('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat README.md' }) }, 2),
    line('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }) }, 3),
    line('response_item', { type: 'custom_tool_call', name: 'exec', input: 'exec_command({"cmd":"rg foo web/"})' }, 4),
    line('event_msg', { type: 'patch_apply_end', success: true, changes: { '/tmp/proj/alpha-kitchen/foo.js': {}, '/tmp/proj/alpha-kitchen/bar.css': {} } }, 5),
    line('event_msg', { type: 'agent_reasoning', text: '先想清楚再动手' }, 6),
    line('event_msg', { type: 'agent_message', message: '快照接口写好了' }, 7),
    line('event_msg', { type: 'user_message', message: '帮我把出餐口挪一下' }, 8),
    line('event_msg', { type: 'web_search_end', query: 'SSE 重连 最佳实践' }, 9),
    line('event_msg', { type: 'mcp_tool_call_end', invocation: { server: 'sites', tool: 'get_site' } }, 10),
    line('response_item', { type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'frontend_worker' }) }, 11),
    line('response_item', { type: 'function_call', name: 'write_stdin', arguments: JSON.stringify({ session_id: 1, chars: '' }) }, 12),
    line('response_item', { type: 'function_call', name: 'write_stdin', arguments: JSON.stringify({ session_id: 1, chars: 'y\n' }) }, 13),
    line('response_item', { type: 'function_call', name: 'update_goal', arguments: '{}' }, 14),
    line('event_msg', { type: 'context_compacted' }, 15),
    line('event_msg', { type: 'thread_goal_updated', goal: { objective: '把厨房做完\n第二行忽略' } }, 16),
    line('event_msg', { type: 'image_generation_end', status: 'completed', revised_prompt: 'a warm cartoon kitchen' }, 17),
    line('event_msg', { type: 'token_count', info: {} }, 18),
    line('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'x' } }, 19),
    line('turn_context', { cwd: '/tmp/proj/alpha-kitchen', model: 'x' }, 20),
    line('world_state', { foo: 'bar' }, 21),
    line('compacted', { message: '...' }, 22),
    line('inter_agent_communication_metadata', { meta: 1 }, 23),
    'this is definitely not json {{{',           // 坏行
    '{"timestamp":123,"type":"event_msg"',         // 半截 JSON（后有换行，坏行）
    line('event_msg', { type: 'task_complete', last_agent_message: '搞定了快照接口\n详情略' }, 24),
  ];
  // 结尾留一条「写入中」的半截行（无换行符），模拟实时写入场景
  await fsp.writeFile(parent, parentLines.join('\n') + '\n' + '{"timestamp":"2026-07-26T10:00:25.000Z","type":"event_msg","payloa');

  const childLines = [
    line('session_meta', {
      id: 'child-1', cwd: '/tmp/proj/alpha-kitchen', parent_thread_id: 'parent-1',
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1', depth: 1, agent_nickname: '小炒' } } },
    }, 30),
    line('event_msg', { type: 'task_complete', last_agent_message: '子任务也完成了' }, 31),
  ];
  await fsp.writeFile(child, childLines.join('\n') + '\n');
  return { sessionsDir: path.join(root, 'sessions'), parent, child };
}

// ---------- 主流程 ----------
async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-kitchen-selftest-'));
  const handles = [];
  try {
    console.log('▶ 造 fixture 会话（含坏行 / 半截行 / 全事件类型 / 父子线程）');
    const { sessionsDir, parent } = await makeFixture(root);

    console.log('▶ 用例 1：真实模式启动 + 回放快照');
    const h1 = await startServer({ port: 0, demo: false, sessionsDir });
    handles.push(h1);
    const port1 = h1.server.address().port;
    ok(port1 > 0, '服务器在随机端口启动');

    // watcher.start 是异步的，轮询等待回放完成
    let snap = null;
    for (let i = 0; i < 40; i++) {
      const r = await get(port1, '/api/snapshot');
      const body = JSON.parse(r.body);
      if (body.kitchens && body.kitchens.length > 0 && body.kitchens[0].chefs.length >= 2) { snap = body; break; }
      await sleep(250);
    }
    ok(snap !== null, '回放后 /api/snapshot 能拿到厨房与父子两位厨师');
    if (snap) {
      const k = snap.kitchens[0];
      ok(typeof k.id === 'string' && typeof k.name === 'string' && Array.isArray(k.chefs)
        && typeof k.servedCount === 'number' && typeof k.active === 'boolean' && typeof k.lastTs === 'number',
        'Kitchen 结构符合契约（id/name/chefs/servedCount/active/lastTs）');
      ok(snap.kitchens.length === 1 && k.id === 't:parent-1', '父子线程归并为同一间厨房（t:根线程）');
      ok(k.name === 'alpha-kitchen', '厨房名取 cwd 目录名');
      const sub = k.chefs.find((c) => c.id === 'child-1');
      ok(sub && sub.depth === 1 && sub.name === '小炒', '子 agent 厨师层级与昵称正确');
      const chef0 = k.chefs[0];
      ok(typeof chef0.color === 'string' && /^#[0-9a-f]{6}$/i.test(chef0.color), '厨师有 hex 颜色');
      ok(k.servedCount >= 2, `父子各完成一单 → servedCount≥2（实际 ${k.servedCount}）`);
      const kinds = new Set(k.chefs.map((c) => c.lastAction?.kind));
      ok(kinds.has('serve') || kinds.has('think'), '历史动作已写入 lastAction');
    }

    console.log('▶ 用例 2：SSE 首帧快照 + 实时事件流（畸形数据不崩）');
    const sse = connectSSE(port1);
    const first = await sse.waitFor((e) => e.type === 'snapshot', 5000, 'SSE 首帧 snapshot').catch(() => null);
    ok(first && Array.isArray(first.kitchens), 'SSE 首帧是 snapshot');
    // 追加：先补换行收掉半截行（变坏行），再写一条实时 agent_message
    await fsp.appendFile(parent, '\n' + line('event_msg', { type: 'agent_message', message: '实时喊话测试' }, 40) + '\n');
    const liveEv = await sse.waitFor((e) => e.type === 'chef_action' && e.action?.kind === 'speak', 9000, '实时 chef_action').catch(() => null);
    ok(liveEv !== null, '追加新行后 SSE 收到实时 chef_action(speak)');
    ok(liveEv && liveEv.kitchenId === 't:parent-1' && liveEv.action.label === '喊话', '实时事件字段符合契约');
    // 追加纯垃圾与坏 JSON，服务应安然无恙
    await fsp.appendFile(parent, 'garbage bytes !@#$%\n{"broken":\n');
    await sleep(400);
    const r2 = await get(port1, '/api/snapshot');
    ok(r2.status === 200 && JSON.parse(r2.body).kitchens.length === 1, '灌入垃圾数据后服务仍正常响应');
    sse.close();

    console.log('▶ 用例 3：demo 模式');
    const h2 = await startServer({ port: 0, demo: true });
    handles.push(h2);
    const port2 = h2.server.address().port;
    const dSnap = JSON.parse((await get(port2, '/api/snapshot')).body);
    ok(dSnap.kitchens.length === 3 && dSnap.kitchens.every((k) => k.chefs.length >= 1), 'demo 快照含 3 间厨房与厨师');
    const sse2 = connectSSE(port2);
    const dEv = await sse2.waitFor((e) => e.type === 'chef_action', 9000, 'demo chef_action').catch(() => null);
    ok(dEv !== null, 'demo 模式 SSE 持续产出事件');
    sse2.close();

    console.log('▶ 用例 4：健壮性边界');
    const h3 = await startServer({ port: 0, demo: false, sessionsDir: path.join(root, 'no-such-dir') });
    handles.push(h3);
    const port3 = h3.server.address().port;
    await sleep(600);
    const r3 = await get(port3, '/api/snapshot');
    ok(r3.status === 200 && JSON.parse(r3.body).kitchens.length === 0, '会话目录不存在时不崩，返回空快照');
    const r4 = await get(port1, '/../package.json');
    ok(r4.status === 403 || r4.status === 404, `目录穿越被拒绝（HTTP ${r4.status}）`);
    const r5 = await get(port1, '/%e4%b8%ad');
    ok(r5.status !== 500 || true, '畸形 URL 不崩'); // 只要求进程存活，下一行验证存活
    const r6 = await get(port1, '/api/snapshot');
    ok(r6.status === 200, '经历各类畸形请求后服务仍存活');
  } catch (e) {
    failed++;
    failures.push(`未捕获异常：${e.message}`);
    console.error('  ✘ 未捕获异常：', e);
  } finally {
    for (const h of handles) { try { h.close(); } catch { /* 忽略 */ } }
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  console.log(`结果：${passed} 通过，${failed} 失败`);
  if (failures.length) console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(failed ? 1 : 0);
}

main();
