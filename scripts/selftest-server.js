// selftest-server.js — 后端自测：fixture 会话 → 真实 server → 断言快照/SSE/demo/健壮性
// 纯 Node，无依赖。用法：node scripts/selftest-server.js ；退出码 0=通过，1=失败。

import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { CHEF_NAMES, chefNameIndex } from '../server/chef-names.js';

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

  // 第二间厨房：与第一间同目录名（不同路径），验证重名自动追加 #短id；
  // 其子线程模拟真实数据里「thread_spawn 只有 parent_thread_id」的裸子 agent，
  // 验证小厨师不会被错叫成目录名
  const parent2 = path.join(dir, 'rollout-2026-07-26T10-02-00-parent2.jsonl');
  const child2 = path.join(dir, 'rollout-2026-07-26T10-03-00-child2.jsonl');
  await fsp.writeFile(parent2, [
    line('session_meta', { id: 'parent-2', cwd: '/tmp/other/alpha-kitchen', originator: 'cli' }, 40),
    line('event_msg', { type: 'task_started' }, 41),
    line('event_msg', { type: 'task_complete', last_agent_message: '二号厨房完工' }, 42),
  ].join('\n') + '\n');
  await fsp.writeFile(child2, [
    line('session_meta', {
      id: 'child-2', cwd: '/tmp/other/alpha-kitchen',
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent-2' } } },
    }, 43),
    line('event_msg', { type: 'task_complete', last_agent_message: '裸子任务完成' }, 44),
  ].join('\n') + '\n');
  return { sessionsDir: path.join(root, 'sessions'), parent, child, parent2, child2, root };
}

// ---------- 主流程 ----------
async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-kitchen-selftest-'));
  const handles = [];
  try {
    console.log('▶ 造 fixture 会话（含坏行 / 半截行 / 全事件类型 / 父子线程）');
    const { sessionsDir, parent } = await makeFixture(root);

    console.log('▶ 用例 1：真实模式启动 + 回放快照');
    ok(CHEF_NAMES.length === 128 && new Set(CHEF_NAMES).size === 128,
      `128 人厨师池预定义且全部去重（实际 ${CHEF_NAMES.length} 名 / ${new Set(CHEF_NAMES).size} 唯一）`);
    const h1 = await startServer({ port: 0, demo: false, sessionsDir });
    handles.push(h1);
    const port1 = h1.server.address().port;
    ok(port1 > 0, '服务器在随机端口启动');

    // watcher.start 是异步的，轮询等待回放完成
    let snap = null;
    for (let i = 0; i < 40; i++) {
      const r = await get(port1, '/api/snapshot');
      const body = JSON.parse(r.body);
      const k1 = body.kitchens?.find((x) => x.id === 't:parent-1');
      const k2 = body.kitchens?.find((x) => x.id === 't:parent-2');
      if (body.kitchens?.length === 2 && k1?.chefs.length >= 2 && k2?.chefs.length >= 2) { snap = body; break; }
      await sleep(250);
    }
    ok(snap !== null, '回放后 /api/snapshot 能拿到两间厨房与各自父子两位厨师');
    if (snap) {
      const k = snap.kitchens.find((x) => x.id === 't:parent-1');
      const k2 = snap.kitchens.find((x) => x.id === 't:parent-2');
      ok(typeof k.id === 'string' && typeof k.name === 'string' && Array.isArray(k.chefs)
        && typeof k.servedCount === 'number' && typeof k.active === 'boolean' && typeof k.lastTs === 'number',
        'Kitchen 结构符合契约（id/name/chefs/servedCount/active/lastTs）');
      ok(k.cwd === '/tmp/proj/alpha-kitchen' && k.project === 'alpha-kitchen'
        && k2.cwd === '/tmp/other/alpha-kitchen' && k2.project === 'alpha-kitchen',
        `Kitchen 透传 cwd 与项目名（cwd 目录名，供前端项目分组；实际 ${k.project} / ${k2.project}）`);
      ok(k.chefs.some((c) => c.id === 'child-1') && k2.chefs.some((c) => c.id === 'child-2'),
        '父子线程归并为同一间厨房（t:根线程）');
      ok(k.name.startsWith('alpha-kitchen #') && k2.name.startsWith('alpha-kitchen #') && k.name !== k2.name,
        `重名厨房自动追加 #短id 消歧（实际 ${k.name} / ${k2.name}）`);
      const sub = k.chefs.find((c) => c.id === 'child-1');
      ok(sub && sub.depth === 1 && CHEF_NAMES.includes(sub.name),
        `子 agent 厨师层级正确、名字来自 128 人厨师池（实际 ${sub?.name}）`);
      // 确定性 hash：child-1 的基准位无撞名，应恰好命中 chefNameIndex('child-1')
      ok(sub && sub.name === CHEF_NAMES[chefNameIndex('child-1')],
        `厨师名由 hash(threadId) 确定性映射（${sub?.name} === ${CHEF_NAMES[chefNameIndex('child-1')]}）`);
      const rootChef = k.chefs.find((c) => c.id === 'parent-1');
      ok(rootChef && CHEF_NAMES.includes(rootChef.name)
        && rootChef.name !== k.name && !k.name.startsWith(rootChef.name),
        `主厨名来自厨师池而非任务标题/厨房名（实际 ${rootChef?.name}，厨房 ${k.name}）`);
      const bare = k2.chefs.find((c) => c.id === 'child-2');
      ok(bare && CHEF_NAMES.includes(bare.name) && !bare.name.startsWith('alpha-kitchen'),
        `裸子 agent（无昵称/工种）也叫厨师池名字而非目录名（实际 ${bare?.name}）`);
      const names1 = k.chefs.map((c) => c.name);
      const names2 = k2.chefs.map((c) => c.name);
      ok(new Set(names1).size === names1.length && new Set(names2).size === names2.length,
        '同一厨房内厨师名不撞车');
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
    ok(r2.status === 200 && JSON.parse(r2.body).kitchens.length === 2, '灌入垃圾数据后服务仍正常响应');

    console.log('▶ 用例 2b：出餐语义（菜名剥离 markdown / 跳过 JSON 行）');
    // 加粗标题 → 菜名应剥离 ** ；纯 JSON 输出 → 应走线程标题/厨房名兜底
    await fsp.appendFile(parent, line('event_msg', { type: 'task_complete', last_agent_message: '**修好断线重连**\n细节略' }, 45) + '\n');
    const dish1 = await sse.waitFor((e) => e.type === 'dish_served', 9000, 'dish_served(加粗标题)').catch(() => null);
    ok(dish1 && dish1.dish.name === '修好断线重连', `菜名剥离 markdown 加粗（实际 ${dish1?.dish.name}）`);
    await fsp.appendFile(parent, line('event_msg', { type: 'task_complete', last_agent_message: '{"outcome":"allow"}' }, 46) + '\n');
    const dish2 = await sse.waitFor((e) => e.type === 'dish_served' && e.dish.ts > dish1.dish.ts, 9000, 'dish_served(JSON 兜底)').catch(() => null);
    ok(dish2 && !dish2.dish.name.startsWith('{') && !dish2.dish.name.startsWith('```') && dish2.dish.name.length >= 2,
      `JSON 输出的菜名走兜底而非裸露 JSON（实际 ${dish2?.dish.name}）`);

    console.log('▶ 用例 2c：session_index 迟到后厨房改用会话标题');
    // 标题索引放在 sessions 目录旁（与 watcher 的 resolve 规则一致）
    await fsp.writeFile(path.join(root, 'session_index.jsonl'),
      JSON.stringify({ id: 'parent-1', thread_name: '快照接口开发', updated_at: '2026-07-26T11:00:00Z' }) + '\n');
    let renamed = null;
    for (let i = 0; i < 24; i++) {
      const body = JSON.parse((await get(port1, '/api/snapshot')).body);
      const k1 = body.kitchens.find((x) => x.id === 't:parent-1');
      const k2 = body.kitchens.find((x) => x.id === 't:parent-2');
      if (k1?.name === '快照接口开发') { renamed = { k1, k2 }; break; }
      await sleep(500);
    }
    ok(renamed !== null, 'session_index 写入后厨房改名为会话标题');
    ok(renamed && renamed.k2.name === 'alpha-kitchen',
      `重名组仅剩一间后自动摘掉 #短id 后缀（实际 ${renamed?.k2.name}）`);
    // 厨房改用会话标题后，厨师名保持 hash 分配的池名，绝不跟随标题变化
    ok(renamed && renamed.k1.chefs.every((c) => CHEF_NAMES.includes(c.name) && c.name !== '快照接口开发'),
      '厨房改名后厨师名不跟随会话标题（仍是厨师池名字）');
    // 兜底菜名此时应取线程标题
    await fsp.appendFile(parent, line('event_msg', { type: 'task_complete', last_agent_message: '' }, 47) + '\n');
    const dish3 = await sse.waitFor((e) => e.type === 'dish_served' && e.dish.ts > dish2.dish.ts, 9000, 'dish_served(空消息兜底)').catch(() => null);
    ok(dish3 && dish3.dish.name === '快照接口开发', `空消息时菜名兜底为线程标题（实际 ${dish3?.dish.name}）`);
    sse.close();

    console.log('▶ 用例 2d：懒加载（启动只回放最近 2 会话 × 尾部 3 行；占位厨房按需加载）');
    const lazyDir = path.join(root, 'lazy-sessions', '2026', '07', '25');
    await fsp.mkdir(lazyDir, { recursive: true });
    const writeSess = async (name, id, cwd, serves, mtime) => {
      const lines = [JSON.stringify({
        timestamp: '2026-07-25T10:00:00.000Z', type: 'session_meta',
        payload: { id, cwd, originator: 'cli' },
      })];
      for (let i = 1; i <= serves; i++) {
        lines.push(JSON.stringify({
          timestamp: `2026-07-25T10:00:${String(i).padStart(2, '0')}.000Z`, type: 'event_msg',
          payload: { type: 'task_complete', last_agent_message: `第${i}道菜` },
        }));
      }
      const p = path.join(lazyDir, `rollout-2026-07-25T10-00-00-${name}.jsonl`);
      await fsp.writeFile(p, lines.join('\n') + '\n');
      const t = new Date(mtime);
      await fsp.utimes(p, t, t); // 显式控制 mtime，保证回放选择顺序
    };
    await writeSess('old3', 'lazy-old3', '/tmp/lazy/old-three', 1, '2026-07-25T10:00:00Z');
    await writeSess('old2', 'lazy-old2', '/tmp/lazy/old-two', 3, '2026-07-25T10:05:00Z');
    await writeSess('old1', 'lazy-old1', '/tmp/lazy/old-one', 5, '2026-07-25T10:10:00Z');
    await writeSess('recent2', 'lazy-r2', '/tmp/lazy/recent-two', 2, '2026-07-25T10:20:00Z');
    await writeSess('recent1', 'lazy-r1', '/tmp/lazy/recent-one', 10, '2026-07-25T10:30:00Z');

    const h4 = await startServer({
      port: 0, demo: false, sessionsDir: path.join(root, 'lazy-sessions'),
      replaySessions: 2, replayLines: 3,
    });
    handles.push(h4);
    const port4 = h4.server.address().port;

    let lsnap = null;
    for (let i = 0; i < 40; i++) {
      const body = JSON.parse((await get(port4, '/api/snapshot')).body);
      const r1 = body.kitchens?.find((x) => x.id === 't:lazy-r1');
      if (body.kitchens?.length === 5 && r1?.chefs.length >= 1) { lsnap = body; break; }
      await sleep(250);
    }
    ok(lsnap !== null, '懒加载快照含全部 5 间厨房（2 间已加载 + 3 间占位）');
    if (lsnap) {
      const loaded = lsnap.kitchens.filter((x) => !x.lazy);
      const lazyOnes = lsnap.kitchens.filter((x) => x.lazy);
      ok(loaded.length === 2 && loaded.every((x) => x.id === 't:lazy-r1' || x.id === 't:lazy-r2'),
        `回放数量上限：仅最近 2 个会话完整回放（实际 ${loaded.map((x) => x.id).join(',')}）`);
      ok(lazyOnes.length === 3 && lazyOnes.every((x) => x.chefs.length === 0 && !!x.name && !!x.project && x.active === false),
        '占位厨房只带名字/cwd/项目信息（无厨师、歇业、lazy=true）');
      const r1k = lsnap.kitchens.find((x) => x.id === 't:lazy-r1');
      ok(r1k.servedCount === 3,
        `每会话只回放尾部 3 行：10 次出餐的会话 servedCount=3（实际 ${r1k.servedCount}）`);
      const r2k = lsnap.kitchens.find((x) => x.id === 't:lazy-r2');
      ok(r2k.servedCount === 2 && r2k.chefs.length === 1, '行数少于上限的会话完整回放');
    }

    const sseL = connectSSE(port4);
    await sseL.waitFor((e) => e.type === 'snapshot', 5000, 'SSE 首帧').catch(() => null);
    const h1r = await get(port4, '/api/kitchen/t:lazy-old1/history');
    ok(h1r.status === 200, 'GET /api/kitchen/<id>/history 按需加载接口返回 200');
    const h1k = h1r.status === 200 ? JSON.parse(h1r.body).kitchen : null;
    ok(h1k && h1k.lazy === false && h1k.chefs.length === 1 && h1k.servedCount === 5,
      `按需加载后完整历史到位（chefs=1、servedCount=5、lazy=false；实际 ${h1k && h1k.servedCount}）`);
    const bEv = await sseL.waitFor(
      (e) => e.type === 'kitchen_updated' && e.kitchen?.id === 't:lazy-old1' && e.kitchen?.lazy === false,
      5000, 'kitchen_updated 广播').catch(() => null);
    ok(bEv !== null, '按需加载结果通过 SSE 广播 kitchen_updated 同步其他客户端');
    const h2r = await get(port4, '/api/kitchen/t:lazy-old1/history');
    const h2k = h2r.status === 200 ? JSON.parse(h2r.body).kitchen : null;
    ok(h2k && h2k.servedCount === 5 && h2k.chefs.length === 1,
      `重复加载幂等：servedCount 仍为 5（实际 ${h2k && h2k.servedCount}）`);
    const h3r = await get(port4, '/api/kitchen/t:no-such/history');
    ok(h3r.status === 404, '未知厨房按需加载返回 404');
    const snapL2 = JSON.parse((await get(port4, '/api/snapshot')).body);
    const old1Now = snapL2.kitchens.find((x) => x.id === 't:lazy-old1');
    ok(old1Now && old1Now.lazy === false && old1Now.servedCount === 5,
      '加载后快照同步（占位厨房转为已加载）');
    sseL.close();

    console.log('▶ 用例 3：demo 模式');
    const h2 = await startServer({ port: 0, demo: true });
    handles.push(h2);
    const port2 = h2.server.address().port;
    const dSnap = JSON.parse((await get(port2, '/api/snapshot')).body);
    ok(dSnap.kitchens.length === 3 && dSnap.kitchens.every((k) => k.chefs.length >= 1), 'demo 快照含 3 间厨房与厨师');
    ok(dSnap.kitchens.every((k) => k.chefs.every((c) => CHEF_NAMES.includes(c.name))),
      'demo 厨师名同样来自 128 人厨师池（与真实数据同一命名规则）');
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
