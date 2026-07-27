/* ?mock=1 模式：内置模拟数据，与 plan.md SSE 契约同构。
   4 间厨房 / 3 个项目：mock-k1 与 mock-k4 同 cwd（同项目的两个会话，验证
   「项目标签 → 会话卡片」两级切换），lastTs 错开（codex-overcooked > 多端设计评审 > api-server > hugo-blog），
   事件按轮换模式发往各家，覆盖全部 action.kind + chef_added/chef_status/dish_served，
   便于自测「项目标签排序 / 标签与卡片切换 / 未读红点聚合 / 订单票」。 */
(function (global) {
  'use strict';

  var SCRIPT = [
    { kind: 'read',   label: '看菜谱',     detail: 'src/server/parser.js' },
    { kind: 'think',  label: '想菜单',     detail: '先理清事件流结构…' },
    { kind: 'edit',   label: '切菜炒菜',   detail: 'apply_patch → web/js/main.js' },
    { kind: 'exec',   label: '开火上灶',   detail: 'node --check server/parser.js' },
    { kind: 'search', label: '打电话订食材', detail: 'codex sessions jsonl 格式' },
    { kind: 'tool',   label: '高压锅',     detail: 'mcp__fs__read_file' },
    { kind: 'speak',  label: '喊话',       detail: '马上就好，准备出餐！' },
    { kind: 'talk',   label: '给队友传话',  detail: '补丁我打好了一半，你接着炒' },
    { kind: 'serve',  label: '出餐',       detail: '增量解析完成' },
    { kind: 'burn',   label: '糊了',       detail: '命令退出码 1' },
    { kind: 'idle',   label: '休息',       detail: '' },
    { kind: 'read',   label: '看菜谱',     detail: 'README.md' },
    { kind: 'edit',   label: '切菜炒菜',   detail: 'apply_patch → server/watcher.js' },
    { kind: 'exec',   label: '开火上灶',   detail: 'npm test -- --watch=false' }
  ];

  /* 菜品池（web/js3d/dishes.js，ES module）：异步加载，就绪后 dish_served 按任务确定性挑菜；
     未就绪时退回兜底名。路径相对文档根（本文件以经典 script 引入，无法用静态 import） */
  var dishPool = null;
  import('../js3d/dishes.js').then(function (m) { dishPool = m; }).catch(function () {});

  var DISH_NAMES = ['香喷喷补丁', '回锅重构', '红烧单测', '清蒸文档', '干煸依赖'];

  function connect(handlers) {
    var now = Date.now();
    var kitchens = [
      {
        id: 'mock-k1', name: 'codex-overcooked', cwd: '/Users/dev/codex-overcooked',
        servedCount: 2, active: true, lastTs: now,
        chefs: [
          { id: 'c-amin', name: '阿明', role: '主厨', depth: 0, status: 'cooking', color: '#E0473C', lastAction: null },
          { id: 'c-xiaoguo', name: '小锅', role: '配菜', depth: 1, status: 'idle', color: '#58B24C', lastAction: null }
        ]
      },
      {
        id: 'mock-k4', name: '多端设计评审', cwd: '/Users/dev/codex-overcooked',
        servedCount: 1, active: true, lastTs: now - 30 * 1000,
        chefs: [
          { id: 'c-abo', name: '阿卜', role: null, depth: 0, status: 'idle', color: '#39AEC1', lastAction: null }
        ]
      },
      {
        id: 'mock-k2', name: 'api-server', cwd: '/Users/dev/api-server',
        servedCount: 5, active: true, lastTs: now - 60 * 1000,
        chefs: [
          { id: 'c-laowang', name: '老王', role: null, depth: 0, status: 'cooking', color: '#F2C230', lastAction: null }
        ]
      },
      {
        id: 'mock-k3', name: 'hugo-blog', cwd: '/Users/dev/hugo-blog',
        servedCount: 0, active: false, lastTs: now - 3 * 60 * 1000,
        chefs: [
          { id: 'c-ahua', name: '阿花', role: '文档工', depth: 0, status: 'idle', color: '#447EE0', lastAction: null }
        ]
      },
      {
        // 占位厨房（懒加载样例）：只有名字/cwd/项目信息，无厨师、lazy=true；
        // 点击切换后前端调 COMock.loadKitchen 拉完整历史（模拟 GET /api/kitchen/<id>/history）
        id: 'mock-k5', name: 'old-archive', cwd: '/Users/dev/old-archive',
        servedCount: 0, active: false, lastTs: now - 6 * 60 * 1000, lazy: true,
        chefs: []
      }
    ];

    /* 占位厨房加载后的完整形态由模块级 loadKitchen 生成（模拟服务端按需回放结果） */

    var chefsByKitchen = {
      'mock-k1': [['c-amin', '阿明'], ['c-xiaoguo', '小锅']],
      'mock-k2': [['c-laowang', '老王']],
      'mock-k3': [['c-ahua', '阿花']],
      'mock-k4': [['c-abo', '阿卜']]
    };
    /* 事件轮换模式：别家厨房持续来事件，测红点累计与「无自动跟随」 */
    var PATTERN = ['mock-k1', 'mock-k2', 'mock-k1', 'mock-k3', 'mock-k2', 'mock-k4', 'mock-k1', 'mock-k3'];

    var timers = [];
    function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

    if (handlers.onStatus) handlers.onStatus('模拟模式（mock）');
    handlers.onSnapshot(JSON.parse(JSON.stringify(kitchens)));

    var idx = 0, pIdx = 0, dishIdx = 0;
    function tick() {
      var step = SCRIPT[idx % SCRIPT.length];
      idx++;
      var kid = PATTERN[pIdx % PATTERN.length];
      pIdx++;
      var pool = chefsByKitchen[kid];
      var pick = pool[Math.floor(Math.random() * pool.length)];
      // talk（给队友传话）：带上同厨房另一位厨师的 target，厨师会走过去面对面交谈
      var action = { kind: step.kind, label: step.label, detail: step.detail, ts: Date.now() };
      if (step.kind === 'talk') {
        var mates = pool.filter(function (x) { return x[0] !== pick[0]; });
        action.target = mates.length ? mates[Math.floor(Math.random() * mates.length)][0] : null;
      }
      handlers.onEvent({
        type: 'chef_action', kitchenId: kid, chefId: pick[0],
        action: action
      });
      if (step.kind === 'serve') {
        later(function () {
          // 菜名从菜品池取：seed 带流水号，每次出餐菜品各不相同；dish.task 保留任务摘要
          var d = dishPool ? dishPool.pickDish(step.detail + '@' + kid + '#' + dishIdx) : null;
          var dish = { name: d ? d.name : DISH_NAMES[dishIdx % DISH_NAMES.length], task: step.detail, by: pick[1], ts: Date.now() };
          dishIdx++;
          handlers.onEvent({ type: 'dish_served', kitchenId: kid, dish: dish });
        }, 450);
      }
      later(tick, 650 + Math.random() * 750);
    }
    later(tick, 800);

    // 5 秒后 hugo-blog 新厨师入职（join：从门口走进来）
    later(function () {
      var k3 = kitchens.filter(function (x) { return x.id === 'mock-k3'; })[0];
      var chef = { id: 'c-xin', name: '小辣椒', role: '帮厨', depth: 1, status: 'cooking', color: '#C46A9E', lastAction: null };
      k3.chefs.push(chef);
      chefsByKitchen['mock-k3'].push(['c-xin', '小辣椒']);
      handlers.onEvent({ type: 'chef_added', kitchen: JSON.parse(JSON.stringify(k3)), chef: chef });
      handlers.onEvent({
        type: 'chef_action', kitchenId: 'mock-k3', chefId: 'c-xin',
        action: { kind: 'join', label: '新厨师入职', detail: 'depth 1', ts: Date.now() }
      });
    }, 5000);

    // 周期性 chef_status：闲置 → 回神，覆盖 status 通道
    later(function statusCycle() {
      var kids = Object.keys(chefsByKitchen);
      var kid = kids[Math.floor(Math.random() * kids.length)];
      var pool = chefsByKitchen[kid];
      var pick = pool[Math.floor(Math.random() * pool.length)];
      handlers.onEvent({ type: 'chef_status', kitchenId: kid, chefId: pick[0], status: 'idle' });
      later(function () {
        handlers.onEvent({ type: 'chef_status', kitchenId: kid, chefId: pick[0], status: 'cooking' });
      }, 2400);
      later(statusCycle, 11000);
    }, 8000);

    return { close: function () { timers.forEach(clearTimeout); } };
  }

  /* 占位厨房按需加载（mock 版 GET /api/kitchen/<id>/history）：
     300ms 延迟模拟网络/解析耗时，返回完整厨房（厨师到位、lazy=false、幂等） */
  function loadKitchen(id) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        if (id !== 'mock-k5') { resolve(null); return; }
        var now = Date.now();
        resolve({
          id: 'mock-k5', name: 'old-archive', cwd: '/Users/dev/old-archive',
          project: 'old-archive', servedCount: 2, active: false,
          lastTs: now - 6 * 60 * 1000, lazy: false,
          chefs: [
            { id: 'c-laodian', name: '老颠', role: null, depth: 0, status: 'idle', color: '#B85C48',
              lastAction: { kind: 'serve', label: '出餐', detail: '旧账归档完成', ts: now - 6 * 60 * 1000 } }
          ]
        });
      }, 300);
    });
  }

  global.COMock = { connect: connect, loadKitchen: loadKitchen };
})(typeof window !== 'undefined' ? window : globalThis);
