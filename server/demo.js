// demo.js — --demo 模式模拟器：3 间厨房、5-8 位厨师，持续产出覆盖全部 action.kind 的随机事件流。

// 各类动作的逼真中文素材：[label, detail]
const POOL = {
  read: [
    ['看菜谱', '读文件 src/server/index.js'],
    ['看菜谱', '读文件 web/js/game.js'],
    ['看菜谱', '查看 README.md'],
    ['看菜谱', '读文件 package.json'],
    ['看菜谱', 'rg "chef_action" web/'],
    ['看菜谱', 'cat docs/plan.md'],
  ],
  edit: [
    ['切菜炒菜', '修改 server/parser.js'],
    ['切菜炒菜', '修改 web/css/style.css'],
    ['切菜炒菜', '修改 server/index.js、bin/cli.js'],
    ['切菜炒菜', '新增 web/js/sprite.js'],
  ],
  exec: [
    ['开火上灶', '执行 npm test'],
    ['开火上灶', '执行 node bin/codex-kitchen.js --demo'],
    ['开火上灶', '执行 git status --short'],
    ['开火上灶', '执行 curl -s localhost:4848/api/snapshot'],
    ['开火上灶', '执行 npm run build'],
  ],
  search: [
    ['打电话订食材', '搜索「SSE 断线重连 最佳实践」'],
    ['打电话订食材', '搜索「canvas 像素风 游戏循环」'],
    ['打电话订食材', '搜索「fs.watch recursive macOS」'],
  ],
  tool: [
    ['高压锅', '调用 MCP 工具 sites.get_site'],
    ['高压锅', '使用工具 update_goal'],
    ['高压锅', '调用 MCP 工具 browser.screenshot'],
  ],
  think: [
    ['想菜单', '规划：先解析 session_meta 再增量 tail'],
    ['想菜单', '思考厨房归并边界情况'],
    ['想菜单', '权衡轮询间隔与 CPU 占用'],
    ['等队友', '等待子 agent 反馈'],
  ],
  speak: [
    ['喊话', '锅快糊了，我去盯一下灶台！'],
    ['喊话', '这道菜还差最后一把火'],
    ['顾客点单', '把出餐口往右挪两格'],
  ],
  talk: [
    ['给队友传话', '补丁我打好了一半，你接着炒'],
    ['给队友派活', '顺手把自测也跑一遍'],
    ['给队友传话', '菜谱我改好了，你尝尝咸淡'],
    ['叫停队友', '那条路走不通，先停一下'],
  ],
  serve: [
    ['出餐', '完成快照接口'],
    ['出餐', '修复厨师 idle 判定'],
    ['出餐', '像素厨师跑起来了'],
    ['出餐', '端口自增逻辑搞定'],
  ],
  burn: [
    ['糊了', '订单中断（interrupted）'],
    ['糊了', '补丁应用失败'],
    ['糊了', '测试全红，回炉重造'],
  ],
};

const KITCHENS = [
  { id: 'demo-k1', name: 'flomo-codex', cwd: '/Users/demo/project/flomo-codex' },
  { id: 'demo-k2', name: 'pixel-rpg', cwd: '/Users/demo/project/pixel-rpg' },
  { id: 'demo-k3', name: 'blog-engine', cwd: '/Users/demo/project/blog-engine' },
];

// 厨师名不再显式指定：与真实数据同一条路——upsertChef 按 hash(id) 从 128 人
// 厨师池分配（demo id 固定，所以每次 --demo 看到的都是同一批名字，风格统一）
const CHEFS = [
  { k: 0, id: 'demo-c1', role: null, depth: 0 },
  { k: 0, id: 'demo-c2', role: 'explorer', depth: 1 },
  { k: 1, id: 'demo-c3', role: null, depth: 0 },
  { k: 1, id: 'demo-c4', role: 'worker', depth: 1 },
  { k: 2, id: 'demo-c5', role: null, depth: 0 },
  { k: 2, id: 'demo-c6', role: 'reviewer', depth: 1 },
];

const NEW_HIRES = [
  { role: 'worker' },
  { role: 'explorer' },
];

const KINDS = ['read', 'edit', 'exec', 'search', 'tool', 'think', 'speak', 'talk'];
const MAX_CHEFS = 8;

export function startDemo(store) {
  for (const k of KITCHENS) store.upsertKitchen(k);
  const chefs = [];
  for (const c of CHEFS) {
    const kid = KITCHENS[c.k].id;
    const { chef } = store.upsertChef(kid, { id: c.id, role: c.role, depth: c.depth }, { live: true });
    if (chef) chefs.push({ kid, id: c.id });
  }
  for (const k of KITCHENS) {
    const kk = store.kitchens.get(k.id);
    if (kk) kk.lastWrite = Date.now();
  }

  let stopped = false;
  let hires = 0;
  let sinceServe = 0;

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function tick() {
    if (stopped) return;
    const c = pick(chefs);
    sinceServe += 1;
    const r = Math.random();

    if (r < 0.04 && hires < NEW_HIRES.length && chefs.length < MAX_CHEFS) {
      // 新厨师入职（join）
      const h = NEW_HIRES[hires++];
      const id = 'demo-h' + hires;
      const { chef } = store.upsertChef(c.kid, { id, role: h.role, depth: 1 }, { live: true });
      if (chef) chefs.push({ kid: c.kid, id });
    } else if (r < 0.09 || sinceServe >= 18) {
      // 出餐（serve + dish_served）：菜名由 store.serve 按任务摘要从菜品池确定性挑选；
      // 任务摘要带上出餐序号作 seed，保证同一厨房连续出餐菜品各不相同
      sinceServe = 0;
      const [label, detail] = pick(POOL.serve);
      store.action(c.kid, c.id, 'serve', label, detail, Date.now());
      const n = (store.kitchens.get(c.kid)?.servedCount || 0) + 1;
      store.serve(c.kid, c.id, `${detail}（第 ${n} 单）`, Date.now());
    } else if (r < 0.13) {
      const [label, detail] = pick(POOL.burn);
      store.action(c.kid, c.id, 'burn', label, detail, Date.now());
    } else {
      const kind = pick(KINDS);
      const [label, detail] = pick(POOL[kind]);
      // 协作动作（talk / 等队友）带上队友 target：厨师会走到对方身边交谈
      let target;
      if (kind === 'talk' || (kind === 'think' && label === '等队友')) {
        const mates = chefs.filter((x) => x.kid === c.kid && x.id !== c.id);
        target = mates.length ? pick(mates).id : null;
      }
      store.action(c.kid, c.id, kind, label, detail, Date.now(), target);
    }
    // 随机间隔 0.3 ~ 2s
    setTimeout(tick, 300 + Math.random() * 1700);
  }
  setTimeout(tick, 500);

  return () => { stopped = true; };
}
