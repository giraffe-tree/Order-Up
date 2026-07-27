/* 占位渲染器（降级自测用）：与 web/js3d/kitchen3d.js 完全相同的 API。
   3D 模块加载失败时，main.js 动态 import 会 catch 回退到这里，
   保证 UI 壳在 Engine3D 完工前即可独立联调。实现：2D 色块画布 + 文字日志。 */

const KIND_LABEL = {
  read: '📖 看菜谱', edit: '🔪 切菜炒菜', exec: '🔥 开火上灶', search: '📞 订食材',
  tool: '⚡ 高压锅', think: '💭 想菜单', speak: '🔔 喊话', serve: '✅ 出餐',
  burn: '💥 糊了', join: '👨‍🍳 入职', idle: '💤 休息'
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class KitchenRenderer {
  constructor(containerEl) {
    this.container = containerEl;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stub-canvas';
    this.logEl = document.createElement('div');
    this.logEl.className = 'stub-log';
    containerEl.appendChild(this.canvas);
    containerEl.appendChild(this.logEl);
    this.ctx = this.canvas.getContext('2d');
    this.kitchen = null;
    this.chefs = new Map(); // chefId -> { name, color, status, lastActionLabel }
    this.served = 0;
    this.resize();
    this.log('占位渲染器已启动（2D stub）');
  }

  /* 切换厨房：清场重建 */
  setKitchen(kitchen, chefs) {
    this.kitchen = kitchen || null;
    this.chefs.clear();
    (chefs || []).forEach((c) => {
      this.chefs.set(String(c.id), {
        name: c.name || String(c.id),
        color: c.color || '#E0473C',
        status: c.status || 'idle',
        lastActionLabel: c.lastAction ? (KIND_LABEL[c.lastAction.kind] || c.lastAction.label || '') : ''
      });
    });
    this.served = kitchen ? (kitchen.servedCount || 0) : 0;
    if (kitchen) this.log('—— 切换到厨房「' + kitchen.name + '」——');
    this.draw();
  }

  addChef(chef) {
    if (!chef) return;
    this.chefs.set(String(chef.id), {
      name: chef.name || String(chef.id),
      color: chef.color || '#E0473C',
      status: chef.status || 'cooking',
      lastActionLabel: '👨‍🍳 入职'
    });
    this.log('👨‍🍳 新厨师入职：' + (chef.name || chef.id));
    this.draw();
  }

  chefAction(chefId, action) {
    var c = this.chefs.get(String(chefId));
    var label = action ? (KIND_LABEL[action.kind] || action.label || action.kind) : '';
    if (c) {
      c.lastActionLabel = label;
      if (action && action.kind !== 'idle' && c.status !== 'done') c.status = 'cooking';
      if (action && action.kind === 'idle') c.status = 'idle';
    }
    this.log((c ? c.name : chefId) + '：' + label + (action && action.detail ? '（' + action.detail + '）' : ''));
    this.draw();
  }

  chefStatus(chefId, status) {
    var c = this.chefs.get(String(chefId));
    if (c) { c.status = status; this.draw(); }
  }

  dishServed(dish) {
    this.served++;
    this.log('✅ 出餐：' + ((dish && dish.name) || '神秘料理') + '（by ' + ((dish && dish.by) || '厨师') + '）');
    this.draw();
  }

  // 歇业状态实时切换（与 3D 渲染器同契约；stub 只记状态）
  setActive(active) {
    if (this.kitchen) this.kitchen.active = active !== false;
  }

  resize() {
    var w = this.container.clientWidth || 640;
    var h = this.container.clientHeight || 400;
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.draw();
  }

  dispose() {
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    if (this.logEl.parentNode) this.logEl.parentNode.removeChild(this.logEl);
  }

  log(text) {
    var line = document.createElement('div');
    line.textContent = text;
    this.logEl.appendChild(line);
    while (this.logEl.children.length > 6) this.logEl.removeChild(this.logEl.firstChild);
  }

  draw() {
    var ctx = this.ctx;
    if (!ctx) return;
    var W = this.canvas.width, H = this.canvas.height;
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    ctx.save();
    ctx.scale(dpr, dpr);
    W /= dpr; H /= dpr;

    // 深色墙面
    ctx.fillStyle = '#3A2E40';
    ctx.fillRect(0, 0, W, H);

    // 木地板
    var m = 26;
    ctx.fillStyle = '#D2A06B';
    roundRect(ctx, m, m, W - 2 * m, H - 2 * m, 16);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#2A2138';
    ctx.stroke();
    // 板缝
    ctx.strokeStyle = 'rgba(122, 82, 48, 0.45)';
    ctx.lineWidth = 2;
    for (var gx = m + 44; gx < W - m; gx += 44) {
      ctx.beginPath(); ctx.moveTo(gx, m + 4); ctx.lineTo(gx, H - m - 4); ctx.stroke();
    }

    // 标题
    ctx.fillStyle = '#2A2138';
    ctx.font = '900 22px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(this.kitchen ? '🍳 ' + this.kitchen.name : '等待厨房…', m + 16, m + 36);
    ctx.font = '800 14px "PingFang SC", sans-serif';
    ctx.fillStyle = '#7A5230';
    ctx.fillText('出餐 ' + this.served + ' ｜ 厨师 ' + this.chefs.size, m + 16, m + 60);

    // 厨师色块（身体 + 白帽 + 脚下指示圈）
    var x = m + 20, y = m + 96;
    this.chefs.forEach(function (c) {
      // 脚下同色圆环（玩家指示圈）
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x + 32, y + 58, 26, 0, Math.PI * 2); ctx.stroke();
      // 身体
      ctx.fillStyle = c.status === 'done' ? '#928688' : c.color;
      roundRect(ctx, x, y, 64, 52, 10);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#2A2138';
      ctx.stroke();
      // 围裙
      ctx.fillStyle = '#FFFFFF';
      roundRect(ctx, x + 20, y + 18, 24, 26, 4);
      ctx.fill();
      // 厨师帽
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath(); ctx.arc(x + 32, y - 8, 16, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = '#2A2138'; ctx.stroke();
      // 名字 + 动作
      ctx.fillStyle = '#2A2138';
      ctx.font = '900 12px "PingFang SC", sans-serif';
      ctx.fillText(c.name + (c.status === 'idle' ? ' 💤' : ''), x, y + 76);
      if (c.lastActionLabel) {
        ctx.fillStyle = '#7A5230';
        ctx.font = '700 11px "PingFang SC", sans-serif';
        ctx.fillText(c.lastActionLabel.slice(0, 12), x, y + 92);
      }
      x += 92;
      if (x > W - m - 80) { x = m + 20; y += 128; }
    });

    ctx.restore();
  }
}

/* 供 main.js 识别当前是降级 stub（显示提示徽章） */
KitchenRenderer.isStub = true;
