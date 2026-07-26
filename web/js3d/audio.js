// Order Up! 音效系统：纯 WebAudio 振荡器/噪声合成，零音频资源
// 暴露 window.COSound = { play(kind), setMuted(bool), muted }
//   kind: 'chop' 切菜哒哒 | 'sizzle' 炒菜嘶嘶 | 'ding' 出餐叮叮 | 'burn' 糊了闷响 | 'horn' 新厨师入职号角
// 自动播放策略：AudioContext 在首次用户手势（pointerdown/keydown/touchstart）前不发声；
//   手势前调用 play() 直接静默返回，不报错、不排队。
// 用法：<script src="js3d/audio.js"></script> 普通脚本引入即可（无依赖，也可 import 无副作用）。
(function () {
  'use strict';

  var S = {
    ctx: null,
    master: null,
    noiseBuf: null,
    muted: false,
    _last: {}, // 每种音效上次触发时间（节流）
  };

  // 同类音效最小间隔（秒）：防止密集事件把音效打成一坨
  var MIN_GAP = { chop: 0.18, sizzle: 0.7, ding: 0.25, burn: 0.4, horn: 0.5, ring: 1.2, serve: 0.25, join: 0.5, phone: 1.2 };

  function ensureCtx() {
    if (S.ctx) return S.ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      S.ctx = new AC();
    } catch (e) {
      return null;
    }
    S.master = S.ctx.createGain();
    S.master.gain.value = 0.35;
    S.master.connect(S.ctx.destination);
    // 1 秒白噪声缓冲（循环复用，各类噪声音效的声源）
    var len = S.ctx.sampleRate | 0;
    var buf = S.ctx.createBuffer(1, len, S.ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    S.noiseBuf = buf;
    return S.ctx;
  }

  // 首次用户手势解锁（自动播放策略）；反复注册直到 context 进入 running
  function unlock() {
    var ctx = ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, unlock, { passive: true });
  });

  function env(g, t0, attack, peak, dur) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + dur);
  }

  // 振荡器音：type/f0→f1 滑音 + 可选带通
  function tone(o) {
    var ctx = S.ctx;
    var t0 = o.t0, dur = o.dur;
    var osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, t0);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t0 + dur);
    var g = ctx.createGain();
    env(g, t0, o.attack || 0.005, o.peak || 0.2, dur);
    var node = osc;
    if (o.filterF) {
      var fl = ctx.createBiquadFilter();
      fl.type = 'bandpass';
      fl.frequency.value = o.filterF;
      fl.Q.value = o.filterQ || 1;
      osc.connect(fl);
      node = fl;
    }
    node.connect(g);
    g.connect(S.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // 噪声音：白噪声 + 滤波（bandpass/highpass/lowpass）+ 可选频率扫掠
  function noise(o) {
    var ctx = S.ctx;
    var t0 = o.t0, dur = o.dur;
    var src = ctx.createBufferSource();
    src.buffer = S.noiseBuf;
    src.loop = true;
    var fl = ctx.createBiquadFilter();
    fl.type = o.type || 'bandpass';
    fl.frequency.setValueAtTime(o.f0 || 2000, t0);
    if (o.f1) fl.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + dur);
    fl.Q.value = o.q != null ? o.q : 0.8;
    var g = ctx.createGain();
    env(g, t0, o.attack || 0.003, o.peak || 0.2, dur);
    src.connect(fl);
    fl.connect(g);
    g.connect(S.master);
    src.start(t0, Math.random());
    src.stop(t0 + dur + 0.05);
  }

  var RECIPES = {
    // 切菜：两声干脆的哒哒
    chop: function (t0) {
      noise({ t0: t0, dur: 0.045, peak: 0.35, f0: 2600, q: 1.2 });
      noise({ t0: t0 + 0.07, dur: 0.04, peak: 0.3, f0: 2200, q: 1.2 });
      tone({ t0: t0, type: 'triangle', f0: 900, f1: 500, dur: 0.05, peak: 0.15 });
    },
    // 炒菜：高频嘶嘶 + 一层中频油花
    sizzle: function (t0) {
      noise({ t0: t0, dur: 0.6, peak: 0.12, type: 'highpass', f0: 5000, attack: 0.08 });
      noise({ t0: t0, dur: 0.3, peak: 0.06, f0: 3000, q: 0.6, attack: 0.05 });
    },
    // 出餐：铃铛双音 + 回声泛音
    ding: function (t0) {
      tone({ t0: t0, type: 'sine', f0: 1318, dur: 0.5, peak: 0.22, attack: 0.004 });
      tone({ t0: t0, type: 'sine', f0: 1976, dur: 0.35, peak: 0.12, attack: 0.004 });
      tone({ t0: t0 + 0.13, type: 'sine', f0: 1568, dur: 0.45, peak: 0.18, attack: 0.004 });
    },
    // 糊了：低频闷响 + 一团低频噪声
    burn: function (t0) {
      tone({ t0: t0, type: 'sine', f0: 160, f1: 55, dur: 0.35, peak: 0.4, attack: 0.005 });
      noise({ t0: t0, dur: 0.3, peak: 0.22, type: 'lowpass', f0: 700, q: 0.5 });
    },
    // 新厨师入职：上行三音号角（sol-do-mi-sol）
    horn: function (t0) {
      var seq = [[392, 0, 0.14], [523, 0.12, 0.14], [659, 0.24, 0.5]];
      for (var i = 0; i < seq.length; i++) {
        tone({ t0: t0 + seq[i][1], type: 'square', f0: seq[i][0], dur: seq[i][2], peak: 0.1, attack: 0.01, filterF: 1800 });
      }
      tone({ t0: t0 + 0.24, type: 'square', f0: 784, dur: 0.5, peak: 0.06, attack: 0.01, filterF: 2000 });
    },
    // 电话订食材：两声老式电话铃（高频双音颤铃）
    ring: function (t0) {
      for (var b = 0; b < 2; b++) {
        var bt = t0 + b * 0.45;
        for (var i = 0; i < 6; i++) {
          tone({ t0: bt + i * 0.045, type: 'sine', f0: i % 2 ? 1180 : 960, dur: 0.04, peak: 0.14, attack: 0.004 });
        }
      }
    },
    // 别名：UI 壳层使用的事件语义名
    serve: function (t0) { RECIPES.ding(t0); },
    join: function (t0) { RECIPES.horn(t0); },
    phone: function (t0) { RECIPES.ring(t0); },
  };

  function play(kind) {
    if (S.muted) return;
    var ctx = ensureCtx();
    if (!ctx || ctx.state !== 'running') return; // 手势解锁前保持静默
    var recipe = RECIPES[kind];
    if (!recipe) return;
    var t = ctx.currentTime;
    var gap = MIN_GAP[kind] != null ? MIN_GAP[kind] : 0.08;
    if (t - (S._last[kind] || -9) < gap) return;
    S._last[kind] = t;
    try {
      recipe(t + 0.001);
    } catch (e) { /* 合成失败静默降级，绝不影响渲染 */ }
  }

  function setMuted(m) { S.muted = !!m; }

  window.COSound = {
    play: play,
    setMuted: setMuted,
    get muted() { return S.muted; },
  };
})();
