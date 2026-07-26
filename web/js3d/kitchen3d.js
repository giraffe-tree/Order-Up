// KitchenRenderer —— Codex Overcooked 3D 厨房渲染器（API 契约见 plan.md 第二阶段）
//   const r = new KitchenRenderer(containerEl);
//   r.setKitchen(kitchen, chefs); r.addChef(chef); r.chefAction(chefId, action);
//   r.chefStatus(chefId, status); r.dishServed(dish); r.resize(); r.dispose();
import * as THREE from '../vendor/three.module.min.js';
import { PAL, CHEF_COLORS } from './palette.js';
import { FX } from './fx.js';
import { ChefActor } from './chef.js';
import { plankTexture } from './textures.js';
import {
  buildKitchen, disposeKitchen, findPath, nearestCell, cellToWorld,
  DOOR_CELLS, SPAWN, REST_CELLS, GW, GH,
} from './stations.js';

const MAX_VISIBLE = 12;             // 同屏厨师上限
const DEG = Math.PI / 180;

// action.kind → 工位类型
const KIND_TO_STATION = {
  read: 'board', edit: 'wok', exec: 'stove', search: 'phone',
  tool: 'pressure', speak: 'serve', serve: 'serve',
};

export class KitchenRenderer {
  constructor(container) {
    this.container = container;
    this.chefs = new Map();     // id → { data, actor, visible }
    this.built = null;
    this.kitchenData = null;
    this.restAssign = new Map(); // chefId → rest cell index
    this.stoveFlip = false;

    // --- 渲染器 ---
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(PAL.groundOut);
    const el = this.renderer.domElement;
    el.style.display = 'block';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.touchAction = 'none';
    container.appendChild(el);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 120);

    // --- 灯光：暖色半球光 + 方向光（开阴影） ---
    this.hemi = new THREE.HemisphereLight(PAL.warmLight, 0x8A6F52, 1.55);
    this.scene.add(this.hemi);
    this.dir = new THREE.DirectionalLight(0xFFF1D6, 2.1);
    this.dir.position.set(6, 11, 5);
    this.dir.castShadow = true;
    this.dir.shadow.mapSize.set(2048, 2048);
    this.dir.shadow.camera.left = -10; this.dir.shadow.camera.right = 10;
    this.dir.shadow.camera.top = 10; this.dir.shadow.camera.bottom = -10;
    this.dir.shadow.camera.far = 40;
    this.dir.shadow.bias = -0.0006;
    this.scene.add(this.dir);

    this.fx = new FX(this.scene);

    // --- 摄像机轨道状态：透视 FOV40、俯仰 60°、正北方位、厨房居中 ---
    this.view = {
      az: 0,                 // 方位角（0=正北看向南，拖拽 ±40°）
      pitch: 60 * DEG,       // 俯仰（45°~70°）
      fitDist: 18,
      zoomK: 1,              // 滚轮缩放系数
      target: new THREE.Vector3(0, 0.3, -0.4), // 目标略偏北 → 厨房在画面略偏下
    };
    this.lastInteract = -10;
    this._bindInput();

    // 灶台火焰 / 高压锅蒸汽发射器在 setKitchen 时注册
    this.stoveEmitters = new Map();

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
    this.resize();

    this.clock = new THREE.Clock();
    this._raf = null;
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  // ============ API ============

  setKitchen(kitchen, chefs = []) {
    // 清场
    for (const [, c] of this.chefs) if (c.actor) c.actor.dispose(this.scene);
    this.chefs.clear();
    this.restAssign.clear();
    if (this.built) { disposeKitchen(this.scene, this.built); this.built = null; }
    this.stoveEmitters.clear();

    this.kitchenData = kitchen || { id: 'k', name: '厨房', active: true };
    this.built = buildKitchen(this.scene);
    this._indexStations();
    this._buildSigns();
    this._registerStationFX();
    this._applyActive(this.kitchenData.active !== false);

    // 厨师从门口依次小跑入场
    chefs.forEach((chef, i) => this._spawnChef(chef, i * 0.35));
    this._applyVisibilityCap();
  }

  addChef(chef) {
    if (!chef || this.chefs.has(chef.id)) return;
    this._spawnChef(chef, 0);
    this._applyVisibilityCap();
  }

  chefAction(chefId, action) {
    const entry = this.chefs.get(chefId);
    if (!entry || !action) return;
    entry.data.lastAction = action;
    if (entry.data.status === 'done') entry.data.status = 'cooking';
    this._applyVisibilityCap(); // 最新动作优先：触发重排，干活厨师抢到屏幕名额
    if (!entry.visible || !entry.actor) return;
    const actor = entry.actor;
    const kind = action.kind;
    const leaveStation = () => { if (actor.station) this._stationFX(actor.station, false); };

    if (kind === 'think') { leaveStation(); actor.think(action.label); return; }
    if (kind === 'burn') { leaveStation(); actor.burn(action.label); return; }
    if (kind === 'join') { leaveStation(); this._runIn(actor, action.label); return; }
    if (kind === 'idle') { this._sendToRest(actor, true); return; }

    const stationKind = KIND_TO_STATION[kind];
    const spot = stationKind ? this._pickSpot(stationKind) : null;
    if (!spot) { actor.think(action.label); return; } // 未知动作：原地思考兜底
    this._sendToStation(actor, spot, kind, action);
  }

  chefStatus(chefId, status) {
    const entry = this.chefs.get(chefId);
    if (!entry) return;
    entry.data.status = status;
    this._applyVisibilityCap();
    if (!entry.visible || !entry.actor) return;
    const actor = entry.actor;
    if (status === 'idle') this._sendToRest(actor, true);
    else if (status === 'done') {
      actor.cancelWork();
      actor.setBubble(null);
      // 回休息区坐下摘帽
      const cell = this._restCellFor(chefId);
      const w = cellToWorld(cell.ix, cell.iz);
      const path = this._pathFrom(actor, w);
      actor.goTo(path, { speed: 3.0, onArrive: () => actor.sitDone() });
    } else if (status === 'cooking') actor.wake();
  }

  dishServed(dish) {
    if (!this.built) return;
    // 菜品从出餐口窗口飞出 + 「出餐 +1」
    this.fx.dishServed(new THREE.Vector3(0, 1.1, -(GH - 1) / 2 + 0.3));
    if (this.kitchenData) this.kitchenData.servedCount = (this.kitchenData.servedCount || 0) + 1;
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._fitCamera();
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    this._unbindInput();
    for (const [, c] of this.chefs) if (c.actor) c.actor.dispose(this.scene);
    this.chefs.clear();
    ChefActor.disposeShared();
    if (this.built) { disposeKitchen(this.scene, this.built); this.built = null; }
    this.fx.dispose();
    if (this._signs) for (const s of this._signs) {
      if (s.material.map) s.material.map.dispose();
      s.material.dispose(); s.geometry.dispose();
    }
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  // ============ 内部：场景索引 ============

  _indexStations() {
    this.byKind = new Map();
    for (const s of this.built.spots) {
      if (!s.face) continue;
      if (!this.byKind.has(s.kind)) this.byKind.set(s.kind, []);
      this.byKind.get(s.kind).push(s);
    }
    this._spotRoundRobin = new Map();
  }

  _pickSpot(kind) {
    const list = this.byKind.get(kind);
    if (!list || !list.length) return null;
    const n = (this._spotRoundRobin.get(kind) || 0) + 1;
    this._spotRoundRobin.set(kind, n);
    return list[n % list.length];
  }

  _registerStationFX() {
    // 灶台火焰发射器（有厨师 exec 时开启）
    for (const s of this.built.spots) {
      if (s.kind === 'stove') {
        const e = this.fx.addEmitter({ x: s.x, y: s.topY + 0.05, z: s.z, kind: 'flame', rate: 10, jitter: 0.3, vy: 1.2, on: false });
        this.stoveEmitters.set(s, { emitter: e, users: 0, spot: s });
      } else if (s.kind === 'pressure') {
        const e = this.fx.addEmitter({ x: s.x, y: s.topY + 0.45, z: s.z, kind: 'steam', rate: 5, jitter: 0.12, vy: 1.0, on: false });
        this.stoveEmitters.set(s, { emitter: e, users: 0, spot: s });
      }
    }
  }

  _stationFX(spot, on) {
    const rec = this.stoveEmitters.get(spot);
    if (!rec) return;
    rec.users = Math.max(0, rec.users + (on ? 1 : -1));
    rec.emitter.on = rec.users > 0;
    if (rec.spot.glow) rec.spot.glow.material.opacity = on ? 0.55 : (rec.users > 0 ? 0.55 : 0);
  }

  // ============ 内部：标牌 ============

  _buildSigns() {
    this._signs = [];
    const mkSign = (text, w, h, pos, rotY = 0, opts = {}) => {
      const tex = plankTexture(text, opts);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
      mesh.position.copy(pos);
      mesh.rotation.y = rotY;
      this.scene.add(mesh);
      this._signs.push(mesh);
      return mesh;
    };
    const S = (GH - 1) / 2 + 0.66;
    // 厨房名牌（北墙上方，避开出餐窗口）
    this.nameSign = mkSign(`🍳 ${this.kitchenData.name || '厨房'}`, 3.2, 0.7,
      new THREE.Vector3(0, 2.78, -(GH - 1) / 2 - 0.5), 0, { fontSize: 40, bg: '#3A2E40' });
    // 歇业中（挂在门楣外立面，默认隐藏）
    this.closedSign = mkSign('歇业中', 1.7, 0.55, new THREE.Vector3(0, 1.72, S + 0.2), 0, { fontSize: 48 });
    this.closedSign.visible = false;
    // 后厨 +N（门右侧外墙，默认隐藏）
    this.backSign = mkSign('后厨 +0', 1.3, 0.42, new THREE.Vector3(2.35, 1.1, S + 0.2), 0, { fontSize: 40 });
    this.backSign.visible = false;
  }

  _setSignText(mesh, text, opts = {}) {
    const old = mesh.material.map;
    mesh.material.map = plankTexture(text, opts);
    mesh.material.needsUpdate = true;
    if (old) old.dispose();
  }

  _applyActive(active) {
    if (active) {
      this.hemi.intensity = 1.55;
      this.dir.intensity = 2.1;
      this.renderer.setClearColor(PAL.groundOut);
    } else {
      // 歇业：整体压暗
      this.hemi.intensity = 0.28;
      this.dir.intensity = 0.45;
      this.renderer.setClearColor(0x1E1510);
    }
    if (this.closedSign) this.closedSign.visible = !active;
  }

  // ============ 内部：厨师调度 ============

  _spawnChef(chef, delay = 0) {
    const actor = new ChefActor(chef, this.fx);
    actor.placeAt(SPAWN.x, SPAWN.z + delay * 2); // 门外排队，错开入场
    actor.group.visible = false;
    this.scene.add(actor.group);
    this.chefs.set(chef.id, { data: chef, actor, visible: true, spawnDelay: delay });
    actor.state = 'rest';
  }

  _runIn(actor, label) {
    const cell = this._restCellFor(actor.id);
    const w = cellToWorld(cell.ix, cell.iz);
    const path = this._pathFrom(actor, w);
    actor.goTo(path, { speed: 4.6, onArrive: () => actor.sleep() }); // 小跑入场
  }

  _restCellFor(chefId) {
    if (!this.restAssign.has(chefId)) {
      this.restAssign.set(chefId, this.restAssign.size % REST_CELLS.length);
    }
    return REST_CELLS[this.restAssign.get(chefId)];
  }

  _pathFrom(actor, worldTo) {
    const from = nearestCell(actor.cellPos.x, actor.cellPos.z);
    const to = nearestCell(worldTo.x, worldTo.z);
    const clamp = (c) => ({
      ix: Math.max(0, Math.min(GW - 1, c.ix)),
      iz: Math.max(0, Math.min(GH, c.iz)),
    });
    return findPath(this.built.walk, clamp(from), clamp(to));
  }

  _approachCell(spot) {
    const d = { n: [0, 1], s: [0, -1], e: [-1, 0], w: [1, 0] }[spot.face];
    return { ix: spot.ix + d[0], iz: spot.iz + d[1] };
  }

  _sendToStation(actor, spot, kind, action) {
    // 离开原工位时关掉灶台特效
    if (actor.station && actor.station !== spot) this._stationFX(actor.station, false);
    const cell = this._approachCell(spot);
    const w = cellToWorld(cell.ix, cell.iz);
    // 同工位多人微微错开
    let n = 0;
    for (const [, c] of this.chefs) if (c.actor && c.actor.station === spot) n++;
    w.x += ((n % 3) - 1) * 0.22;
    w.z += (Math.floor(n / 3) % 2) * 0.22 - 0.11;
    const path = this._pathFrom(actor, w);
    actor.setBubble(action.label || null);
    actor.goTo(path, {
      speed: 3.4,
      onArrive: () => {
        actor.startWork(kind, spot, action.label);
        this._stationFX(spot, true);
      },
    });
    // 标记目标工位（抵达前不占特效）
    actor.station = null;
    actor._pendingSpot = spot;
  }

  _sendToRest(actor, sleep) {
    if (actor.station) { this._stationFX(actor.station, false); }
    const cell = this._restCellFor(actor.id);
    const w = cellToWorld(cell.ix, cell.iz);
    const path = this._pathFrom(actor, w);
    actor.goTo(path, { speed: 3.0, onArrive: () => { if (sleep) actor.sleep(); } });
  }

  _applyVisibilityCap() {
    // 在干活的优先，其次按 lastAction 时间新到旧
    const all = [...this.chefs.values()];
    const rank = (c) => {
      const working = c.data.status === 'cooking' ? 1 : 0;
      const ts = c.data.lastAction?.ts || 0;
      return working * 1e15 + ts;
    };
    all.sort((a, b) => rank(b) - rank(a));
    let hidden = 0;
    all.forEach((c, i) => {
      const vis = i < MAX_VISIBLE;
      c.visible = vis;
      if (c.actor) c.actor.group.visible = vis && c.spawnDelay == null;
      if (!vis) hidden++;
    });
    if (this.backSign) {
      this.backSign.visible = hidden > 0;
      if (hidden > 0 && this._backN !== hidden) {
        this._backN = hidden;
        this._setSignText(this.backSign, `后厨 +${hidden}`, { fontSize: 40 });
      }
    }
  }

  // ============ 内部：摄像机 ============

  _fitCamera() {
    // 把 12×9 厨房（含墙）装进视口：取宽高两个约束的较大距离
    const halfW = (GW + 2.2) / 2;
    const halfH = ((GH + 2.4) / 2) * Math.sin(this.view.pitch) + 1.2;
    const vFov = this.camera.fov * DEG;
    const dV = halfH / Math.tan(vFov / 2);
    const dH = halfW / (Math.tan(vFov / 2) * this.camera.aspect);
    this.view.fitDist = Math.max(dV, dH) * 1.04;
  }

  _updateCamera(t) {
    const v = this.view;
    // 静止时轻微呼吸视差
    const idle = (t - this.lastInteract) > 2.5;
    const azB = idle ? Math.sin(t * 0.35) * 0.012 : 0;
    const piB = idle ? Math.sin(t * 0.27 + 1) * 0.006 : 0;
    const az = v.az + azB;
    const pitch = Math.max(45 * DEG, Math.min(70 * DEG, v.pitch + piB));
    const dist = v.fitDist * v.zoomK;
    const tgt = v.target;
    this.camera.position.set(
      tgt.x + dist * Math.cos(pitch) * Math.sin(az),
      tgt.y + dist * Math.sin(pitch),
      tgt.z + dist * Math.cos(pitch) * Math.cos(az),
    );
    this.camera.lookAt(tgt);
  }

  _bindInput() {
    const el = this.renderer.domElement;
    this._drag = null;
    this._onDown = (e) => {
      this._drag = { x: e.clientX, y: e.clientY, az: this.view.az, pitch: this.view.pitch };
      el.setPointerCapture?.(e.pointerId);
      this.lastInteract = this.clock.elapsedTime;
    };
    this._onMove = (e) => {
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x;
      const dy = e.clientY - this._drag.y;
      // 有限范围环绕：方位 ±40°、俯仰 45°-70°
      this.view.az = Math.max(-40 * DEG, Math.min(40 * DEG, this._drag.az - dx * 0.005));
      this.view.pitch = Math.max(45 * DEG, Math.min(70 * DEG, this._drag.pitch + dy * 0.004));
      this._fitCamera();
      this.lastInteract = this.clock.elapsedTime;
    };
    this._onUp = () => { this._drag = null; };
    this._onWheel = (e) => {
      e.preventDefault();
      this.view.zoomK = Math.max(0.62, Math.min(1.8, this.view.zoomK * (1 + e.deltaY * 0.001)));
      this.lastInteract = this.clock.elapsedTime;
    };
    el.addEventListener('pointerdown', this._onDown);
    el.addEventListener('pointermove', this._onMove);
    el.addEventListener('pointerup', this._onUp);
    el.addEventListener('pointercancel', this._onUp);
    el.addEventListener('wheel', this._onWheel, { passive: false });
  }

  _unbindInput() {
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this._onDown);
    el.removeEventListener('pointermove', this._onMove);
    el.removeEventListener('pointerup', this._onUp);
    el.removeEventListener('pointercancel', this._onUp);
    el.removeEventListener('wheel', this._onWheel);
  }

  // ============ 主循环（单 rAF） ============

  // 仅推进模拟（供自测/离线步进用；正常渲染走 _loop）
  step(dt) {
    this._update(Math.min(0.05, dt), this.clock.elapsedTime);
  }

  _loop() {
    this._raf = requestAnimationFrame(this._loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    this._update(dt, this.clock.elapsedTime);
    this.renderer.render(this.scene, this.camera);
  }

  _update(dt, t) {
    // 入场延迟（仅可见时计时，藏后厨的厨师轮到上场才跑进来）
    for (const [, c] of this.chefs) {
      if (c.spawnDelay != null && c.visible) {
        c.spawnDelay -= dt;
        if (c.spawnDelay <= 0) {
          c.spawnDelay = null;
          if (c.actor) {
            c.actor.group.visible = true;
            this._runIn(c.actor);
          }
        }
      }
    }
    for (const [, c] of this.chefs) {
      if (c.actor && c.visible && c.spawnDelay == null) c.actor.update(dt);
    }
    this.fx.update(dt);
    this._updateCamera(t);
  }
}
