/* 真实后端连接：GET /api/snapshot + EventSource('/api/events')，断线自动重连并重拉快照 */
(function (global) {
  'use strict';

  function connect(handlers) {
    var es = null;
    var closed = false;

    function setStatus(text, cls) {
      if (handlers.onStatus) handlers.onStatus(text, cls);
    }

    function fetchSnapshot() {
      return fetch('/api/snapshot')
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (d) {
          handlers.onSnapshot(d.kitchens || []);
        });
    }

    function open() {
      if (closed) return;
      setStatus('连接中…', '');
      es = new EventSource('/api/events');

      es.onopen = function () {
        setStatus('已连接', 'ok');
        // （重）连上后重拉快照，补齐断线期间的状态
        fetchSnapshot().catch(function () {});
      };
      es.onmessage = function (e) {
        var msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        if (msg.type === 'snapshot') handlers.onSnapshot(msg.kitchens || []);
        else handlers.onEvent(msg);
      };
      es.onerror = function () {
        // EventSource 会自动重连；这里只更新指示灯
        setStatus('连接断开，自动重连中…', 'bad');
      };
    }

    // 首屏快照（失败也继续，等 SSE 连上后会补拉）
    fetchSnapshot().catch(function () {
      setStatus('快照获取失败，等待事件流…', 'bad');
    });
    open();

    return {
      close: function () {
        closed = true;
        if (es) es.close();
      }
    };
  }

  global.CONet = { connect: connect };
})(typeof window !== 'undefined' ? window : globalThis);
