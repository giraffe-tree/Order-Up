// selftest-store.js — 前端 store 纯逻辑自测：dish_served 工单配色需与 chef_action 一致
// 纯 Node，无依赖。用法：node scripts/selftest-store.js ；退出码 0=通过，1=失败。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// web/js/store.js 是给浏览器 <script> 标签直接引入的 UMD 脚本（非 ESM 模块，无 import/export），
// 用 Function 在顶层作用域跑一遍即可拿到它挂到 globalThis 的 COStore，不必为它单独搭构建/转译链路。
const storeSrc = fs.readFileSync(path.join(__dirname, '../web/js/store.js'), 'utf8');
new Function(storeSrc)();
const COStore = globalThis.COStore;

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✘ ${name}`); }
}

function snapshotWithChefs(chefs) {
  return { type: 'snapshot', kitchens: [{ id: 'k1', name: '厨房一', chefs }] };
}

console.log('▶ 用例：dish_served 工单配色需与 chef_action 完工工单一致（回归：两张工单曾各拿一套颜色逻辑）');

// 场景 1：同一 chefId 的「完工」（chef_action）与「出餐」（dish_served）两张工单同色
{
  const state = COStore.createState();
  COStore.applyEvent(state, snapshotWithChefs([
    { id: 'c1', name: '阿明', color: '#123456' },
    { id: 'c2', name: '小锅', color: '#abcdef' },
  ]));
  COStore.applyEvent(state, {
    type: 'chef_action', kitchenId: 'k1', chefId: 'c1',
    action: { kind: 'serve', label: '出餐', detail: '', ts: 1 },
  });
  COStore.applyEvent(state, {
    type: 'dish_served', kitchenId: 'k1',
    dish: { name: '红烧', task: '', by: '阿明', chefId: 'c1', ts: 2 },
  });
  const completeTicket = state.feed.find((e) => e.label === '出餐');
  const dishTicket = state.feed.find((e) => e.label === '出餐 ✅');
  ok(completeTicket && dishTicket && completeTicket.color === dishTicket.color && completeTicket.color === '#123456',
    `同一 chefId 的完工工单与出餐工单同色（实际 ${completeTicket?.color} / ${dishTicket?.color}）`);
}

// 场景 2：不同厨师（含跨厨房重名）各自拿到自己的颜色，互不串色
{
  const state = COStore.createState();
  COStore.applyEvent(state, snapshotWithChefs([
    { id: 'c1', name: '阿明', color: '#111111' },
    { id: 'c2', name: '阿明', color: '#222222' }, // 故意重名：验证按 chefId 而非按 name 取色
  ]));
  COStore.applyEvent(state, {
    type: 'dish_served', kitchenId: 'k1', dish: { name: '红烧', by: '阿明', chefId: 'c1', ts: 1 },
  });
  const ticket1 = state.feed[0];
  COStore.applyEvent(state, {
    type: 'dish_served', kitchenId: 'k1', dish: { name: '清蒸', by: '阿明', chefId: 'c2', ts: 2 },
  });
  const ticket2 = state.feed[0];
  ok(ticket1.color === '#111111' && ticket2.color === '#222222' && ticket1.color !== ticket2.color,
    `重名但不同 chefId 的厨师各拿到自己的颜色（实际 ${ticket1.color} / ${ticket2.color}）`);
}

// 场景 3：chefId 在当前厨房里找不到（未知/迟到快照）时安全兜底默认色，不抛异常
{
  const state = COStore.createState();
  COStore.applyEvent(state, snapshotWithChefs([{ id: 'c1', name: '阿明', color: '#333333' }]));

  let threw = false;
  try {
    COStore.applyEvent(state, {
      type: 'dish_served', kitchenId: 'k1', dish: { name: '神秘料理', by: '', chefId: 'no-such-chef', ts: 1 },
    });
  } catch { threw = true; }
  const missTicket = state.feed[0];
  ok(!threw && missTicket && typeof missTicket.color === 'string' && /^#[0-9a-f]{6}$/i.test(missTicket.color)
    && missTicket.color !== '#333333',
    `未知 chefId 安全兜底默认色、不抛异常（实际 ${missTicket?.color}）`);

  // 历史遗留数据兼容：dish 完全没有 chefId 字段也不应崩，同样落回默认色（不按 by 名字瞎猜）
  let threw2 = false;
  try {
    COStore.applyEvent(state, {
      type: 'dish_served', kitchenId: 'k1', dish: { name: '神秘料理2', by: '阿明', ts: 2 },
    });
  } catch { threw2 = true; }
  const legacyTicket = state.feed[0];
  ok(!threw2 && legacyTicket && legacyTicket.color === missTicket.color,
    `缺失 chefId 字段（历史/mock 旧数据）不抛异常，同样落回默认色（实际 ${legacyTicket?.color}）`);
}

console.log('');
console.log(`结果：${passed} 通过，${failed} 失败`);
if (failures.length) console.log('失败项：\n - ' + failures.join('\n - '));
process.exit(failed ? 1 : 0);
