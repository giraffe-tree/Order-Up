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
  think: '💭', speak: '🔔', talk: '💬', serve: '✅', burn: '💥', join: '👨‍🍳', idle: '💤'
};
const KIND_COLOR = {
  read: '#B89B78', edit: '#D94F3D', exec: '#F57B4A', search: '#39AEC1',
  tool: '#928688', think: '#D2A06B', speak: '#F2C230', talk: '#E8923C', serve: '#58B24C',
  burn: '#D94F3D', join: '#447EE0', idle: '#928688'
};

const state = COStore.createState();

const stageEl = document.getElementById('stage');
const stageEmptyEl = document.getElementById('stage-empty');
const feedEl = document.getElementById('feed');
const connEl = document.getElementById('conn');
const connBanner = document.getElementById('conn-banner');
const statKitchens = document.getElementById('stat-kitchens');
const statActive = document.getElementById('stat-active');
const statChefs = document.getElementById('stat-chefs');
const statServed = document.getElementById('stat-served');

/* ---- 首次引导浮层：localStorage 记忆，顶栏 ? 按钮可重开 ---- */
const GUIDE_KEY = 'co-guide-seen';
const guideOverlay = document.getElementById('guide-overlay');
function openGuide() { guideOverlay.hidden = false; }
function closeGuide() {
  guideOverlay.hidden = true;
  try { localStorage.setItem(GUIDE_KEY, '1'); } catch (_) {}
}
document.getElementById('guide-start').addEventListener('click', closeGuide);
document.getElementById('btn-help').addEventListener('click', openGuide);
let guideSeen = false;
try { guideSeen = !!localStorage.getItem(GUIDE_KEY); } catch (_) {}
if (!guideSeen && !wantSelftest) openGuide(); // 自测模式不弹，避免干扰断言

/* ---- 音效开关：window.COSound 不存在时隐藏按钮；所有调用防御式 ---- */
const btnSound = document.getElementById('btn-sound');
let soundMuted = false;
function syncSoundBtn() {
  if (window.COSound && typeof window.COSound.setMuted === 'function') {
    btnSound.hidden = false;
    btnSound.textContent = soundMuted ? '🔇' : '🔊';
    btnSound.title = soundMuted ? '打开音效' : '静音';
  } else {
    btnSound.hidden = true;
  }
}
btnSound.addEventListener('click', () => {
  soundMuted = !soundMuted;
  try { window.COSound?.setMuted?.(soundMuted); } catch (_) {}
  syncSoundBtn();
});
syncSoundBtn();
setTimeout(syncSoundBtn, 2000); // 音效模块可能异步注入，迟些再探一次
function playSound(kind) {
  try { window.COSound?.play?.(kind); } catch (_) {}
}
/* action.kind → 音效 kind（serve/burn/join/chop/sizzle/phone） */
const SOUND_KIND = { serve: 'serve', burn: 'burn', join: 'join', edit: 'chop', exec: 'sizzle', search: 'phone' };

/* ---- 渲染器：优先 3D（web/js3d/kitchen3d.js），加载失败回退到占位 stub ----
   契约方法：setKitchen(kitchen, chefs) / addChef(chef) / chefAction(chefId, action)
             / chefStatus(chefId, status) / dishServed(dish) / setActive(active) / resize() / dispose() */
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
const dataSource = useMock ? COMock : CONet;
const loadingKitchens = new Set(); // 正在按需加载的厨房 id（防重复拉取）

/* 占位厨房按需加载：拉完整历史 → 合并进 store → 若仍是当前厨房则重建渲染器。
   已加载的厨房 lazy=false 不会触发；同一厨房并发点击只拉一次（服务端同样幂等）。 */
function loadKitchenHistory(id) {
  if (loadingKitchens.has(id)) return;
  if (!dataSource || typeof dataSource.loadKitchen !== 'function') return;
  loadingKitchens.add(id);
  dataSource.loadKitchen(id).then((kitchen) => {
    if (!kitchen) return;
    COStore.applyEvent(state, { type: 'kitchen_updated', kitchen: kitchen });
    ui.sync(state.kitchens);
    const cur = ui.currentKitchen();
    if (cur && cur.id === id) renderer.setKitchen(cur, cur.chefs || []);
    stageEmptyEl.style.display = cur ? 'none' : '';
    renderStats();
    renderFeed();
  }).catch(() => {}).finally(() => loadingKitchens.delete(id));
}

const ui = COKitchensUI.create({
  barEl: document.getElementById('sw-cards'),
  tabsEl: document.getElementById('sw-tabs'),
  prevEl: document.getElementById('sw-prev'),
  nextEl: document.getElementById('sw-next'),
  onSwitch(kitchen) {
    // 切换厨房：渲染器清场重建，厨师从门口入场（占位厨房无厨师也能渲染空厨房）
    renderer.setKitchen(kitchen, kitchen.chefs || []);
    renderFeed(); // 「当前厨房」过滤跟随切换
    if (kitchen.lazy) loadKitchenHistory(kitchen.id); // 占位厨房：点击后按需拉取完整历史
  }
});

/* ---- 顶部统计 ---- */
function renderStats() {
  statKitchens.textContent = state.stats.kitchens;
  statActive.textContent = state.stats.activeKitchens;
  statChefs.textContent = state.stats.chefs;
  statServed.textContent = state.stats.served;
  // 「已出餐」悬停明细：各厨房出餐数
  const servedBox = statServed.closest('.stat');
  if (servedBox) {
    const per = state.kitchens.filter((k) => (k.servedCount || 0) > 0);
    servedBox.title = per.length
      ? '各厨房出餐：\n' + per.map((k) => k.name + ' × ' + k.servedCount).join('\n')
      : '还没有出餐，等厨师们端出第一道菜～';
  }
}

/* ---- 订单流水（Overcooked 票卡，最近 30 条，可过滤当前厨房/全部） ---- */
let feedMode = 'current';
const ffCurrent = document.getElementById('ff-current');
const ffAll = document.getElementById('ff-all');
if (params.has('feed-all')) { // 调试/截图用：?feed-all=1 直接进入「全部」模式
  feedMode = 'all';
  ffAll.classList.add('on');
  ffCurrent.classList.remove('on');
}
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

/* ---- 订单流水：事件类型过滤 chips（全部/出餐/糊了/喊话/工具） ---- */
let feedKind = 'all';
const KIND_GROUPS = {
  serve: ['serve'],
  burn: ['burn'],
  speak: ['speak', 'talk'],
  tools: ['read', 'edit', 'exec', 'search', 'tool', 'think', 'join']
};
document.querySelectorAll('#feed-kinds button').forEach((btn) => {
  btn.addEventListener('click', () => {
    feedKind = btn.dataset.kind || 'all';
    document.querySelectorAll('#feed-kinds button').forEach((b) =>
      b.classList.toggle('on', b === btn));
    renderFeed();
  });
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

/* 相对时间：刚刚 / 12s 前 / 3m 前 / 2h 前 */
function fmtRel(ts) {
  const diff = Date.now() - (ts || 0);
  if (diff < 5000) return '刚刚';
  if (diff < 60000) return Math.floor(diff / 1000) + 's 前';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm 前';
  return Math.floor(diff / 3600000) + 'h 前';
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const LONG_DETAIL = 42;   // detail 超过此长度可点击展开
const seenTickets = new WeakSet(); // 已渲染过的流水条目（仅新条目播入场动画）

function renderFeed() {
  feedEl.textContent = '';
  const curId = ui.currentId();
  let shown = 0;
  state.feed.forEach((entry) => {
    if (feedMode === 'current' && entry.kitchenId !== curId) return;
    if (feedKind !== 'all' && !(KIND_GROUPS[feedKind] || []).includes(entry.kind)) return;
    shown++;
    const isNew = !seenTickets.has(entry);
    seenTickets.add(entry);
    const long = entry.detail && entry.detail.length > LONG_DETAIL;
    const li = el('li', 'ticket kind-' + entry.kind + (isNew ? '' : ' seen') + (long ? ' has-long' : ''));

    const tbar = el('div', 'tbar');
    tbar.style.background = KIND_COLOR[entry.kind] || '#928688';
    li.appendChild(tbar);

    const head = el('div', 't-head');
    // 「全部」模式：票卡左侧（标题行最左）加厨房名小标签；当前厨房模式不加
    if (feedMode === 'all' && entry.kitchenName) {
      head.appendChild(el('span', 't-kitchen', entry.kitchenName));
    }
    head.appendChild(el('span', 't-icon', KIND_ICON[entry.kind] || '•'));
    head.appendChild(el('span', 't-label', entry.label || entry.kind));
    const tTime = el('span', 't-time', fmtRel(entry.ts));
    tTime.dataset.ts = entry.ts || 0;
    tTime.title = fmtTime(entry.ts); // 悬停看绝对时间
    head.appendChild(tTime);
    li.appendChild(head);

    const body = el('div', 't-body');
    const chef = el('span', 't-chef', entry.chefName || '?');
    chef.style.background = entry.color || '#FEC457';
    body.appendChild(chef);
    if (entry.detail) {
      const detail = el('span', 't-detail', entry.detail);
      if (long) {
        detail.title = '点击展开 / 收起';
        detail.addEventListener('click', () => li.classList.toggle('open'));
      }
      body.appendChild(detail);
    }
    li.appendChild(body);

    feedEl.appendChild(li);
  });
  if (!shown) {
    feedEl.appendChild(el('li', 'feed-empty',
      feedKind !== 'all' ? '这类事件还没有记录～' :
      feedMode === 'current' ? '当前厨房还没有新订单～' : '还没有订单，等厨师们开工～'));
  }
}

/* 相对时间每 5s 刷新一次，无需重建票卡 */
setInterval(() => {
  feedEl.querySelectorAll('.t-time').forEach((t) => {
    t.textContent = fmtRel(Number(t.dataset.ts) || 0);
  });
}, 5000);

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
let wasConnBad = false; // 上一次连接状态是否断线（用于重连成功 toast）
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

    // 非当前厨房的事件：只累计切换条红点（卡片级 + 项目标签级聚合），不自动跳转
    const kid = ev.kitchenId || (ev.kitchen && ev.kitchen.id);
    if (kid && kid !== ui.currentId()) ui.noteEvent(kid);

    // 当前厨房的事件：转发给渲染器（并触发对应音效）
    const curId = ui.currentId();
    effects.forEach((ef) => {
      if (ef.type === 'snapshot' || ef.kitchenId !== curId) return;
      switch (ef.type) {
        case 'chef_added':
          renderer.addChef(ef.chef);
          playSound('join');
          break;
        case 'chef_action':
          // 传完整 chef：已下班退场（从场景移除）的厨师来新事件时可重新从门口入职
          renderer.chefAction(ef.chef.id, ef.action, ef.chef);
          if (SOUND_KIND[ef.action && ef.action.kind]) playSound(SOUND_KIND[ef.action.kind]);
          if (ef.action && ef.action.kind === 'burn' && window.COToast) {
            window.COToast('💥 糊了' + (ef.chef && ef.chef.name ? ' · ' + ef.chef.name : ''), 'burn');
          }
          break;
        case 'chef_status':
          renderer.chefStatus(ef.chefId, ef.status);
          break;
        case 'kitchen_updated': {
          // 厨房改名/状态更新：重绘墙上名牌（不重建场景）；歇业状态实时同步（幂等）。
          // 厨师阵容变化（占位厨房按需加载完成、SSE 广播补历史）则重建场景。
          const cur = ui.currentKitchen();
          if (cur && ef.chefsChanged) renderer.setKitchen(cur, cur.chefs || []);
          else if (cur && renderer.setKitchenName) renderer.setKitchenName(cur.name);
          if (cur && renderer.setActive) renderer.setActive(cur.active);
          break;
        }
        case 'dish_served':
          renderer.dishServed(ef.dish);
          playSound('serve');
          if (window.COToast) window.COToast('✅ 出餐 +1' + (ef.dish && ef.dish.name ? ' · ' + ef.dish.name : ''), 'serve');
          break;
      }
    });

    // 歇业状态可能随事件翻转（歇业厨房来新动作 → store 乐观置活；kitchen_updated 恢复）
    // 实时同步给渲染器：幂等且只调灯光/门牌显隐，不重建场景、不重绘纹理
    const curNow = ui.currentKitchen();
    if (curNow && renderer.setActive) renderer.setActive(curNow.active);

    ui.sync(state.kitchens); // lastTs/厨师数/出餐数可能已变化，刷新切换条排序
    stageEmptyEl.style.display = ui.currentKitchen() ? 'none' : '';
    renderStats();
    renderFeed();
  },

  onStatus(text, cls) {
    connEl.textContent = text;
    connEl.className = 'conn' + (cls ? ' ' + cls : '');
    // 断线时舞台顶部同时挂出明显横幅（重连成功自动消失）
    connBanner.hidden = cls !== 'bad';
    // 断线重连成功：弹一条轻提示
    if (wasConnBad && cls !== 'bad' && window.COToast) window.COToast('📡 已连接，厨房开张！', 'info');
    wasConnBad = cls === 'bad';
  }
};

if (useMock) COMock.connect(handlers);
else CONet.connect(handlers);

/* ---- 键盘切换：←/→ 前后间、数字键 1-9 直达（均按全局展示顺序，可跨项目）；Esc 关引导，? 开引导 ---- */
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !guideOverlay.hidden) { closeGuide(); e.preventDefault(); return; }
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.key === 'ArrowLeft') { ui.prev(); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { ui.next(); e.preventDefault(); }
  else if (/^[1-9]$/.test(e.key)) ui.jump(Number(e.key));
  else if (e.key === '?') openGuide();
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
