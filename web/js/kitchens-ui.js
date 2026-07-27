/* 厨房切换系统：按「项目 → 会话」两级分组的有序切换条。
   项目 = Codex 里的工作目录（cwd），项目下每间厨房 = 该项目的一个会话（thread）。
   分组规则：同 cwd 的厨房归为一个项目组；项目组按组内最近活跃（max lastTs）倒序，
   组内厨房按 lastTs 倒序；项目名取 cwd 目录名（Kitchen.project），同名项目
   （不同路径）追加 #短id 消歧（与厨房重名消歧同风格）。
   单会话项目组不渲染组标题，外观与旧版扁平卡片一致（只有一个项目 / 每个项目
   只有一个会话时保持清爽不臃肿）。
   交互保持：点击切换、←/→ 与数字键 1-9（按展示顺序）、跟随最新（默认开，
   别家厨房来新事件自动跳过去；手动切换后暂停 30 秒）、未读红点（卡片级，
   多会话项目组标题上再聚合一枚）、歇业置灰（组内全部歇业时组标题也置灰）。
   纯 DOM + 状态，不接触渲染器；通过 onSwitch 回调通知外部「当前厨房变了」。 */
(function (global) {
  'use strict';

  var FOLLOW_PAUSE_MS = 30000; // 手动切换后暂停跟随的时长

  function create(opts) {
    var barEl = opts.barEl;
    var prevEl = opts.prevEl || null;
    var nextEl = opts.nextEl || null;
    var followEl = opts.followEl || null;
    var followTextEl = opts.followTextEl || null;
    var onSwitch = typeof opts.onSwitch === 'function' ? opts.onSwitch : function () {};

    var kitchens = [];      // 始终按 lastTs 倒序
    var displayOrder = [];  // 展示顺序（项目组展开后的 kitchenId 列表），←→/数字键按此走
    var currentId = null;
    var unread = {};        // kitchenId -> 未读事件数
    var followOn = followEl ? !!followEl.checked : true;
    var pauseUntil = 0;

    function findK(id) {
      for (var i = 0; i < kitchens.length; i++) if (kitchens[i].id === id) return kitchens[i];
      return null;
    }

    function followPaused() { return Date.now() < pauseUntil; }

    /* reason: 'init'（首次/纠偏）| 'manual'（用户点击/按键）| 'auto'（跟随最新） */
    function switchTo(id, reason) {
      var k = findK(id);
      if (!k) return false;
      var changed = id !== currentId;
      currentId = id;
      unread[id] = 0;
      if (reason === 'manual') pauseUntil = Date.now() + FOLLOW_PAUSE_MS;
      render();
      if (changed) onSwitch(k, reason);
      return true;
    }

    /* 外部状态（store.kitchens）有更新后调用：重排序 + 刷新卡片 */
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

    /* 非当前厨房来了一条事件：累计红点；跟随开启且未暂停时自动跳过去 */
    function noteEvent(kitchenId) {
      if (!kitchenId || kitchenId === currentId) return false;
      if (!findK(kitchenId)) return false;
      unread[kitchenId] = (unread[kitchenId] || 0) + 1;
      if (followOn && !followPaused()) return switchTo(kitchenId, 'auto');
      render();
      return false;
    }

    /* 项目组：同 cwd 归一组（无 cwd 的防御性厨房各自成组）。
       返回按「组内最近活跃」倒序的组列表，组内厨房按 lastTs 倒序。
       项目名 = Kitchen.project（cwd 目录名），兜底厨房名；同名项目（不同 cwd）
       追加 #短id 消歧，短id 取组内最小厨房 id（与排序无关，稳定）。 */
    function groupList() {
      var map = {};
      var groups = [];
      kitchens.forEach(function (k) {
        var key = k.cwd ? 'cwd:' + k.cwd : 'id:' + k.id;
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
    function jump(n) { // 1 起始：数字键 1-9 直达（按展示顺序）
      if (n >= 1 && n <= displayOrder.length) switchTo(displayOrder[n - 1], 'manual');
    }

    function el(tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    function renderCard(k, seq) {
      var card = el('button', 'sw-card' + (k.id === currentId ? ' on' : '') + (k.active ? '' : ' closed'));
      card.type = 'button';
      card.title = (k.cwd || k.name) + (k.active ? '' : '（歇业中）') + '\n点击切换到这间厨房（数字键 ' + seq + '）';
      card.appendChild(el('span', 'seq', String(seq)));
      card.appendChild(el('span', 'lamp' + (k.active ? ' on' : '')));
      card.appendChild(el('span', 'kname', k.name));
      if (!k.active) card.appendChild(el('span', 'closed-tag', '歇业中'));
      card.appendChild(el('span', 'kmeta',
        '👨‍🍳' + (k.chefs ? k.chefs.length : 0) + ' 🍽' + (k.servedCount || 0)));
      var n = unread[k.id] || 0;
      if (n > 0) card.appendChild(el('span', 'badge', n > 99 ? '99+' : String(n)));
      card.addEventListener('click', function () { switchTo(k.id, 'manual'); });
      return card;
    }

    function render() {
      barEl.textContent = '';
      var groups = groupList();
      var order = [];
      groups.forEach(function (g) {
        var multi = g.kitchens.length > 1;
        var allClosed = true;
        g.kitchens.forEach(function (k) { if (k.active) allClosed = false; });
        var gEl = el('div', 'sw-group' + (multi ? '' : ' solo') + (allClosed ? ' closed' : ''));
        if (multi) {
          // 项目组标题：目录名 + 会话数；红点聚合组内各卡片的未读数
          var head = el('div', 'sw-group-head');
          head.title = '项目目录：' + (g.cwd || g.name) +
            '\n该项目下有 ' + g.kitchens.length + ' 个会话厨房';
          head.appendChild(el('span', 'sw-group-icon', '📁'));
          head.appendChild(el('span', 'sw-group-name', g.name));
          head.appendChild(el('span', 'sw-group-count', g.kitchens.length + ' 会话'));
          var sum = 0;
          g.kitchens.forEach(function (k) { sum += unread[k.id] || 0; });
          if (sum > 0) head.appendChild(el('span', 'badge', sum > 99 ? '99+' : String(sum)));
          gEl.appendChild(head);
        }
        var cardsEl = el('div', 'sw-group-cards');
        g.kitchens.forEach(function (k) {
          order.push(k.id);
          cardsEl.appendChild(renderCard(k, order.length));
        });
        gEl.appendChild(cardsEl);
        barEl.appendChild(gEl);
      });
      displayOrder = order;
      updateFollowText();
    }

    function updateFollowText() {
      if (!followTextEl) return;
      if (!followOn) { followTextEl.textContent = '跟随最新'; return; }
      if (followPaused()) {
        followTextEl.textContent = '跟随最新（手动暂停 ' +
          Math.max(1, Math.ceil((pauseUntil - Date.now()) / 1000)) + 's）';
      } else {
        followTextEl.textContent = '跟随最新';
      }
    }

    if (prevEl) prevEl.addEventListener('click', prev);
    if (nextEl) nextEl.addEventListener('click', next);
    if (followEl) {
      followEl.addEventListener('change', function () {
        followOn = !!followEl.checked;
        if (followOn) {
          pauseUntil = 0;
          // 重新开启时立即跟到最近活跃的厨房
          if (kitchens.length && kitchens[0].id !== currentId) switchTo(kitchens[0].id, 'auto');
        }
        render();
      });
    }

    // 暂停倒计时文案刷新
    setInterval(updateFollowText, 1000);

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
      isFollowing: function () { return followOn && !followPaused(); }
    };
  }

  global.COKitchensUI = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
