/* 入口（ES module）：数据层 → store → 厨房切换系统 + 3D 渲染器（加载失败自动降级 stub）+ 订单票流水。
   严格遵守 plan.md 的 SSE/API 契约与「3D 渲染器 API 契约」。 */

const params = new URLSearchParams(location.search);
const useMock = params.has('mock');
const wantSelftest = params.has('selftest');

/* 自测模式：尽早收集运行时错误（控制台零报错断言用） */
const selftestErrors = [];
if (wantSelftest) {
  window.addEventListener('error', (e) => selftestErrors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => selftestErrors.push('rejection: ' + String(e.reason)));
}

const KIND_ICON = {
  read: '📖', edit: '🔪', exec: '🔥', search: '📞', tool: '⚡',
  think: '💭', speak: '🔔', serve: '✅', burn: '💥', join: '👨‍🍳', idle: '💤'
};
const KIND_COLOR = {
  read: '#B89B78', edit: '#D94F3D', exec: '#F57B4A', search: '#39AEC1',
  tool: '#928688', think: '#D2A06B', speak: '#F2C230', serve: '#58B24C',
  burn: '#D94F3D', join: '#447EE0', idle: '#928688'
};

const state = COStore.createState();

const stageEl = document.getElementById('stage');
const stageEmptyEl = document.getElementById('stage-empty');
const feedEl = document.getElementById('feed');
const connEl = document.getElementById('conn');
const statKitchens = document.getElementById('stat-kitchens');
const statActive = document.getElementById('stat-active');
const statChefs = document.getElementById('stat-chefs');
const statServed = document.getElementById('stat-served');

/* ---- 渲染器：优先 3D（web/js3d/kitchen3d.js），加载失败回退到占位 stub ----
   契约方法：setKitchen(kitchen, chefs) / addChef(chef) / chefAction(chefId, action)
             / chefStatus(chefId, status) / dishServed(dish) / resize() / dispose() */
const mod = await import('../js3d/kitchen3d.js').catch(() => import('./renderer-stub.js'));
let renderer = null;
let usingStub = !!mod.KitchenRenderer.isStub;
try {
  renderer = new mod.KitchenRenderer(stageEl);
} catch (err) {
  // 3D 模块加载成功但初始化失败（如无 WebGL 环境）：同样降级，保证壳可用
  usingStub = true;
}
if (usingStub && mod.KitchenRenderer.isStub !== true) {
  const stub = await import('./renderer-stub.js');
  renderer = new stub.KitchenRenderer(stageEl);
}
if (usingStub) {
  const badge = document.createElement('div');
  badge.className = 'renderer-badge';
  badge.id = 'renderer-badge';
  badge.textContent = '⚠ 占位渲染器（3D 不可用）';
  stageEl.appendChild(badge);
}
window.addEventListener('resize', () => renderer.resize());

/* ---- 厨房切换系统 ---- */
const ui = COKitchensUI.create({
  barEl: document.getElementById('sw-cards'),
  prevEl: document.getElementById('sw-prev'),
  nextEl: document.getElementById('sw-next'),
  followEl: document.getElementById('follow'),
  followTextEl: document.getElementById('follow-text'),
  onSwitch(kitchen) {
    // 切换厨房：渲染器清场重建，厨师从门口入场
    renderer.setKitchen(kitchen, kitchen.chefs || []);
    renderFeed(); // 「当前厨房」过滤跟随切换
  }
});

/* ---- 顶部统计 ---- */
function renderStats() {
  statKitchens.textContent = state.stats.kitchens;
  statActive.textContent = state.stats.activeKitchens;
  statChefs.textContent = state.stats.chefs;
  statServed.textContent = state.stats.served;
}

/* ---- 订单流水（Overcooked 票卡，最近 30 条，可过滤当前厨房/全部） ---- */
let feedMode = 'current';
const ffCurrent = document.getElementById('ff-current');
const ffAll = document.getElementById('ff-all');
ffCurrent.addEventListener('click', () => {
  feedMode = 'current';
  ffCurrent.classList.add('on');
  ffAll.classList.remove('on');
  renderFeed();
});
ffAll.addEventListener('click', () => {
  feedMode = 'all';
  ffAll.classList.add('on');
  ffCurrent.classList.remove('on');
  renderFeed();
});

const feedPanel = document.getElementById('feed-panel');
document.getElementById('feed-toggle').addEventListener('click', () => {
  feedPanel.classList.toggle('open');
});

function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => (n < 10 ? '0' : '') + n;
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderFeed() {
  feedEl.textContent = '';
  const curId = ui.currentId();
  let shown = 0;
  state.feed.forEach((entry) => {
    if (feedMode === 'current' && entry.kitchenId !== curId) return;
    shown++;
    const li = el('li', 'ticket kind-' + entry.kind);

    const tbar = el('div', 'tbar');
    tbar.style.background = KIND_COLOR[entry.kind] || '#928688';
    li.appendChild(tbar);

    const head = el('div', 't-head');
    head.appendChild(el('span', 't-icon', KIND_ICON[entry.kind] || '•'));
    head.appendChild(el('span', 't-label', entry.label || entry.kind));
    head.appendChild(el('span', 't-time', fmtTime(entry.ts)));
    li.appendChild(head);

    const body = el('div', 't-body');
    const chef = el('span', 't-chef', entry.chefName || '?');
    chef.style.background = entry.color || '#FEC457';
    body.appendChild(chef);
    if (entry.detail) body.appendChild(el('span', 't-detail', entry.detail));
    li.appendChild(body);

    if (feedMode === 'all' && entry.kitchenName) {
      li.appendChild(el('div', 't-kitchen', '@ ' + entry.kitchenName));
    }
    feedEl.appendChild(li);
  });
  if (!shown) {
    feedEl.appendChild(el('li', 'feed-empty',
      feedMode === 'current' ? '当前厨房还没有新订单～' : '还没有订单，等厨师们开工～'));
  }
}

/* 快照播种：流水为空时用各厨师最近动作填充（真实历史模式不至于空板） */
function seedFeed() {
  if (state.feed.length) return;
  const entries = [];
  state.kitchens.forEach((k) => {
    k.chefs.forEach((c) => {
      const a = c.lastAction;
      if (!a || a.kind === 'idle' || a.kind === 'join') return;
      entries.push({
        ts: a.ts || 0, kitchenId: k.id, kitchenName: k.name,
        chefName: c.name, color: c.color,
        kind: a.kind, label: a.label || a.kind, detail: a.detail || ''
      });
    });
  });
  entries.sort((a, b) => b.ts - a.ts);
  state.feed = entries.slice(0, COStore.MAX_FEED);
}

/* ---- 数据接入 ---- */
const handlers = {
  onSnapshot(kitchens) {
    const prevId = ui.currentId();
    COStore.applySnapshot(state, kitchens);
    ui.sync(state.kitchens);
    const cur = ui.currentKitchen();
    if (cur && cur.id === prevId) {
      // 当前厨房没变（如断线重连补拉）：重建渲染器与 store 对齐
      renderer.setKitchen(cur, cur.chefs || []);
    }
    stageEmptyEl.style.display = cur ? 'none' : '';
    seedFeed();
    renderStats();
    renderFeed();
  },

  onEvent(ev) {
    const effects = COStore.applyEvent(state, ev);

    // 非当前厨房的事件：只累计切换条红点（跟随开启时可能自动跳过去）
    const kid = ev.kitchenId || (ev.kitchen && ev.kitchen.id);
    if (kid && kid !== ui.currentId()) ui.noteEvent(kid);

    // 当前厨房的事件：转发给渲染器
    const curId = ui.currentId();
    effects.forEach((ef) => {
      if (ef.type === 'snapshot' || ef.kitchenId !== curId) return;
      switch (ef.type) {
        case 'chef_added':
          renderer.addChef(ef.chef);
          break;
        case 'chef_action':
          renderer.chefAction(ef.chef.id, ef.action);
          break;
        case 'chef_status':
          renderer.chefStatus(ef.chefId, ef.status);
          break;
        case 'dish_served':
          renderer.dishServed(ef.dish);
          break;
      }
    });

    ui.sync(state.kitchens); // lastTs/厨师数/出餐数可能已变化，刷新切换条排序
    stageEmptyEl.style.display = ui.currentKitchen() ? 'none' : '';
    renderStats();
    renderFeed();
  },

  onStatus(text, cls) {
    connEl.textContent = text;
    connEl.className = 'conn' + (cls ? ' ' + cls : '');
  }
};

if (useMock) COMock.connect(handlers);
else CONet.connect(handlers);

/* ---- 键盘切换：←/→ 前后间，数字键 1-9 直达 ---- */
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.key === 'ArrowLeft') { ui.prev(); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { ui.next(); e.preventDefault(); }
  else if (/^[1-9]$/.test(e.key)) ui.jump(Number(e.key));
});

/* ---- 自测（?mock=1&selftest=1）：脚本化断言，结果写入 #selftest-result ---- */
if (wantSelftest) {
  try {
    const st = await import('./selftest.js');
    st.run({ ui, state, renderer, usingStub, errors: selftestErrors });
  } catch (err) {
    console.error('selftest 加载失败', err);
  }
}
