/* 厨房切换系统：「项目标签 → 会话卡片」两级切换条。
   项目 = Codex 里的工作目录（cwd），项目下每间厨房 = 该项目的一个会话（thread）。
   第一级是一排项目标签（木牌 tab）：同 cwd 的厨房归为一个项目；项目按组内最近
   活跃（max lastTs）倒序；项目名取 cwd 目录名（Kitchen.project），同名项目
   （不同路径）追加 #短id 消歧（与厨房重名消歧同风格）。只有一个项目时标签排
   整排隐藏，保持清爽不臃肿。
   点击项目标签 → 聚焦该项目并切到组内最近活跃的厨房（已聚焦时再点在组内循环）；
   第二级卡片条只展示当前项目的会话厨房（lastTs 倒序），横向滚动、当前卡片
   始终滚入可视区——一个项目会话再多也不挤爆切换条。
   键盘 ←/→ 与数字键 1-9 按「全局展示顺序」（项目组展开后的 kitchenId 列表）
   切换，可跨项目，项目标签自动跟随当前厨房高亮。
   未读红点：卡片级 + 项目标签级聚合；歇业置灰：卡片置灰，组内全部歇业时
   项目标签也置灰。切换完全由用户手动控制，没有自动跟随。
   纯 DOM + 状态，不接触渲染器；通过 onSwitch 回调通知外部「当前厨房变了」。 */
(function (global) {
  'use strict';

  function create(opts) {
    var barEl = opts.barEl;
    var tabsEl = opts.tabsEl || null;
    var prevEl = opts.prevEl || null;
    var nextEl = opts.nextEl || null;
    var onSwitch = typeof opts.onSwitch === 'function' ? opts.onSwitch : function () {};

    var kitchens = [];      // 始终按 lastTs 倒序
    var displayOrder = [];  // 全局展示顺序（项目组展开后的 kitchenId 列表），←→/数字键按此走
    var currentId = null;
    var unread = {};        // kitchenId -> 未读事件数

    function findK(id) {
      for (var i = 0; i < kitchens.length; i++) if (kitchens[i].id === id) return kitchens[i];
      return null;
    }

    /* reason: 'init'（首次/纠偏）| 'manual'（用户点击/按键）——切换完全手动 */
    function switchTo(id, reason) {
      var k = findK(id);
      if (!k) return false;
      var changed = id !== currentId;
      currentId = id;
      unread[id] = 0;
      render();
      if (changed) onSwitch(k, reason);
      return true;
    }

    /* 外部状态（store.kitchens）有更新后调用：重排序 + 刷新标签/卡片 */
    function sync(list) {
      kitchens = (list || []).slice().sort(function (a, b) {
        var bt = b.lastTs || 0, at = a.lastTs || 0;
        if (bt !== at) return bt - at;
        return String(a.id).localeCompare(String(b.id));
      });
      var alive = {};
      kitchens.forEach(function (k) { alive[k.id] = true; });
      Object.keys(unread).forEach(function (id) { if (!alive[id]) delete unread[id]; });
      if (!kitchens.length) { currentId = null; render(); return; }
      if (!currentId || !alive[currentId]) { switchTo(kitchens[0].id, 'init'); return; }
      render();
    }

    /* 非当前厨房来了一条事件：只累计红点（卡片级 + 项目标签级聚合），绝不自动跳 */
    function noteEvent(kitchenId) {
      if (!kitchenId || kitchenId === currentId) return false;
      if (!findK(kitchenId)) return false;
      unread[kitchenId] = (unread[kitchenId] || 0) + 1;
      render();
      return false;
    }

    /* 项目组：同 cwd 归一组（无 cwd 的防御性厨房各自成组）。
       返回按「组内最近活跃」倒序的组列表，组内厨房按 lastTs 倒序。
       项目名 = Kitchen.project（cwd 目录名），兜底厨房名；同名项目（不同 cwd）
       追加 #短id 消歧，短id 取组内最小厨房 id（与排序无关，稳定）。 */
    function groupKey(k) { return k.cwd ? 'cwd:' + k.cwd : 'id:' + k.id; }

    function groupList() {
      var map = {};
      var groups = [];
      kitchens.forEach(function (k) {
        var key = groupKey(k);
        var g = map[key];
        if (!g) {
          g = map[key] = { key: key, cwd: k.cwd || '', name: '', minId: k.id, kitchens: [], lastTs: 0 };
          groups.push(g);
        }
        if (!g.name) g.name = k.project || k.name;
        if (String(k.id) < String(g.minId)) g.minId = k.id;
        g.kitchens.push(k);
        if ((k.lastTs || 0) > g.lastTs) g.lastTs = k.lastTs || 0;
      });
      var nameCount = {};
      groups.forEach(function (g) { nameCount[g.name] = (nameCount[g.name] || 0) + 1; });
      groups.forEach(function (g) {
        if (nameCount[g.name] > 1) {
          g.name = g.name + ' #' + String(g.minId).replace(/^[a-z]+:/i, '').slice(-4);
        }
        g.kitchens.sort(function (a, b) {
          var bt = b.lastTs || 0, at = a.lastTs || 0;
          if (bt !== at) return bt - at;
          return String(a.id).localeCompare(String(b.id));
        });
      });
      groups.sort(function (a, b) {
        if (b.lastTs !== a.lastTs) return b.lastTs - a.lastTs;
        return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
      });
      return groups;
    }

    function move(d) {
      var n = displayOrder.length;
      if (!n) return;
      var i = displayOrder.indexOf(currentId);
      if (i < 0) i = 0;
      var j = (i + d + n) % n;
      switchTo(displayOrder[j], 'manual');
    }
    function prev() { move(-1); }
    function next() { move(1); }
    function jump(n) { // 1 起始：数字键 1-9 直达（按全局展示顺序）
      if (n >= 1 && n <= displayOrder.length) switchTo(displayOrder[n - 1], 'manual');
    }

    function el(tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    /* 项目标签（木牌 tab）：📁 项目名 + N 会话 + 聚合红点；组内全歇业则置灰 */
    function renderTab(g, on) {
      var allClosed = true;
      g.kitchens.forEach(function (k) { if (k.active) allClosed = false; });
      var tab = el('button', 'sw-tab' + (on ? ' on' : '') + (allClosed ? ' closed' : ''));
      tab.type = 'button';
      tab.title = '项目目录：' + (g.cwd || g.name) +
        '\n该项目下有 ' + g.kitchens.length + ' 个会话厨房' +
        '\n点击切换到该项目最近活跃的厨房' +
        (g.kitchens.length > 1 ? '；已聚焦时再点可在项目内循环切换' : '');
      tab.appendChild(el('span', 'sw-tab-icon', '📁'));
      tab.appendChild(el('span', 'sw-tab-name', g.name));
      tab.appendChild(el('span', 'sw-tab-count', g.kitchens.length + ' 会话'));
      var sum = 0;
      g.kitchens.forEach(function (k) { sum += unread[k.id] || 0; });
      if (sum > 0) tab.appendChild(el('span', 'badge', sum > 99 ? '99+' : String(sum)));
      tab.addEventListener('click', function () {
        if (!on) { switchTo(g.kitchens[0].id, 'manual'); return; }
        // 已聚焦的项目：再点一次在组内循环到下一个会话
        var idx = 0;
        for (var i = 0; i < g.kitchens.length; i++) {
          if (g.kitchens[i].id === currentId) { idx = i; break; }
        }
        switchTo(g.kitchens[(idx + 1) % g.kitchens.length].id, 'manual');
      });
      return tab;
    }

    function renderCard(k, seq) {
      var card = el('button', 'sw-card' + (k.id === currentId ? ' on' : '') + (k.active ? '' : ' closed') + (k.lazy ? ' lazy' : ''));
      card.type = 'button';
      card.title = (k.cwd || k.name) +
        (k.lazy ? '（历史未加载，点击切换后自动加载）' : (k.active ? '' : '（歇业中）')) +
        '\n点击切换到这间厨房（数字键 ' + seq + '）';
      card.appendChild(el('span', 'seq', String(seq)));
      card.appendChild(el('span', 'lamp' + (k.active ? ' on' : '')));
      card.appendChild(el('span', 'kname', k.name));
      if (k.lazy) card.appendChild(el('span', 'lazy-tag', (k.chefs && k.chefs.length) ? '历史未加载' : '未加载'));
      else if (!k.active) card.appendChild(el('span', 'closed-tag', '歇业中'));
      var meta = el('span', 'kmeta');
      meta.appendChild(el('span', 'km km-chefs', '👨‍🍳 ' + (k.chefs ? k.chefs.length : 0)));
      meta.appendChild(el('span', 'km km-served', '🍽 ' + (k.servedCount || 0)));
      card.appendChild(meta);
      var n = unread[k.id] || 0;
      if (n > 0) card.appendChild(el('span', 'badge', n > 99 ? '99+' : String(n)));
      card.addEventListener('click', function () { switchTo(k.id, 'manual'); });
      return card;
    }

    function render() {
      barEl.textContent = '';
      if (tabsEl) tabsEl.textContent = '';
      var groups = groupList();
      var order = [];
      groups.forEach(function (g) {
        g.kitchens.forEach(function (k) { order.push(k.id); });
      });
      displayOrder = order;
      var seqOf = {};
      order.forEach(function (id, i) { seqOf[id] = i + 1; });
      var cur = findK(currentId);
      var curKey = cur ? groupKey(cur) : null;
      var multiProject = groups.length > 1;
      var curTabEl = null;
      var curCardEl = null;
      groups.forEach(function (g) {
        var on = g.key === curKey;
        if (tabsEl && multiProject) {
          var tab = renderTab(g, on);
          if (on) curTabEl = tab;
          tabsEl.appendChild(tab);
        }
        // 卡片条只铺当前项目的会话厨房（多会话时横向滚动，不挤爆切换条）
        if (on) {
          g.kitchens.forEach(function (k) {
            var card = renderCard(k, seqOf[k.id]);
            if (k.id === currentId) curCardEl = card;
            barEl.appendChild(card);
          });
        }
      });
      if (tabsEl) tabsEl.hidden = !multiProject; // 只有一个项目：标签排整排隐藏
      // 一间厨房都没有：前后箭头一并隐藏（空态更干净）
      if (prevEl) prevEl.hidden = !order.length;
      if (nextEl) nextEl.hidden = !order.length;
      // 当前会话卡片 / 当前项目标签始终保持在可视区内
      if (curCardEl && curCardEl.scrollIntoView) {
        curCardEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      if (curTabEl && curTabEl.scrollIntoView) {
        curTabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }

    if (prevEl) prevEl.addEventListener('click', prev);
    if (nextEl) nextEl.addEventListener('click', next);

    render();

    return {
      sync: sync,
      noteEvent: noteEvent,
      prev: prev,
      next: next,
      jump: jump,
      currentId: function () { return currentId; },
      currentKitchen: function () { return findK(currentId); },
      count: function () { return kitchens.length; },
      order: function () { return displayOrder.slice(); } // 全局展示顺序（自测/调试）
    };
  }

  global.COKitchensUI = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
