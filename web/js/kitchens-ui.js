/* 厨房切换系统：有序切换条（lastTs 倒序）、未读红点、◀/▶ 按钮、跟随最新开关。
   纯 DOM + 状态，不接触渲染器；通过 onSwitch 回调通知外部「当前厨房变了」。
   跟随最新：默认开；别家厨房来新事件时自动跳过去；手动切换后暂停 30 秒再恢复。 */
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

    function move(d) {
      if (!kitchens.length) return;
      var i = 0;
      kitchens.forEach(function (k, idx) { if (k.id === currentId) i = idx; });
      var j = (i + d + kitchens.length) % kitchens.length;
      switchTo(kitchens[j].id, 'manual');
    }
    function prev() { move(-1); }
    function next() { move(1); }
    function jump(n) { // 1 起始：数字键 1-9 直达
      if (n >= 1 && n <= kitchens.length) switchTo(kitchens[n - 1].id, 'manual');
    }

    function el(tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    function render() {
      barEl.textContent = '';
      kitchens.forEach(function (k, i) {
        var card = el('button', 'sw-card' + (k.id === currentId ? ' on' : '') + (k.active ? '' : ' closed'));
        card.type = 'button';
        card.title = (k.cwd || k.name) + (k.active ? '' : '（歇业中）') + '\n点击切换到这间厨房（数字键 ' + (i + 1) + '）';
        card.appendChild(el('span', 'seq', String(i + 1)));
        card.appendChild(el('span', 'lamp' + (k.active ? ' on' : '')));
        card.appendChild(el('span', 'kname', k.name));
        if (!k.active) card.appendChild(el('span', 'closed-tag', '歇业中'));
        card.appendChild(el('span', 'kmeta',
          '👨‍🍳' + (k.chefs ? k.chefs.length : 0) + ' 🍽' + (k.servedCount || 0)));
        var n = unread[k.id] || 0;
        if (n > 0) card.appendChild(el('span', 'badge', n > 99 ? '99+' : String(n)));
        card.addEventListener('click', function () { switchTo(k.id, 'manual'); });
        barEl.appendChild(card);
      });
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
