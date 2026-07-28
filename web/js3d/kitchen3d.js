// KitchenRenderer —— Codex Overcooked 3D 厨房渲染器（API 契约见 plan.md 第二阶段）
//   const r = new KitchenRenderer(containerEl);
//   r.setKitchen(kitchen, chefs); r.addChef(chef); r.chefAction(chefId, action);
//   r.chefStatus(chefId, status); r.dishServed(dish); r.setActive(active); r.resize(); r.dispose();
import * as THREE from '../vendor/three.module.min.js';
import { PAL, CHEF_COLORS } from './palette.js';
import { FX } from './fx.js';
import { ChefActor } from './chef.js';
import { plankTexture } from './textures.js';
import { buildDecor } from './decor.js';
import { buildBackdrop } from './backdrop.js';
import { buildDining } from './dining.js';
import {
  buildKitchen, disposeKitchen, findPath, nearestCell, cellToWorld,
  DOOR_CELLS, SPAWN, REST_CELLS, GW, GH,
} from './stations.js';

const MAX_VISIBLE = 12;             // 同屏厨师上限
const REST_TIMEOUT = 60;            // 休息区打瞌睡超过此秒数 → 起身下班走出厨房（可配置）
const LOITER_MAX = 18;              // 完工后原地歇脚（喝水/擦汗）超过此秒数 → 走回休息区（可配置）
const DEG = Math.PI / 180;
const ZOOM_MIN = 0.62, ZOOM_MAX = 1.8; // 滚轮缩放系数范围（<1 放大、>1 缩小）
// 最大放大时的观察落点：厨房中心略偏南、视线略抬高——
// 全景目标偏北（给餐厅区留画面），放大时绕它缩距会把厨房南侧裁出画面下缘，
// 故 zoomK<1 时落点从全景目标向此点平滑收拢（见 _updateCamera）
const KITCHEN_FOCUS = new THREE.Vector3(0, 0.6, 0.4);

// 交谈中被找厨师的回应气泡（按回合轮替，配合点头/抬手小动作）
const CHAT_ACKS = ['收到！', '好嘞～', '嗯嗯！', '明白！', '马上就好', 'OK！'];
const TALK_MAX = 14;   // talk 交谈最长持续秒数（超时兜底，正常由发起人的下个事件结束）
const WAIT_MAX = 120;  // wait 等待最长持续秒数（正常由服务器 idle tick 或新事件结束）

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
    this._simT = 0;             // 模拟时钟（秒，随 _update 累积；step() 离线步进也生效）
    // 进行中的协作会话：发起人 chefId → { targetId, mode('talk'|'wait'), label, start, until, ph, turns, resume }
    // resume 是被找厨师的现场快照（state/workKind/station/label），交谈结束后原样恢复
    this._convos = new Map();

    // --- 渲染器 ---
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; // 暖光更柔、不过曝
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.setClearColor(PAL.groundOut);
    const el = this.renderer.domElement;
    el.style.display = 'block';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.touchAction = 'none';
    container.appendChild(el);

    this.scene = new THREE.Scene();
    // 厨房外氛围背景（黄昏穹顶 / 栅栏 / 路灯 / 远景剪影 / 萤火虫）：
    // scene 级一次性构建，不随 setKitchen 重建
    this.backdrop = buildBackdrop(this.scene);
    // 远景雾：比 backdrop 默认（46~100）收紧，让厨房外圈随距离自然压暗；
    // 餐厅区（距相机约 27 单位）仍在雾起点之内，保持清晰
    this.scene.fog = new THREE.Fog(0x3E2B1C, 27, 58);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 120);

    // --- 灯光：暖色半球光 + 方向光（开阴影）；吊灯/火把点光由 decor 提供并闪烁 ---
    this.hemi = new THREE.HemisphereLight(PAL.warmLight, 0x8A6F52, 1.3);
    this.scene.add(this.hemi);
    // 主光色温按美术基准取暖色 #FFE0B3（PAL.warmLight），从东南上方斜照
    this.dir = new THREE.DirectionalLight(PAL.warmLight, 1.85);
    this.dir.position.set(6, 11, 5);
    this.dir.castShadow = true;
    this.dir.shadow.mapSize.set(2048, 2048);
    this.dir.shadow.camera.left = -10; this.dir.shadow.camera.right = 10;
    this.dir.shadow.camera.top = 10; this.dir.shadow.camera.bottom = -10;
    this.dir.shadow.camera.far = 40;
    this.dir.shadow.bias = -0.0006;
    this.dir.shadow.normalBias = 0.03; // 盒体低多边形：压掉 flat 面上的阴影条纹
    this.scene.add(this.dir);

    this.fx = new FX(this.scene);

    // --- 摄像机轨道状态：透视 FOV40、俯仰 60°、正北方位、厨房居中 ---
    this.view = {
      az: 0,                 // 方位角（0=正北看向南，360° 连续自由环绕、不限位）
      pitch: 60 * DEG,       // 俯仰（30°~80°）
      fitDist: 18,
      zoomK: 1,              // 滚轮缩放系数
      target: new THREE.Vector3(0, 0.3, -0.4), // z 由 _fitCamera 按俯仰角重算（偏北 → 厨房略偏下、餐厅入画）
    };
    // 挡视线墙体消隐状态：各侧墙当前不透明度（1=不透明）；材质列表在 setKitchen 时收集
    this._wallMats = null;
    this._wallFade = { n: 1, s: 1, e: 1, w: 1 };
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
    this._convos.clear(); // 跨厨房的交谈会话一并作废
    this._disposeSigns(); // 旧标牌必须从场景移除：否则每次重建都叠加共面副本（泄漏 + 歇业牌残留显示）
    if (this.decor) { this.decor.dispose(); this.decor = null; }
    if (this.dining) { this.dining.dispose(); this.dining = null; } // 餐厅区随厨房重建（客人/等位队列一并清场）
    if (this.built) { disposeKitchen(this.scene, this.built); this.built = null; }
    this.stoveEmitters.clear();
    this.fx.emitters.length = 0; // 发射器随厨房重建，避免跨厨房累积

    this.kitchenData = kitchen || { id: 'k', name: '厨房', active: true };
    this.built = buildKitchen(this.scene);
    this._wallMats = this.built.wallFadeMats || null; // 各侧墙的可淡出材质（共享材质的独立克隆）
    this._wallFade = { n: 1, s: 1, e: 1, w: 1 };      // 新墙一律从不透明开始，再由消隐逻辑平滑过渡
    this.decor = buildDecor(this.scene, { wallN: -(GH - 1) / 2 - 0.66 });
    this.dining = buildDining(this.scene, this.fx); // 北墙外餐厅区（出餐第二程接力）
    this._indexStations();
    this._buildSigns();
    this._registerStationFX();
    this._active = this.kitchenData.active !== false;
    this._applyActive(this._active);

    // 厨师从门口依次小跑入场。
    // 早已下班的（非 cooking 且最近动作距今超过 REST_TIMEOUT）不再入场——
    // 否则切回厨房/刷新页面会重现一屋子打瞌睡的厨师；之后有新事件会重新入职。
    const now = Date.now();
    const onDuty = chefs.filter((c) => {
      const ts = c.lastAction && c.lastAction.ts;
      return !(c.status !== 'cooking' && ts && now - ts > REST_TIMEOUT * 1000);
    });
    onDuty.forEach((chef, i) => this._spawnChef(chef, i * 0.35));
    this._applyVisibilityCap();
  }

  addChef(chef) {
    if (!chef || this.chefs.has(chef.id)) return;
    this._spawnChef(chef, 0);
    this._applyVisibilityCap();
  }

  chefAction(chefId, action, chefData) {
    let entry = this.chefs.get(chefId);
    if (!entry && chefData) {
      // 已下班的厨师又来新事件：重新从门口入职（spawnDelay 一帧内生效）
      this._spawnChef(chefData, 0);
      entry = this.chefs.get(chefId);
      this._applyVisibilityCap();
    }
    if (!entry || !action) return;
    // 协作会话生命周期：发起人有了新动作 → 交谈结束（被找厨师恢复原状）；
    // 被找厨师自己来了新活 → 作废旧现场快照（新动作接管，不再恢复）
    this._endConvo(chefId);
    this._dropConvoForTarget(chefId);
    entry.data.lastAction = action;
    entry.restSince = null;   // 有新动作 → 重置下班倒计时
    entry.loiterSince = null; // 重置歇脚计时
    entry.leaving = false;    // 正在出门的立即返岗（后续 goTo 会覆盖走向门口的路径）
    if (entry.data.status === 'done') entry.data.status = 'cooking';
    this._applyVisibilityCap(); // 最新动作优先：触发重排，干活厨师抢到屏幕名额
    if (!entry.visible || !entry.actor) return;
    const actor = entry.actor;
    const kind = action.kind;
    const leaveStation = () => { if (actor.station) this._stationFX(actor.station, false); };

    // 想菜单（无 target）：走到菜单角翻阅菜单；菜单角不可用才退回原地思考
    if (kind === 'think' && action.target === undefined) {
      const spot = this._pickSpot('menu');
      if (spot) { this._sendToStation(actor, spot, 'think', action); return; }
      leaveStation(); actor._pendingSpot = null; actor.think(action.label); return;
    }
    if (kind === 'burn') { leaveStation(); actor._pendingSpot = null; actor.burn(action.label); return; }
    if (kind === 'join') { leaveStation(); actor._pendingSpot = null; this._runIn(actor, action.label); return; }
    if (kind === 'idle') { this._startLoiter(actor, entry); return; }

    // 协作动作：talk（传话/派活/叫停）与带 target 的 think（等队友）
    // → 离开工位，走到目标队友厨师身旁，面对面交谈/等待
    if (kind === 'talk' || kind === 'think') {
      if (actor.station) { this._stationFX(actor.station, false); actor.station = null; }
      actor._pendingSpot = null;
      this._sendToChef(actor, action, kind === 'talk' ? 'talk' : 'wait');
      return;
    }

    const stationKind = KIND_TO_STATION[kind];
    const spot = stationKind ? this._pickSpot(stationKind) : null;
    if (!spot) { actor._pendingSpot = null; actor.think(action.label); return; } // 未知动作：原地思考兜底
    this._sendToStation(actor, spot, kind, action);
  }

  chefStatus(chefId, status) {
    const entry = this.chefs.get(chefId);
    if (!entry) return;
    this._endConvo(chefId);          // 状态翻转（如 idle）同样结束其发起的交谈
    this._dropConvoForTarget(chefId);
    entry.data.status = status;
    if (status === 'cooking') { entry.restSince = null; entry.loiterSince = null; }
    this._applyVisibilityCap();
    if (!entry.visible || !entry.actor) return;
    const actor = entry.actor;
    if (status === 'idle') { this._startLoiter(actor, entry); return; }
    else if (status === 'done') {
      entry.restSince = this._simT; // 完工坐下也开始下班倒计时
      actor.cancelWork();
      actor.setBubble(null);
      actor._pendingSpot = null;
      // 回休息区坐下摘帽
      const w = this._restSpotFor(chefId);
      const path = this._pathFrom(actor, w);
      actor.goTo(path, { speed: 3.0, onArrive: () => actor.sitDone() });
    } else if (status === 'cooking') {
      actor.wake();
      if (entry.leaving) { // 出门途中被叫回：先回休息区等具体动作
        entry.leaving = false;
        this._sendToRest(actor, false);
      }
    }
  }

  dishServed(dish) {
    if (!this.built) return;
    // 出餐仪式：热气腾腾的菜从出餐厨师处抛物线飞向出餐口窗口，落点弹菜名
    const winZ = -(GH - 1) / 2 - 0.66;                 // 北墙内立面
    const to = new THREE.Vector3(0, 1.15, winZ + 0.3); // 窗台上（出餐口窗洞下沿）
    let from = null;
    const by = dish && dish.by;
    if (by) {
      for (const [, c] of this.chefs) {
        if (c.visible && c.actor && (c.data.name === by || c.data.id === by)) {
          const p = c.actor.group.position;
          from = new THREE.Vector3(p.x, 1.25, p.z);    // 从厨师手上起飞
          break;
        }
      }
    }
    if (!from) from = new THREE.Vector3(0, 1.3, -(GH - 1) / 2 + 0.6); // 找不到厨师：从出餐台起飞
    this.fx.dishServed(from, to, dish && dish.name);
    // 第二程接力：菜落窗台后由餐厅区排队送上餐桌（客人用餐 → 满意离开 → 新客人入场）
    if (this.dining) this.dining.serveDish(dish && dish.name);
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
    if (this.decor) { this.decor.dispose(); this.decor = null; }
    if (this.backdrop) { this.backdrop.dispose(); this.backdrop = null; }
    if (this.dining) { this.dining.dispose(); this.dining = null; }
    if (this.built) { disposeKitchen(this.scene, this.built); this.built = null; }
    this.fx.dispose();
    this._disposeSigns();
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
    // 灶台火焰发射器（有厨师 exec 时开启）+ 锅盖口沿常驻微蒸汽（氛围）
    for (const s of this.built.spots) {
      if (s.kind === 'stove') {
        const e = this.fx.addEmitter({ x: s.x, y: s.topY + 0.05, z: s.z, kind: 'flame', rate: 10, jitter: 0.3, vy: 1.2, on: false });
        this.stoveEmitters.set(s, { emitter: e, users: 0, spot: s });
        // 锅烧开后口沿缓缓冒汽
        this.fx.addEmitter({ x: s.x + 0.1, y: s.topY + 0.42, z: s.z, kind: 'steam', rate: 1.1, jitter: 0.14, vy: 0.55, scale: 0.7, on: true });
      } else if (s.kind === 'pressure') {
        const e = this.fx.addEmitter({ x: s.x, y: s.topY + 0.45, z: s.z, kind: 'steam', rate: 5, jitter: 0.12, vy: 1.0, on: false });
        this.stoveEmitters.set(s, { emitter: e, users: 0, spot: s });
        // 泄压阀常驻细汽
        this.fx.addEmitter({ x: s.x, y: s.topY + 0.46, z: s.z, kind: 'steam', rate: 0.7, jitter: 0.05, vy: 0.7, scale: 0.5, on: true });
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
      // 画布分辨率与牌子平面同宽高比（逻辑高 96px），避免 UV 拉伸导致文字变形发虚
      const plankOpts = { w: Math.max(2, Math.round(96 * w / h)), h: 96, ...opts };
      const tex = plankTexture(text, plankOpts);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
      mesh.position.copy(pos);
      mesh.rotation.y = rotY;
      mesh.userData.plankOpts = plankOpts; // 重绘时沿用同一分辨率/样式
      this.scene.add(mesh);
      this._signs.push(mesh);
      return mesh;
    };
    const S = (GH - 1) / 2 + 0.66;
    // 厨房名牌（挂在加高后的北墙砖面上，避开出餐窗口）
    // 微微后仰（顶边离墙），正面迎向俯视 60° 的相机，减少透视压缩
    this.nameSign = mkSign(`🍳 ${this.kitchenData.name || '厨房'}`, 3.2, 0.7,
      new THREE.Vector3(0, 2.82, -(GH - 1) / 2 - 0.32), 0,
      { fontSize: 44, bg: '#3A2E40', maxLen: 12, ss: 3 });
    this.nameSign.rotation.x = -0.14;
    // 歇业中（双绳悬挂在门楣下沿，默认隐藏）
    this.closedSign = this._buildClosedSign(S);
    this.closedSign.visible = false;
    // 后厨 +N（门右侧外墙，默认隐藏；离墙面留足距离避免 z-fighting）
    this.backSign = mkSign('后厨 +0', 1.3, 0.42, new THREE.Vector3(2.35, 1.1, S + 0.26), 0, { fontSize: 40 });
    this.backSign.visible = false;
  }

  // 歇业挂牌：带真实厚度的木板 + 双绳挂在门楣下沿。
  // 旧版是 z=S+0.2 的薄面片，与门楣前立面（S+0.17）竖直方向重叠且间距仅 0.03，
  // 低深度精度环境/斜视角度下会 z-fighting 闪烁；现在板顶低于门楣下沿、
  // 板背离门楣前立面 0.075、离南墙外立面 0.095，任何深度精度下都稳定。
  _buildClosedSign(S) {
    const g = new THREE.Group();
    const W = 1.7, H = 0.55, T = 0.05; // 木板宽/高/厚
    const PY = 1.48, PZ = S + 0.27;    // 板心：顶边 1.755（门楣下沿 1.88 之下）
    // 画布分辨率与板面同宽高比（逻辑高 96px），与 mkSign 同一套清晰度规则
    const tex = plankTexture('歇业中', { w: Math.max(2, Math.round(96 * W / H)), h: 96, fontSize: 48 });
    const wood = new THREE.MeshBasicMaterial({ color: 0x6B4527 }); // 侧面/背面素木色
    const face = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
    const plank = new THREE.Mesh(new THREE.BoxGeometry(W, H, T),
      [wood, wood, wood, wood, face, wood]); // 仅 +z 面贴字
    plank.position.set(0, PY, PZ);
    g.add(plank);
    // 双绳：从板顶挂到门楣下沿（绳在门楣前立面之前 0.10，看上去就像钉在门楣上）
    const topY = PY + H / 2, hangTo = 1.90;
    const ropeGeo = new THREE.CylinderGeometry(0.02, 0.02, hangTo - topY, 6);
    const ropeMat = new THREE.MeshBasicMaterial({ color: 0xA08155 }); // 麻绳色，暗色门洞里也能读出「双绳悬挂」
    for (const rx of [-0.55, 0.55]) {
      const rope = new THREE.Mesh(ropeGeo, ropeMat);
      rope.position.set(rx, (topY + hangTo) / 2, PZ);
      g.add(rope);
    }
    this.scene.add(g);
    return g;
  }

  // 移除并释放全部标牌（平面木牌走 _signs；歇业挂牌是 Group 单独释放）
  _disposeSigns() {
    if (this._signs) for (const s of this._signs) {
      this.scene.remove(s);
      if (s.material.map) s.material.map.dispose();
      s.material.dispose(); s.geometry.dispose();
    }
    this._signs = [];
    if (this.closedSign) {
      this.scene.remove(this.closedSign);
      const geoDone = new Set(), matDone = new Set();
      this.closedSign.traverse((o) => {
        if (o.geometry && !geoDone.has(o.geometry)) { geoDone.add(o.geometry); o.geometry.dispose(); }
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (matDone.has(m)) continue;
            matDone.add(m);
            if (m.map) m.map.dispose();
            m.dispose();
          }
        }
      });
      this.closedSign = null;
    }
    this.nameSign = null;
    this.backSign = null;
  }

  // 厨房改名：只重绘名牌纹理，不重建场景
  setKitchenName(name) {
    if (this.kitchenData) this.kitchenData.name = name;
    if (this.nameSign) this._setSignText(this.nameSign, `🍳 ${name || '厨房'}`);
  }

  // 歇业状态实时切换（不重建场景）：幂等——仅在实际变化时应用，
  // 状态抖动（重复事件/重复 kitchen_updated）不会导致灯光与门牌反复横跳
  setActive(active) {
    const a = active !== false;
    if (this.kitchenData) this.kitchenData.active = a;
    if (this._active === a) return;
    this._active = a;
    this._applyActive(a);
  }

  _setSignText(mesh, text, opts = {}) {
    const old = mesh.material.map;
    mesh.material.map = plankTexture(text, { ...mesh.userData.plankOpts, ...opts });
    mesh.material.needsUpdate = true;
    if (old) old.dispose();
  }

  _applyActive(active) {
    if (active) {
      this.hemi.intensity = 1.3;
      this.dir.intensity = 1.85;
      this.renderer.setClearColor(PAL.groundOut);
      if (this.scene.fog) this.scene.fog.color.set(0x3E2B1C);
    } else {
      // 歇业：整体压暗
      this.hemi.intensity = 0.28;
      this.dir.intensity = 0.45;
      this.renderer.setClearColor(0x1E1510);
      if (this.scene.fog) this.scene.fog.color.set(0x1E1510); // 雾色跟随背景，外圈融入夜色
    }
    if (this.decor) this.decor.setDim(active ? 1 : 0.12); // 吊灯/火把同步压暗
    if (this.backdrop) this.backdrop.setDim(active ? 1 : 0.35); // 背景氛围同步收敛（略留夜色活气）
    if (this.dining) this.dining.setDim(active ? 1 : 0.35); // 餐厅区同步：蜡烛收敛、不再迎客
    if (this.closedSign) this.closedSign.visible = !active;
  }

  // ============ 内部：厨师调度 ============

  _spawnChef(chef, delay = 0) {
    const actor = new ChefActor(chef, this.fx);
    actor.placeAt(SPAWN.x, SPAWN.z + delay * 2); // 门外排队，错开入场
    actor.group.visible = false;
    this.scene.add(actor.group);
    this.chefs.set(chef.id, { data: chef, actor, visible: true, spawnDelay: delay, restSince: null, loiterSince: null, leaving: false });
    actor.state = 'rest';
  }

  _runIn(actor, label) {
    const w = this._restSpotFor(actor.id);
    const path = this._pathFrom(actor, w);
    actor.goTo(path, { speed: 4.6, onArrive: () => actor.sleep() }); // 小跑入场
  }

  // 休息位分配：优先占空格；格子占满后同格厨师按黄金角环状错开，永不完全重叠
  _restSpotFor(chefId) {
    if (!this.restAssign.has(chefId)) {
      const used = new Set(this.restAssign.values());
      let idx = -1;
      for (let i = 0; i < REST_CELLS.length; i++) {
        if (!used.has(i)) { idx = i; break; }
      }
      if (idx === -1) idx = this.restAssign.size % REST_CELLS.length; // 全部占满：复用格子
      this.restAssign.set(chefId, idx);
    }
    const idx = this.restAssign.get(chefId);
    const cell = REST_CELLS[idx];
    const w = cellToWorld(cell.ix, cell.iz);
    // 同格第 k 个厨师（k≥1）：确定性环状偏移
    let k = 0;
    for (const [id, i] of this.restAssign) {
      if (id === chefId) break;
      if (i === idx) k++;
    }
    if (k > 0) {
      const ang = (k - 1) * 2.4 + 0.6; // 黄金角散布
      const r = 0.34 + 0.06 * Math.min(k, 3);
      w.x += Math.cos(ang) * r;
      w.z += Math.sin(ang) * r;
    }
    return w;
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
    // 同工位多人微微错开（已就位 + 正在赶路的都要计数，且排除自己）
    let n = 0;
    for (const [id, c] of this.chefs) {
      if (id === actor.id || !c.actor) continue;
      if (c.actor.station === spot || c.actor._pendingSpot === spot) n++;
    }
    w.x += ((n % 3) - 1) * 0.22;
    w.z += (Math.floor(n / 3) % 2) * 0.22 - 0.11;
    const path = this._pathFrom(actor, w);
    path.push(w); // 最后一站精确到错开点而非格中心（同工位多人真正错开，不再完全重叠）
    actor.setBubble(action.label || null);
    actor.goTo(path, {
      speed: 3.4,
      onArrive: () => {
        actor._pendingSpot = null;
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
    actor._pendingSpot = null;
    const entry = this.chefs.get(actor.id);
    if (entry) entry.restSince = sleep ? this._simT : null; // 入睡开始下班倒计时
    const w = this._restSpotFor(actor.id);
    const path = this._pathFrom(actor, w);
    actor.goTo(path, { speed: 3.0, onArrive: () => { if (sleep) actor.sleep(); } });
  }

  // 完工/空闲的连贯过渡：不立刻跑回休息区，先在原地歇脚（喝水/擦汗/东张西望），
  // 超过 LOITER_MAX 秒仍无新事件才慢慢走回休息区打瞌睡（由 _update 扫描驱动）。
  _startLoiter(actor, entry) {
    if (actor.station) { this._stationFX(actor.station, false); actor.station = null; }
    actor._pendingSpot = null;
    entry.loiterSince = this._simT;
    entry.restSince = null; // 歇脚期间不计下班倒计时（入睡后才开始）
    if (actor.state !== 'break') actor.takeBreak();
  }

  // 协作：走到另一位厨师身旁面对面交谈（talk）/等待（wait）。
  // 双向交互：被找的厨师会暂停手中活、转身面对发起人（睡觉/摘帽先被叫醒），
  // 交谈中双方气泡交替、对方点头/抬手回应；结束后对方回到原工位继续原动作（继续休息）。
  // wait 模式不打扰对方干活，对方偶尔回头招手示意（chef.js 的 _watcher）。
  // 目标优先取 action.target（队友 threadId）；拿不到就找同厨房最近的另一位可见厨师
  // （正在干活的优先）。厨房里没有别人时退回旧行为：talk→出餐口喊话，wait→原地思考。
  _sendToChef(actor, action, mode) {
    let targetEntry = null;
    if (action.target) {
      const e = this.chefs.get(action.target);
      if (e && e.visible && e.actor && e.actor !== actor && e.spawnDelay == null && !e.leaving) targetEntry = e;
    }
    if (!targetEntry) {
      let best = null, bestScore = Infinity;
      const ap = actor.group.position;
      for (const [id, c] of this.chefs) {
        if (id === actor.id || !c.visible || !c.actor || c.spawnDelay != null || c.leaving) continue;
        if (this._isConvoTarget(id)) continue; // 已在跟别人交谈的不抢
        const p = c.actor.group.position;
        const d = (p.x - ap.x) ** 2 + (p.z - ap.z) ** 2;
        const score = c.data.status === 'cooking' ? d * 0.25 : d; // 干活的优先
        if (score < bestScore) { bestScore = score; best = c; }
      }
      targetEntry = best;
    }
    if (!targetEntry) {
      if (mode === 'wait') { actor.think(action.label); return; }
      const spot = this._pickSpot('serve');
      if (spot) this._sendToStation(actor, spot, 'speak', action);
      else actor.think(action.label);
      return;
    }
    // 注：原工位特效已由 chefAction 的 leaveStation() 关闭，这里不再重复关
    actor._pendingSpot = null;
    const tp = targetEntry.actor.group.position;
    const ap = actor.group.position;
    // 站在目标身旁约 0.85 格处（朝自己来向一侧），保证两人面对面
    let dx = ap.x - tp.x, dz = ap.z - tp.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) { dx = 0; dz = 1; } // 与目标同点（如菜单角并肩翻阅）时默认站其南侧
    else { dx /= len; dz /= len; }
    const w = { x: tp.x + dx * 0.85, z: tp.z + dz * 0.85 };
    const path = this._pathFrom(actor, w);
    path.push(w); // 最后一站精确到偏移点而非格中心
    actor.setBubble(action.label || null);
    actor.goTo(path, {
      speed: 3.8,
      onArrive: () => {
        const ta = targetEntry.actor;
        if (!ta) return;
        actor.faceTowards(ta.group.position.x, ta.group.position.z);
        // 被找厨师的现场快照：交谈结束后原样恢复（工位/动作/睡觉/摘帽定格）
        const st = ta.state;
        // 赶路/入场/慌乱（burn）/已在跟别人交谈的厨师不打断，只保持现有转身行为
        const canEngage = st !== 'walk' && st !== 'enter' && st !== 'burn' && st !== 'chat';
        const convo = {
          targetId: targetEntry.data.id, mode, label: action.label || '',
          start: this._simT, until: this._simT + (mode === 'wait' ? WAIT_MAX : TALK_MAX),
          ph: -1, turns: 0,
          resume: canEngage ? { state: st, workKind: ta.workKind, station: ta.station, label: ta.bubbleText } : null,
        };
        this._convos.set(actor.id, convo);
        if (canEngage) {
          ta.faceTowards(actor.group.position.x, actor.group.position.z);
          if (mode === 'wait') {
            // 等队友：不打扰对方干活；对方干活时偶尔回头招手（chef.js work 分支的 _watcher）
            ta._watcher = { x: actor.group.position.x, z: actor.group.position.z };
          } else {
            // 交谈：对方暂停手中活面对面倾听；睡觉/摘帽定格的先叫醒，结束后恢复
            if (st === 'sleep' || st === 'sit') ta.wake();
            ta.pauseForChat(actor.group.position.x, actor.group.position.z);
            ta.setBubble(CHAT_ACKS[0]);
          }
        }
        if (mode === 'wait') actor.think(action.label);
        else actor.startWork('speak', null, action.label); // 交谈：喊话动作+气泡，不占工位
      },
    });
  }

  // 发起人视角结束协作会话：talk 模式把被找厨师原样放回现场（回工位/继续睡觉/继续定格）；
  // wait 模式只需摘掉对方身上的观望标记（对方从未被打断）
  _endConvo(initiatorId, { resume = true } = {}) {
    const cv = this._convos.get(initiatorId);
    if (!cv) return;
    this._convos.delete(initiatorId);
    // 发起人若还站在原地喊话，把被交替隐去的气泡还原（去向交给 idle/后续事件驱动）
    const ia = this.chefs.get(initiatorId)?.actor;
    if (ia && ia.state === 'work' && ia.workKind === 'speak' && !ia.station) {
      ia.setBubble(cv.mode === 'talk' ? (cv.label || null) : ia.bubbleText);
    }
    const ta = this.chefs.get(cv.targetId)?.actor;
    if (!ta) return;
    ta._watcher = null;
    if (cv.mode === 'wait' || !cv.resume) return;
    if (ta.state !== 'chat') return; // 对方已被别的事件接管
    ta.endChat();
    const r = cv.resume;
    if (!resume) return;
    if (r.state === 'work') ta.startWork(r.workKind, r.station, r.label); // 回到原工位继续原动作
    else if (r.state === 'think') ta.think(r.label);
    else if (r.state === 'sleep') ta.sleep(); // 继续休息
    else if (r.state === 'sit') ta.sitDone();
    // rest 等站立状态：endChat 已复位，去向交给 idle/后续事件驱动
  }

  // 被找厨师视角：它自己来了新动作/状态 → 作废旧现场（新行为接管，不再恢复旧现场）
  _dropConvoForTarget(targetId) {
    for (const [iid, cv] of this._convos) {
      if (cv.targetId === targetId) {
        cv.resume = null;
        this._endConvo(iid, { resume: false });
      }
    }
  }

  _isConvoTarget(chefId) {
    for (const [, cv] of this._convos) if (cv.targetId === chefId) return true;
    return false;
  }

  // 休息超时 → 起身从厨房门口走出去下班（入职动画的反向），走出门后从场景移除
  _exitChef(id) {
    const entry = this.chefs.get(id);
    if (!entry || !entry.actor) return;
    this._endConvo(id, { resume: false });   // 下班走人：其发起的交谈即刻收尾
    this._dropConvoForTarget(id);            // 正在跟别人交谈的对方也解除绑定
    entry.leaving = true;
    const actor = entry.actor;
    if (actor.station) this._stationFX(actor.station, false);
    actor._pendingSpot = null;
    actor.setBubble(null);
    actor.wake(); // sit（摘帽）状态先把帽子戴回去
    this.restAssign.delete(id); // 让出休息位
    const w = { x: SPAWN.x, z: SPAWN.z };
    const path = this._pathFrom(actor, w);
    path.push(w); // 最后一站精确到门外点（寻路只到格中心）
    actor.goTo(path, { speed: 3.2, onArrive: () => this._removeChef(id) });
  }

  _removeChef(id) {
    const entry = this.chefs.get(id);
    if (!entry) return;
    this._endConvo(id, { resume: false });
    this._dropConvoForTarget(id);
    if (entry.actor) entry.actor.dispose(this.scene);
    this.chefs.delete(id);
    this.restAssign.delete(id);
    this._applyVisibilityCap(); // 重排可见名额并更新「后厨 +N」木牌
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
      const was = c.visible;
      c.visible = vis;
      if (c.actor) c.actor.group.visible = vis && c.spawnDelay == null;
      if (!vis) {
        hidden++;
        this.restAssign.delete(c.data.id); // 藏进后厨：让出休息位，避免前厅休息区格子被占满
      } else if (!was && c.actor && c.spawnDelay == null) {
        // 从后厨回到前厅：重新分配休息位并走过去
        this._sendToRest(c.actor, c.data.status !== 'cooking');
      }
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
    // 取景范围：南墙外门牌（z≈+5.3）到北墙外餐厅区远端客桌（z≈-10.6，含客人身高）。
    // 顶部预留约 12% 屏幕高度给订单 HUD（内容顶边压到 NDC +0.76），底部留少量边距；
    // 上下约束联立解出观察目标 z 与距离——目标偏北，厨房因此略偏下居中、
    // 餐厅区在默认视角里自然入画，出餐口不再把厨房与客人隔出画面。
    const s = Math.sin(this.view.pitch), c = Math.cos(this.view.pitch);
    const tanH = Math.tan(this.camera.fov * DEG / 2);
    const Z_MIN = -10.6, Z_MAX = 6.2; // 取景北/南边界（餐厅远端 ~ 南墙外立面与门口台阶）
    const H_N = 1.2;                  // 北边界计入客人身高
    const TOP = 0.76, BOTTOM = 0.96;  // 内容允许触达的 NDC 上/下限
    // 视竖直方向上，地面点 z 的投影偏移 = (zT - z)·s，高度 y 的偏移 = y·c
    const k1 = H_N * c - Z_MIN * s, k2 = Z_MAX * s;
    const zT = (TOP * k2 - BOTTOM * k1) / ((TOP + BOTTOM) * s);
    const dV = (k1 + s * zT) / (TOP * tanH);
    // 横向约束：厨房宽 + 两侧余量（窄屏时由横向主导，纵向内容相应裁掉远端）
    const dH = ((GW + 2.2) / 2) / (tanH * this.camera.aspect);
    this.view.target.z = zT;
    this.view.fitDist = Math.max(dV, dH) * 1.03;
  }

  _updateCamera(t) {
    const v = this.view;
    // 静止时轻微呼吸视差
    const idle = (t - this.lastInteract) > 2.5;
    const azB = idle ? Math.sin(t * 0.35) * 0.012 : 0;
    const piB = idle ? Math.sin(t * 0.27 + 1) * 0.006 : 0;
    const az = v.az + azB;
    const pitch = Math.max(30 * DEG, Math.min(80 * DEG, v.pitch + piB));
    const dist = v.fitDist * v.zoomK;
    // 放大（zoomK<1）时观察落点从偏北的全景目标平滑收拢到厨房中心（KITCHEN_FOCUS）：
    // 全景目标 z 偏北（为餐厅区留画面），绕它直接缩距会把厨房南侧（画面下缘）裁掉
    const focus = Math.max(0, Math.min(1, (1 - v.zoomK) / (1 - ZOOM_MIN)));
    const tgt = this._camTgt || (this._camTgt = new THREE.Vector3());
    tgt.copy(v.target).lerp(KITCHEN_FOCUS, focus);
    this.camera.position.set(
      tgt.x + dist * Math.cos(pitch) * Math.sin(az),
      tgt.y + dist * Math.sin(pitch),
      tgt.z + dist * Math.cos(pitch) * Math.cos(az),
    );
    this.camera.lookAt(tgt);
  }

  // 挡视线墙体自动消隐：相机转到哪侧，哪侧的墙平滑淡出（转回淡入）。
  // 判定：相机方位角与该侧墙方位夹角 <50° 开始淡、<30° 淡到最浅；
  // 南墙是默认相机所在的「正面」（1.5 矮墙带门，俯视范围内不挡内部），永不淡出。
  _updateWallFade(dt) {
    const mats = this._wallMats;
    if (!mats) return;
    const SIDE_AZ = { s: 0, e: Math.PI / 2, n: Math.PI, w: -Math.PI / 2 }; // 与 view.az 同定义（0=相机在南）
    const MIN_OP = { n: 0.18, e: 0.18, w: 0.18, s: 1 }; // 淡出后残影透明度（s=1 → 不淡）
    for (const side of ['n', 's', 'e', 'w']) {
      const list = mats[side];
      if (!list || !list.length) continue;
      let d = Math.abs(this.view.az - SIDE_AZ[side]) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      const k = Math.max(0, Math.min(1, (50 * DEG - d) / (20 * DEG)));
      const target = 1 - k * (1 - MIN_OP[side]);
      const cur = this._wallFade[side];
      if (cur === target) continue;
      const next = Math.abs(target - cur) < 0.004 ? target : cur + (target - cur) * Math.min(1, dt * 7);
      this._wallFade[side] = next;
      const opaque = next > 0.999;
      for (const m of list) {
        if (m.userData.wallBaseT === undefined) m.userData.wallBaseT = m.transparent; // 记住材质原生透明标记
        m.opacity = opaque ? 1 : next;
        m.transparent = m.userData.wallBaseT || !opaque;
        if (!m.userData.wallBaseT) {
          m.depthWrite = opaque; // 淡出时关深度写入，恢复时还原
          // transparent 切换必须 needsUpdate 刷新渲染状态，否则仍按不透明程序绘制
          if (m.userData.wallOpaque !== opaque) { m.needsUpdate = true; m.userData.wallOpaque = opaque; }
        }
      }
    }
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
      // 360° 连续自由环绕：方位不限位（可无限绕圈）、俯仰 30°-80°（不穿地、不翻到场景下方）
      this.view.az = this._drag.az - dx * 0.005;
      this.view.pitch = Math.max(30 * DEG, Math.min(80 * DEG, this._drag.pitch + dy * 0.004));
      this._fitCamera();
      this.lastInteract = this.clock.elapsedTime;
    };
    this._onUp = () => { this._drag = null; };
    this._onWheel = (e) => {
      e.preventDefault();
      this.view.zoomK = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.view.zoomK * (1 + e.deltaY * 0.001)));
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
    this._simT += dt;
    // 入场延迟（仅可见时计时，藏后厨的厨师轮到上场才跑进来）
    for (const [, c] of this.chefs) {
      if (c.spawnDelay != null && c.visible) {
        c.spawnDelay -= dt;
        if (c.spawnDelay <= 0) {
          c.spawnDelay = null;
          if (c.actor) {
            c.actor.group.visible = true;
            // 已被 chefAction 抢先派活的（重新入职即来单）：不再跑回休息区
            if (c.actor.state === 'rest' && !c.actor.path.length) this._runIn(c.actor);
          }
        }
      }
    }
    // 协作会话：talk 模式双方气泡交替（发起人说一句 ↔ 对方点头回一句）+ 超时兜底结束
    for (const [iid, cv] of this._convos) {
      if (this._simT > cv.until) { this._endConvo(iid); continue; }
      if (cv.mode !== 'talk' || !cv.resume) continue;
      const ia = this.chefs.get(iid)?.actor;
      const ta = this.chefs.get(cv.targetId)?.actor;
      if (!ia || !ta || ta.state !== 'chat' || ia.state !== 'work') continue;
      const ph = Math.floor((this._simT - cv.start) / 1.7) % 2;
      if (ph === cv.ph) continue;
      cv.ph = ph;
      if (ph === 0) { ia.setBubble(cv.label || '💬'); ta.setBubble(null); }
      else { ia.setBubble(null); ta.setBubble(CHAT_ACKS[++cv.turns % CHAT_ACKS.length]); }
    }
    // 歇脚超时：原地歇脚超过 LOITER_MAX 秒仍无新事件 → 走回休息区打瞌睡
    for (const [, c] of this.chefs) {
      if (c.loiterSince == null || c.leaving || c.spawnDelay != null || !c.actor) continue;
      if (this._simT - c.loiterSince <= LOITER_MAX) continue;
      c.loiterSince = null;
      if (c.actor.state === 'break') this._sendToRest(c.actor, true);
    }
    // 休息超时退场：前厅的走门口下班动画；藏在后厨的直接移除
    for (const [id, c] of this.chefs) {
      if (c.restSince == null || c.leaving) continue;
      if (this._simT - c.restSince <= REST_TIMEOUT) continue;
      if (!c.visible) { this._removeChef(id); continue; }
      if (c.spawnDelay != null || !c.actor) continue;
      const st = c.actor.state;
      if (st === 'sleep' || st === 'sit' || st === 'rest') this._exitChef(id);
    }
    for (const [, c] of this.chefs) {
      if (c.actor && c.visible && c.spawnDelay == null) c.actor.update(dt);
    }
    this.fx.update(dt);
    if (this.decor) this.decor.update(t); // 吊灯/火把光晕闪烁
    if (this.backdrop) this.backdrop.update(t); // 萤火虫漂移 / 路灯光晕呼吸
    if (this.dining) this.dining.update(dt, this._simT); // 餐厅区：客人入场/用餐/离席、窗台排队上菜
    this._updateCamera(t);
    this._updateWallFade(dt); // 挡视线墙体按相机方位淡出/淡入
  }
}
