/* 纯状态逻辑（无 DOM）：快照/事件 → 厨房状态 + 订单流水 + 统计；返回渲染层效果列表。
   严格遵守 plan.md 的 SSE/API 契约。浏览器与 Node（自测）均可加载。 */
(function (global) {
  'use strict';

  var MAX_FEED = 30;
  var DEFAULT_CHEF_COLOR = '#d95f4b'; // 找不到厨师时的兜底色（理论上不该发生，仅防渲染崩溃）

  // cwd 目录名（浏览器无 node:path，手搓 basename；兼容 \ 与 / 分隔符）
  function baseName(p) {
    p = String(p || '').replace(/[/\\]+$/, '');
    var i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(i + 1) : p;
  }

  function createState() {
    return {
      kitchens: [],
      feed: [],
      stats: { kitchens: 0, activeKitchens: 0, chefs: 0, served: 0 }
    };
  }

  function normalizeChef(c) {
    return {
      id: String(c.id),
      name: c.name || String(c.id),
      role: c.role || null,
      depth: typeof c.depth === 'number' ? c.depth : 0,
      status: c.status === 'cooking' || c.status === 'done' ? c.status : 'idle',
      color: c.color || DEFAULT_CHEF_COLOR,
      lastAction: c.lastAction || null
    };
  }

  function normalizeKitchen(k) {
    return {
      id: String(k.id),
      name: k.name || '未命名厨房',
      cwd: k.cwd || '',
      // 项目名：后端透传的 Kitchen.project 优先，否则从 cwd 目录名推导（供项目分组）
      project: k.project || baseName(k.cwd),
      servedCount: k.servedCount || 0,
      active: !!k.active,
      lastTs: k.lastTs || 0,
      lazy: !!k.lazy, // true=占位厨房：历史未完整加载，点击后按需拉取
      chefs: (k.chefs || []).map(normalizeChef)
    };
  }

  function findKitchen(state, id) {
    for (var i = 0; i < state.kitchens.length; i++) {
      if (state.kitchens[i].id === id) return state.kitchens[i];
    }
    return null;
  }

  function findChef(kitchen, id) {
    for (var i = 0; i < kitchen.chefs.length; i++) {
      if (kitchen.chefs[i].id === id) return kitchen.chefs[i];
    }
    return null;
  }

  function recomputeStats(state) {
    var chefs = 0, served = 0, active = 0;
    state.kitchens.forEach(function (k) {
      chefs += k.chefs.length;
      served += k.servedCount || 0;
      if (k.active) active++;
    });
    state.stats = {
      kitchens: state.kitchens.length,
      activeKitchens: active,
      chefs: chefs,
      served: served
    };
  }

  function applySnapshot(state, kitchens) {
    state.kitchens = (kitchens || []).map(normalizeKitchen);
    recomputeStats(state);
    return [{ type: 'snapshot' }];
  }

  function pushFeed(state, entry) {
    state.feed.unshift(entry);
    if (state.feed.length > MAX_FEED) state.feed.length = MAX_FEED;
  }

  // 防御：契约外事件自动补建厨房/厨师，避免渲染崩溃
  function ensureKitchen(state, id) {
    var k = findKitchen(state, id);
    if (!k) {
      k = normalizeKitchen({ id: id, name: id, active: true });
      state.kitchens.push(k);
    }
    return k;
  }

  function ensureChef(kitchen, id) {
    var c = findChef(kitchen, id);
    if (!c) {
      c = normalizeChef({ id: id, name: id });
      kitchen.chefs.push(c);
    }
    return c;
  }

  /* 返回渲染效果数组：
     { type:'snapshot' }
     { type:'chef_added',  kitchenId, chef }
     { type:'chef_action', kitchenId, chef, action }
     { type:'chef_status', kitchenId, chefId, status }
     { type:'dish_served', kitchenId, dish, servedCount } */
  function applyEvent(state, ev) {
    if (!ev || !ev.type) return [];
    var effects = [];
    var k, c;

    switch (ev.type) {
      case 'snapshot':
        return applySnapshot(state, ev.kitchens);

      case 'chef_added': {
        var incoming = normalizeKitchen(ev.kitchen || { id: 'unknown' });
        k = findKitchen(state, incoming.id);
        if (!k) {
          state.kitchens.push(incoming);
          k = incoming;
        } else {
          k.name = incoming.name;
          k.cwd = incoming.cwd;
          k.project = incoming.project;
          k.servedCount = incoming.servedCount;
          k.active = incoming.active;
          k.lastTs = incoming.lastTs;
          incoming.chefs.forEach(function (ic) {
            if (!findChef(k, ic.id)) k.chefs.push(ic);
          });
        }
        c = normalizeChef(ev.chef || { id: 'unknown' });
        var existing = findChef(k, c.id);
        if (existing) {
          Object.assign(existing, c);
          c = existing;
        } else {
          k.chefs.push(c);
        }
        pushFeed(state, {
          ts: Date.now(), kitchenId: k.id, kitchenName: k.name,
          chefName: c.name, color: c.color,
          kind: 'join', label: '新厨师入职', detail: c.role || ''
        });
        effects.push({ type: 'chef_added', kitchenId: k.id, chef: c });
        break;
      }

      case 'chef_action': {
        k = ensureKitchen(state, String(ev.kitchenId));
        c = ensureChef(k, String(ev.chefId));
        var action = ev.action || { kind: 'idle', label: '', detail: '', ts: Date.now() };
        c.lastAction = action;
        if (action.kind === 'idle') c.status = 'idle';
        else if (c.status !== 'done') c.status = 'cooking';
        k.lastTs = action.ts || Date.now();
        k.active = true;
        if (action.kind !== 'idle' && action.kind !== 'join') {
          pushFeed(state, {
            ts: action.ts || Date.now(), kitchenId: k.id, kitchenName: k.name,
            chefName: c.name, color: c.color,
            kind: action.kind, label: action.label || action.kind, detail: action.detail || ''
          });
        }
        effects.push({ type: 'chef_action', kitchenId: k.id, chef: c, action: action });
        break;
      }

      case 'chef_status': {
        k = findKitchen(state, String(ev.kitchenId));
        if (!k) break;
        c = findChef(k, String(ev.chefId));
        if (!c) break;
        c.status = ev.status === 'cooking' || ev.status === 'done' ? ev.status : 'idle';
        effects.push({ type: 'chef_status', kitchenId: k.id, chefId: c.id, status: c.status });
        break;
      }

      case 'kitchen_updated': {
        var inc = normalizeKitchen(ev.kitchen || { id: 'unknown' });
        k = findKitchen(state, inc.id);
        if (!k) {
          state.kitchens.push(inc);
          effects.push({ type: 'kitchen_updated', kitchenId: inc.id, chefsChanged: inc.chefs.length > 0 });
          break;
        }
        // 厨师阵容是否变化（按需加载完成后占位厨房补进厨师；改名/歇业事件不变）
        var chefsChanged = k.lazy !== inc.lazy || k.chefs.length !== inc.chefs.length;
        if (!chefsChanged) {
          for (var ci = 0; ci < k.chefs.length; ci++) {
            if (!inc.chefs[ci] || inc.chefs[ci].id !== k.chefs[ci].id) { chefsChanged = true; break; }
          }
        }
        k.name = inc.name; k.cwd = inc.cwd; k.project = inc.project; k.active = inc.active;
        k.lazy = inc.lazy; k.servedCount = inc.servedCount; k.lastTs = inc.lastTs;
        // 厨师变了才整体替换（服务端为权威）；没变则保留本地对象，
        // 避免覆盖事件流刚写入的 lastAction/status
        if (chefsChanged) k.chefs = inc.chefs;
        effects.push({ type: 'kitchen_updated', kitchenId: k.id, chefsChanged: chefsChanged });
        break;
      }

      case 'dish_served': {
        k = ensureKitchen(state, String(ev.kitchenId));
        k.servedCount = (k.servedCount || 0) + 1;
        var dish = ev.dish || { name: '神秘料理', by: '', ts: Date.now() };
        // detail = 菜名 · 任务摘要（无 task 时只显示菜名）
        var dishDetail = dish.name || '';
        if (dish.task) dishDetail = dishDetail ? dishDetail + ' · ' + dish.task : dish.task;
        // 按 chefId 找厨师取真实颜色，与 chef_action 完工工单同色（厨师名跨厨房可能重复，不可信）；
        // 找不到厨师（旧数据无 chefId / id 未知）才退回默认色，保证不影响渲染。
        var dishChef = dish.chefId != null ? findChef(k, String(dish.chefId)) : null;
        pushFeed(state, {
          ts: dish.ts || Date.now(), kitchenId: k.id, kitchenName: k.name,
          chefName: dish.by || (dishChef && dishChef.name) || '厨师',
          color: (dishChef && dishChef.color) || DEFAULT_CHEF_COLOR,
          kind: 'serve', label: '出餐 ✅', detail: dishDetail
        });
        effects.push({ type: 'dish_served', kitchenId: k.id, dish: dish, servedCount: k.servedCount });
        break;
      }
    }

    recomputeStats(state);
    return effects;
  }

  global.COStore = {
    createState: createState,
    applySnapshot: applySnapshot,
    applyEvent: applyEvent,
    MAX_FEED: MAX_FEED
  };
})(typeof window !== 'undefined' ? window : globalThis);
