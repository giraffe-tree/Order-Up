// 厨师角色：二头身 Q 版（大厨帽≈身体体积）、名字精灵、动作气泡、动画状态机
// 个性系统：待机小动作（东张西望/擦汗/颠勺）、走路手臂摆动、程序化眼睛（眼神/眨眼/眯眼）
// 名牌使用 THREE.Sprite —— 天然始终面向镜头
import * as THREE from '../vendor/three.module.min.js';
import { PAL, CHEF_OUTFITS, CHEF_SKINS } from './palette.js';
import { nameTexture, drawBubble, makeSprite } from './textures.js';

// ---------- 共享几何体 ----------
const G = {};
function geo(key, make) { return G[key] || (G[key] = make()); }

// ---------- 共享材质（跨厨师复用：颜色相同即同一份；由 disposeShared 统一释放） ----------
const M = {};
function mat(key, make) {
  if (!M[key]) { M[key] = make(); M[key].userData.shared = true; }
  return M[key];
}

// ---------- 确定性形象派生 ----------
// 以 chef.id（= threadId，稳定标识）哈希为种子：同一厨师休息退场后重新入职形象一致。
// 各维度用不同盐值哈希，互不相关；与 server/parser.js 的 hashStr 同一算法。
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// look: { head, outfit, hat, skin, heightK, widthK }
//   hat: 0 大厨帽 | 1 头巾 | 2 丸子头 | 3 工作帽（主厨固定 0 且加高一档）
function deriveLook(chef) {
  const id = String(chef.id ?? chef.name ?? 'chef');
  const head = chef.depth === 0;
  return {
    head,
    outfit: CHEF_OUTFITS[hashStr(id) % CHEF_OUTFITS.length],
    hat: head ? 0 : hashStr(id + '|hat') % 4,
    skin: CHEF_SKINS[hashStr(id + '|skin') % CHEF_SKINS.length],
    heightK: 0.94 + (hashStr(id + '|h') % 5) * 0.03, // 0.94–1.06
    widthK: 0.92 + (hashStr(id + '|w') % 5) * 0.05,  // 0.92–1.12
  };
}

const WORK_KINDS = new Set(['read', 'edit', 'exec', 'search', 'tool', 'speak', 'serve']);

export class ChefActor {
  constructor(chef, fx) {
    this.id = chef.id;
    this.name = chef.name || '厨师';
    this.fx = fx;
    this.color = new THREE.Color(chef.color || '#447EE0');
    this.group = new THREE.Group();
    this.state = 'enter';        // enter|walk|work|think|burn|sleep|sit|rest|chat（被队友找上倾听）
    this.path = [];
    this.onArrive = null;
    this.arriveAction = null;
    this.speed = 3.4;
    this.animT = Math.random() * 10;
    this.stepAcc = 0;
    this.faceY = 0;
    this.workKind = null;
    this.station = null;
    this.cellPos = { x: 0, z: 0 };
    // 个性状态：眼神游移 / 眨眼 / 待机小动作（各厨师相位随机，避免全场同步）
    this._glance = { t: 1.5 + Math.random() * 3, active: false, yaw: 0 };
    this._blinkT = 1.5 + Math.random() * 3.5;
    this._idle = { t: 3 + Math.random() * 7, kind: null, phase: 0 };
    this.look = deriveLook(chef); // 确定性形象（先于 _build）
    this._build();
  }

  _build() {
    const c = this.color;
    const look = this.look;
    // 身份色（chef.color）：脚下圆环 / 名牌 / 围巾 / 帽带沿用，保持与 UI 票卡同色
    const idHex = '#' + c.getHexString();
    const scarfHex = look.head ? '#D94F3D' : idHex; // 主厨红领巾，其他用身份色
    const bandHex = look.head ? '#E8B23A' : idHex;  // 主厨金帽带，其他用身份色
    const bodyMat = mat('body:' + look.outfit, () => new THREE.MeshStandardMaterial({
      color: look.outfit, flatShading: true, roughness: 0.9,
    }));
    const apronMat = mat('apron:' + look.outfit, () => new THREE.MeshStandardMaterial({
      color: new THREE.Color(look.outfit).lerp(new THREE.Color(0xFFFFFF), 0.35), flatShading: true, roughness: 0.9,
    }));
    const whiteMat = mat('hatWhite', () => new THREE.MeshStandardMaterial({ color: PAL.hat, flatShading: true, roughness: 0.95 }));
    const shadeMat = mat('hatShade', () => new THREE.MeshStandardMaterial({ color: PAL.hatShade, flatShading: true, roughness: 0.95 }));
    const skinMat = mat('skin:' + look.skin, () => new THREE.MeshStandardMaterial({ color: look.skin, flatShading: true, roughness: 0.9 }));
    const scarfMat = mat('scarf:' + scarfHex, () => new THREE.MeshStandardMaterial({ color: scarfHex, flatShading: true, roughness: 0.9 }));
    const bandMat = mat('band:' + bandHex, () => new THREE.MeshStandardMaterial({ color: bandHex, flatShading: true, roughness: 0.9 }));
    const hairMat = mat('hair', () => new THREE.MeshStandardMaterial({ color: 0x5B4632, flatShading: true, roughness: 0.95 }));

    // 脚下圆环（chef.color）
    const ring = new THREE.Mesh(
      geo('ring', () => new THREE.RingGeometry(0.42, 0.52, 24)),
      mat('ring:' + idHex, () => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, side: THREE.DoubleSide })),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    this.group.add(ring);

    this.body = new THREE.Group();
    this.group.add(this.body);
    // 体型差异集中在 figure 内层：动画每帧重写 body.scale（挤压拉伸/呼吸），
    // figure 的胖瘦/高矮缩放恒定不被覆盖，且与动画缩放自然叠加
    this.figure = new THREE.Group();
    this.figure.scale.set(look.widthK, look.heightK, look.widthK);
    this.body.add(this.figure);
    const F = this.figure;

    // 身体圆柱（制服色，按 id 哈希取自 CHEF_OUTFITS）
    const torso = new THREE.Mesh(geo('torso', () => new THREE.CylinderGeometry(0.26, 0.3, 0.55, 14)), bodyMat);
    torso.position.y = 0.36;
    torso.castShadow = true;
    F.add(torso);
    // 围裙（制服色提亮）
    const apron = new THREE.Mesh(geo('apron', () => new THREE.BoxGeometry(0.3, 0.35, 0.04)), apronMat);
    apron.position.set(0, 0.34, 0.26);
    F.add(apron);
    // 围巾（颈巾 + 侧结）：主厨红 / 其他身份色，一眼认出是谁
    const scarf = new THREE.Mesh(geo('scarf', () => new THREE.CylinderGeometry(0.2, 0.24, 0.07, 12)), scarfMat);
    scarf.position.y = 0.6;
    const knot = new THREE.Mesh(geo('scarfKnot', () => new THREE.SphereGeometry(0.055, 6, 5)), scarfMat);
    knot.position.set(0.11, 0.57, 0.22);
    F.add(scarf, knot);
    // 脸（肤色变体）
    const face = new THREE.Mesh(geo('face', () => new THREE.SphereGeometry(0.17, 12, 10)), skinMat);
    face.position.set(0, 0.72, 0.1);
    face.castShadow = true;
    F.add(face);
    // 眼睛组：整体可左右转动（眼神朝向）、scale.y 压缩做眨眼/眯眼
    const eyeMat = mat('eye', () => new THREE.MeshBasicMaterial({ color: 0x2A2138 }));
    const hlMat = mat('eyeHL', () => new THREE.MeshBasicMaterial({ color: 0xFFFDF6 }));
    this.eyeGroup = new THREE.Group();
    this.eyeGroup.position.set(0, 0.75, 0.22);
    for (const dx of [-0.06, 0.06]) {
      const eye = new THREE.Mesh(geo('eye', () => new THREE.SphereGeometry(0.025, 6, 5)), eyeMat);
      eye.position.set(dx, 0, 0.03);
      // 高光小点让眼睛更有神
      const hl = new THREE.Mesh(geo('eyeHL', () => new THREE.SphereGeometry(0.009, 4, 3)), hlMat);
      hl.position.set(dx + 0.012, 0.012, 0.048);
      this.eyeGroup.add(eye, hl);
    }
    F.add(this.eyeGroup);
    // 手臂 + 白手套
    const gloveMat = mat('glove', () => new THREE.MeshStandardMaterial({ color: PAL.glove, flatShading: true, roughness: 0.9 }));
    this.armL = new THREE.Group(); this.armR = new THREE.Group();
    this.armL.position.set(-0.3, 0.52, 0); this.armR.position.set(0.3, 0.52, 0);
    for (const [arm, sx] of [[this.armL, -1], [this.armR, 1]]) {
      const limb = new THREE.Mesh(geo('limb', () => new THREE.CylinderGeometry(0.05, 0.05, 0.22, 8)), bodyMat);
      limb.position.y = -0.1;
      const hand = new THREE.Mesh(geo('hand', () => new THREE.SphereGeometry(0.09, 8, 6)), gloveMat);
      hand.position.y = -0.24;
      hand.castShadow = true;
      arm.add(limb, hand);
      F.add(arm);
    }
    // 深色小鞋尖 ×2
    const shoeMat = mat('shoe', () => new THREE.MeshStandardMaterial({ color: PAL.shoe, flatShading: true, roughness: 0.9 }));
    for (const dx of [-0.12, 0.12]) {
      const shoe = new THREE.Mesh(geo('shoe', () => new THREE.BoxGeometry(0.13, 0.08, 0.2)), shoeMat);
      shoe.position.set(dx, 0.04, 0.04);
      F.add(shoe);
    }
    // 帽子/头部装饰 4 变体（按 id 哈希；主厨固定大厨帽并加高一档）
    this.hat = new THREE.Group();
    this.hat.position.y = 0.86;
    if (look.hat === 0) {
      // 经典大厨帽：帽檐圆柱 + 白色圆顶（体积≈身体）
      const brim = new THREE.Mesh(geo('brim', () => new THREE.CylinderGeometry(0.3, 0.3, 0.14, 14)), whiteMat);
      brim.castShadow = true;
      const band = new THREE.Mesh(geo('band', () => new THREE.CylinderGeometry(0.305, 0.305, 0.05, 14)), bandMat);
      band.position.y = -0.06;
      const shade = new THREE.Mesh(geo('hatShade', () => new THREE.CylinderGeometry(0.28, 0.3, 0.03, 14)), shadeMat);
      shade.position.y = -0.085;
      const dome = new THREE.Mesh(geo('dome', () => new THREE.SphereGeometry(0.32, 14, 10)), whiteMat);
      dome.scale.set(1, 0.78, 1);
      dome.position.y = 0.18;
      dome.castShadow = true;
      this.hat.add(brim, band, shade, dome);
      if (look.head) this.hat.scale.set(1.06, 1.32, 1.06); // 主厨：帽子加高一档
    } else if (look.hat === 1) {
      // 头巾：身份色包布 + 脑后小结
      const wrap = new THREE.Mesh(geo('bandana', () => new THREE.SphereGeometry(0.28, 12, 8)), scarfMat);
      wrap.scale.set(1, 0.58, 1);
      wrap.position.y = 0.05;
      wrap.castShadow = true;
      const knot2 = new THREE.Mesh(geo('bandanaKnot', () => new THREE.SphereGeometry(0.07, 6, 5)), scarfMat);
      knot2.position.set(0.12, -0.01, -0.25);
      this.hat.add(wrap, knot2);
    } else if (look.hat === 2) {
      // 丸子头：深棕发盖 + 头顶丸子 + 身份色发绳
      const hair = new THREE.Mesh(geo('hairCap', () => new THREE.SphereGeometry(0.19, 12, 8)), hairMat);
      hair.scale.set(1, 0.72, 1);
      hair.position.set(0, -0.06, 0.01);
      const bun = new THREE.Mesh(geo('bun', () => new THREE.SphereGeometry(0.085, 8, 6)), hairMat);
      bun.position.y = 0.15;
      bun.castShadow = true;
      const tie = new THREE.Mesh(geo('bunTie', () => new THREE.CylinderGeometry(0.09, 0.09, 0.035, 10)), scarfMat);
      tie.position.y = 0.1;
      this.hat.add(hair, bun, tie);
    } else {
      // 工作帽：白色帽冠 + 身份色帽带 + 前檐
      const crown = new THREE.Mesh(geo('capCrown', () => new THREE.CylinderGeometry(0.24, 0.26, 0.13, 12)), whiteMat);
      crown.position.y = 0.045;
      crown.castShadow = true;
      const capBand = new THREE.Mesh(geo('capBand', () => new THREE.CylinderGeometry(0.265, 0.265, 0.04, 12)), bandMat);
      capBand.position.y = -0.015;
      const visor = new THREE.Mesh(geo('capVisor', () => new THREE.BoxGeometry(0.3, 0.03, 0.18)), shadeMat);
      visor.position.set(0, -0.02, 0.3);
      this.hat.add(crown, capBand, visor);
    }
    F.add(this.hat);

    // 头顶名字精灵（Sprite 自动面向镜头，任何角度都可读）
    // 高度跟随身高/主厨高帽微调，避免压帽
    this.nameSprite = makeSprite(nameTexture(this.name, '#' + c.getHexString()), 1.1, 0.28);
    this.nameSprite.position.y = 1.45 * look.heightK + (look.head ? 0.22 : 0);
    this.group.add(this.nameSprite);
    // 动作气泡（默认隐藏，单画布重绘复用）
    this.bubble = null;
    this.bubbleText = null;
    // 💭 / 💥 标记精灵（默认隐藏，单画布重绘复用）
    this.mark = null;
    this._markEmoji = null;
  }

  // 动作气泡：单画布重绘复用（同一厨师终身只持有一张 CanvasTexture，换文本只重绘）
  setBubble(text) {
    if (text === this.bubbleText) return;
    this.bubbleText = text;
    if (!text) { if (this.bubble) this.bubble.visible = false; return; }
    if (!this.bubble) {
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = 96;
      this._bubbleG = cv.getContext('2d');
      this._bubbleTex = new THREE.CanvasTexture(cv);
      this._bubbleTex.colorSpace = THREE.SRGBColorSpace;
      this._bubbleTex.anisotropy = 4;
      this.bubble = makeSprite(this._bubbleTex, 1.15, 0.43);
      this.bubble.position.y = 1.86;
      this.group.add(this.bubble);
    }
    drawBubble(this._bubbleG, 256, 96, text);
    this._bubbleTex.needsUpdate = true;
    this.bubble.visible = true;
  }

  // 💭 / 💥 标记：同样单画布重绘复用，emoji 不变时零开销
  setMark(emoji) {
    if (emoji === this._markEmoji) return;
    this._markEmoji = emoji;
    if (!emoji) { if (this.mark) this.mark.visible = false; return; }
    if (!this.mark) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      this._markG = cv.getContext('2d');
      this._markTex = new THREE.CanvasTexture(cv);
      this._markTex.colorSpace = THREE.SRGBColorSpace;
      this.mark = makeSprite(this._markTex, 0.6, 0.6);
      this.mark.position.y = 1.9;
      this.group.add(this.mark);
    }
    const g = this._markG;
    g.clearRect(0, 0, 128, 128);
    g.font = '92px sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(emoji, 64, 70);
    this._markTex.needsUpdate = true;
    this.mark.visible = true;
  }

  // ---------- 行为 API ----------
  placeAt(x, z) {
    this.group.position.set(x, 0, z);
    this.cellPos = { x, z };
  }

  goTo(waypoints, { speed = 3.4, onArrive = null, action = null } = {}) {
    this.cancelWork();
    this.path = waypoints.slice();
    this.speed = speed;
    this.onArrive = onArrive;
    this.arriveAction = action;
    this.state = 'walk';
    this.setMark(null);
  }

  startWork(kind, station, label) {
    this.state = 'work';
    this.workKind = kind;
    this.station = station || null;
    this._ringAcc = 0;
    this._popAcc = 0;
    this.setBubble(label || null);
    this.setMark(null);
    if (kind === 'think') this.setMark('💭'); // 想菜单：翻阅时保留思考标记
    if (station && station.face) {
      const dy = { n: Math.PI, s: 0, e: Math.PI / 2, w: -Math.PI / 2 }[station.face];
      this.faceY = dy;
    }
  }

  think(label) {
    this.cancelWork();
    this.state = 'think';
    this.setMark('💭');
    this.setBubble(label || '思考中');
  }

  // 完工后的间歇：原地歇脚——待机小动作（东张西望/擦汗/颠勺）+ 每隔几秒举杯喝水。
  // 新动作到来时由 goTo/startWork 等经 cancelWork 收杯复位，无需显式 endBreak。
  takeBreak() {
    this.cancelWork();
    this.state = 'break';
    this._breakT = 0;
    this._drinkT = null;
    this._drinkAt = 2 + Math.random() * 3; // 首次喝水 2-5 秒后
    this.setMark(null);
    this.setBubble(null);
  }

  // 小水杯（惰性创建，几何/材质走共享缓存）：挂在右手套处，喝水时随手臂举到嘴边
  _takeCup() {
    if (!this._cup) {
      const cup = new THREE.Mesh(
        geo('cup', () => new THREE.CylinderGeometry(0.05, 0.04, 0.1, 10)),
        mat('cup', () => new THREE.MeshStandardMaterial({ color: 0xF5EBD7, flatShading: true, roughness: 0.9 })),
      );
      cup.position.set(0, -0.26, 0.06);
      this._cup = cup;
      this.armR.add(cup);
    }
    return this._cup;
  }

  // 被队友找上交谈：暂停当前动作，转身面对来人倾听（点头/偶尔抬手回应）。
  // 不打断走位/入场/慌乱中的厨师（由调用方判断 state 后再调）；
  // 睡觉/摘帽坐姿由调用方先 wake()；工位引用清空但特效由渲染器持有，恢复时重发 startWork 即可。
  pauseForChat(x, z) {
    this.state = 'chat';
    this._chatT = 0;
    this.workKind = null;
    this.station = null;
    this.path = [];
    this.setMark(null);
    this.resetPose();
    if (this._zzz) for (const zz of this._zzz) { zz.s.visible = false; zz.t = 99; }
    if (x !== undefined) this.faceTowards(x, z);
  }

  // 交谈结束且没有更早的现场可回时的最小复位（有现场时由渲染器重发 startWork/sleep/…）
  endChat() {
    if (this.state !== 'chat') return;
    this.state = 'rest';
    this.setBubble(null);
    this.resetPose();
  }

  burn(label) {
    this.cancelWork();
    this.state = 'burn';
    this.animT = 0;
    this.setMark('💥');
    this.setBubble(label || '糊了！');
    // 浓烟 + 火星迸发（fx.burnBurst）
    this.fx.burnBurst({ x: this.group.position.x, y: 0.9, z: this.group.position.z });
    this._smokeAcc = 0;
  }

  sleep() {
    this.cancelWork();
    this.state = 'sleep';
    this.setBubble(null);
    this.setMark(null);
    this._zzzAcc = 0;
  }

  sitDone() {
    this.cancelWork();
    this.state = 'sit';
    this.setBubble(null);
    this.setMark(null);
    // 摘帽：帽子放到身旁地上
    this.hat.position.set(0.45, -0.72, 0.1);
    this.hat.rotation.z = 0.5;
  }

  wake() {
    if (this.state === 'sit') {
      this.hat.position.set(0, 0.86, 0);
      this.hat.rotation.z = 0;
    }
    if (this.state === 'sleep' || this.state === 'sit') this.state = 'rest';
  }

  cancelWork() {
    if (this.state === 'sit') this.wake();
    // 离开菜单角：翻起的菜单页复位，避免悬在半空
    if (this.station && this.station.menuHinge) this.station.menuHinge.rotation.z = 0;
    this.workKind = null;
    this.station = null;
    this.path = [];
    this.onArrive = null;
    this._watcher = null; // 「等队友」的观望者随任何动作切换解除
    this._idle.kind = null;
    this._idle.t = 3 + Math.random() * 6;
    this._glance.active = false;
    if (this._cup) this._cup.visible = false; // 歇脚水杯收起
    this._drinkT = null;
    this.resetPose();
    if (this._zzz) for (const zz of this._zzz) { zz.s.visible = false; zz.t = 99; }
  }

  faceTowards(x, z) {
    this.faceY = Math.atan2(x - this.group.position.x, z - this.group.position.z);
  }

  // ---------- 帧更新 ----------
  update(dt) {
    this.animT += dt;
    const t = this.animT;
    const pos = this.group.position;

    // 平滑转身
    let dy = this.faceY - this.group.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.group.rotation.y += dy * Math.min(1, dt * 10);

    // 眼睛：眨眼 + 眼神游移（程序化脸部）
    this._updateEyes(dt);

    switch (this.state) {
      case 'walk': case 'enter': {
        if (!this.path.length) { this._arrive(); break; }
        const wp = this.path[0];
        const dx = wp.x - pos.x, dz = wp.z - pos.z;
        const dist = Math.hypot(dx, dz);
        const step = this.speed * dt;
        if (dist <= step) {
          pos.x = wp.x; pos.z = wp.z;
          this.path.shift();
          if (!this.path.length) { this._arrive(); break; }
        } else {
          pos.x += (dx / dist) * step;
          pos.z += (dz / dist) * step;
          this.faceY = Math.atan2(dx, dz);
        }
        this.cellPos = { x: pos.x, z: pos.z };
        // 小碎步：上下颠簸 + 挤压拉伸 + 手臂前后摆动
        const ph = t * (this.state === 'enter' ? 14 : 11);
        const s = Math.abs(Math.sin(ph));
        pos.y = s * 0.07;
        this.body.scale.set(1 + 0.08 * s, 1 - 0.12 * s, 1 + 0.08 * s);
        this.armL.rotation.x = Math.sin(ph) * 0.55;
        this.armR.rotation.x = -Math.sin(ph) * 0.55;
        // 身后白色小方块烟尘
        this.stepAcc += dt;
        if (this.stepAcc > 0.16) {
          this.stepAcc = 0;
          this.fx.spawn('dust', pos.x - Math.sin(this.faceY) * 0.3, 0.08, pos.z - Math.cos(this.faceY) * 0.3, 0, 0.4, 0, 0.9);
        }
        break;
      }
      case 'work': {
        pos.y = 0;
        const k = this.workKind;
        // 2-4 帧干活循环
        const frame = Math.floor(t / 0.14) % 4;
        if (k === 'edit') { // 切菜：高频小幅抖动 + 彩色菜屑飞溅
          this.body.rotation.x = (frame % 2) * 0.08;
          this.body.position.x = (frame % 2 ? 0.02 : -0.02);
          this.armR.rotation.x = frame % 2 ? -1.6 : -0.4;
          if (frame === 1 && this.station) {
            this.fx.burst('chip', { x: this.station.x, y: this.station.topY + 0.1, z: this.station.z }, 2, 0.9, 0.8);
          }
        } else if (k === 'exec') { // 上灶：翻炒 + 不时蹦出火星
          this.armL.rotation.x = this.armR.rotation.x = -0.9 + Math.sin(t * 9) * 0.35;
          this.body.rotation.x = 0.06 + Math.sin(t * 9) * 0.03;
          this._popAcc += dt;
          if (this._popAcc > 0.5 && this.station) {
            this._popAcc = 0;
            this.fx.spawn('spark',
              this.station.x + (Math.random() - 0.5) * 0.2, this.station.topY + 0.25, this.station.z,
              0, 1.8, 0, 0.9);
          }
        } else if (k === 'search') { // 打电话：听筒举起 + 台面声波圈
          this.armR.rotation.x = -2.4;
          this.body.rotation.z = Math.sin(t * 3) * 0.05;
          pos.y = Math.abs(Math.sin(t * 5)) * 0.02;
          this._ringAcc += dt;
          if (this._ringAcc > 0.85 && this.station) {
            this._ringAcc = 0;
            this.fx.ringWave({ x: this.station.x, y: this.station.topY + 0.06, z: this.station.z }, 3);
          }
        } else if (k === 'tool') { // 高压锅：盯住泄压阀
          this.body.rotation.x = 0.1 + Math.sin(t * 6) * 0.04;
          this.armL.rotation.x = this.armR.rotation.x = -0.5;
        } else if (k === 'read') { // 看菜谱：点头
          this.body.rotation.x = 0.12 + (frame % 2) * 0.05;
          this.armL.rotation.x = this.armR.rotation.x = -0.7;
        } else if (k === 'think') { // 想菜单：低头浏览菜单 + 单手节奏翻页 + 💭 浮动
          this.body.rotation.x = 0.14 + (frame % 2) * 0.04;
          this.armL.rotation.x = -0.7;
          this.armR.rotation.x = -0.9 + Math.sin(t * 1.4) * 0.35;
          if (this.mark) this.mark.position.y = 1.9 + Math.sin(t * 2) * 0.05;
          if (this.station && this.station.menuHinge) {
            this.station.menuHinge.rotation.z = Math.abs(Math.sin(t * 1.4)) * 1.25;
          }
        } else { // speak / serve：喊话
          pos.y = Math.abs(Math.sin(t * 6)) * 0.05;
          this.armL.rotation.x = this.armR.rotation.x = frame % 2 ? -2.2 : -1.8;
        }
        // 有队友在旁边等我：手里的活不停，偶尔回头招手示意（每 ~4.4s 一次 0.7s 小动作）
        if (this._watcher) {
          this._watchT = (this._watchT || 0) + dt;
          const cyc = this._watchT % 4.4;
          if (cyc < 0.7) {
            const s = Math.sin((cyc / 0.7) * Math.PI);
            let ang = Math.atan2(this._watcher.x - pos.x, this._watcher.z - pos.z) - this.group.rotation.y;
            while (ang > Math.PI) ang -= Math.PI * 2;
            while (ang < -Math.PI) ang += Math.PI * 2;
            this.body.rotation.y = ang * 0.55 * s;
            this.armR.rotation.x = -2.2 + Math.sin(cyc * 12) * 0.3 * s;
          }
        }
        this.body.scale.set(1, 1 + Math.sin(t * 8) * 0.03, 1);
        break;
      }
      case 'chat': { // 被队友找上：面对对方倾听——微前倾、周期点头、每 ~3s 抬手回应一下
        pos.y = 0;
        this._chatT = (this._chatT || 0) + dt;
        const ct = this._chatT;
        const nod = Math.max(0, Math.sin(ct * 2.6));
        this.body.rotation.x = 0.04 + nod * 0.08;
        this.body.scale.set(1, 1 + Math.sin(ct * 2.6) * 0.02, 1);
        const cyc = ct % 3.1;
        if (cyc > 2.0) {
          const s = Math.sin(((cyc - 2.0) / 1.1) * Math.PI);
          this.armR.rotation.x = -1.8 * s;
          this.armR.rotation.z = 0.25 * s;
        }
        break;
      }
      case 'think': {
        pos.y = Math.sin(t * 2) * 0.02;
        this.body.scale.set(1, 1 + Math.sin(t * 2) * 0.02, 1);
        this.body.rotation.x = -0.04;
        if (this.mark) this.mark.position.y = 1.9 + Math.sin(t * 2) * 0.05;
        break;
      }
      case 'burn': { // 慌乱原地跳 + 灰烟柱 + 零星火星
        pos.y = Math.abs(Math.sin(t * 12)) * 0.08;
        this.body.rotation.z = Math.sin(t * 12) * 0.1;
        this._smokeAcc += dt;
        if (this._smokeAcc > 0.08) {
          this._smokeAcc = 0;
          this.fx.spawn('smoke', pos.x + (Math.random() - 0.5) * 0.2, 1.0, pos.z + (Math.random() - 0.5) * 0.2, 0, 1.6, 0, 1.2);
          if (Math.random() < 0.3) {
            this.fx.spawn('ember', pos.x + (Math.random() - 0.5) * 0.2, 0.6, pos.z + (Math.random() - 0.5) * 0.2, 0, 2.0, 0, 1);
          }
        }
        break;
      }
      case 'sleep': { // 休息区打瞌睡：呼吸 + z 字漂浮
        const b = Math.sin(t * 1.6);
        this.body.scale.set(1, 1 + b * 0.03, 1);
        this.body.rotation.x = 0.08 + b * 0.02;
        pos.y = 0;
        this._zzzAcc += dt;
        if (this._zzzAcc > 1.1) {
          this._zzzAcc = 0;
          this._spawnZzz();
        }
        this._updateZzz(dt);
        break;
      }
      case 'sit': { // 坐下（摘帽）
        this.body.scale.set(1, 0.72, 1);
        this.body.rotation.x = 0.15;
        pos.y = 0;
        break;
      }
      case 'break': { // 完工间歇：原地呼吸 + 待机小动作，每隔几秒举杯喝水（1.4s）
        pos.y = 0;
        this.body.scale.set(1, 1 + Math.sin(t * 2.2) * 0.02, 1);
        this._breakT += dt;
        if (this._drinkT != null) {
          this._drinkT += dt;
          const u = Math.min(1, this._drinkT / 1.4);
          const s = Math.sin(u * Math.PI);
          this._takeCup().visible = true;
          this.armR.rotation.x = -2.3 * s;   // 举杯到嘴边
          this.armR.rotation.z = 0.12 * s;
          this.body.rotation.x = -0.1 * s;   // 微仰头
          if (this._drinkT >= 1.4) {
            this._drinkT = null;
            this._drinkAt = this._breakT + 4 + Math.random() * 4;
            this._cup.visible = false;
            this.resetPose();
          }
        } else if (this._breakT >= this._drinkAt) {
          this._drinkT = 0;
        } else {
          this._updateIdle(dt); // 东张西望 / 擦汗 / 颠勺
        }
        break;
      }
      default: { // rest 站立：呼吸 + 待机小动作（东张西望/擦汗/颠勺）
        pos.y = 0;
        this.body.scale.set(1, 1 + Math.sin(t * 2.2) * 0.02, 1);
        this._updateIdle(dt);
        break;
      }
    }
    // 名字牌 / 气泡随身体轻轻浮动（名牌为 Sprite，始终面向镜头）
    if (this.bubble) this.bubble.position.y = 1.86 + Math.sin(t * 3) * 0.03;
  }

  // 眼睛：周期性眨眼；休息/思考/打瞌睡时眼神左右游移；打瞌睡眯成一条缝
  _updateEyes(dt) {
    if (!this.eyeGroup) return;
    // 眨眼（sleep 状态常眯眼，跳过眨眼逻辑）
    if (this.state === 'sleep' || this.state === 'sit') {
      this.eyeGroup.scale.y += (0.15 - this.eyeGroup.scale.y) * Math.min(1, dt * 8);
    } else {
      this._blinkT -= dt;
      if (this._blinkT < 0) this._blinkT = 2.5 + Math.random() * 3.5;
      const target = this._blinkT < 0.12 ? 0.12 : 1;
      this.eyeGroup.scale.y += (target - this.eyeGroup.scale.y) * Math.min(1, dt * 22);
    }
    // 眼神游移
    const canGlance = this.state === 'rest' || this.state === 'think' || this.state === 'sleep' || this.state === 'break';
    if (canGlance) {
      this._glance.t -= dt;
      if (this._glance.t <= 0) {
        this._glance.t = 1.4 + Math.random() * 3.0;
        this._glance.active = !this._glance.active || Math.random() < 0.55;
        this._glance.yaw = (Math.random() - 0.5) * 0.9;
      }
    }
    const targetYaw = (canGlance && this._glance.active) ? this._glance.yaw : 0;
    this.eyeGroup.rotation.y += (targetYaw - this.eyeGroup.rotation.y) * Math.min(1, dt * 8);
  }

  // 待机小动作：东张西望 / 擦汗 / 颠勺（仅 rest 状态调用）
  _updateIdle(dt) {
    const I = this._idle;
    if (!I.kind) {
      I.t -= dt;
      if (I.t <= 0) {
        const kinds = ['look', 'look', 'sweat', 'toss']; // 东张西望最常见
        I.kind = kinds[(Math.random() * kinds.length) | 0];
        I.phase = 0;
        this._sweatPopped = false;
        this._tossPopped = 0;
      }
      return;
    }
    const dur = { look: 1.8, sweat: 1.3, toss: 1.5 }[I.kind];
    const u = I.phase / dur;
    I.phase += dt;
    const pos = this.group.position;
    if (I.kind === 'look') {
      // 东张西望：身体左右转动找事做
      this.body.rotation.y = Math.sin(u * Math.PI * 2) * 0.5;
    } else if (I.kind === 'sweat') {
      // 擦汗：右手举到额头来回抹，甩出一滴汗
      this.armR.rotation.x = -2.5 + Math.sin(I.phase * 14) * 0.18;
      this.armR.rotation.z = 0.3;
      this.body.rotation.x = 0.06;
      if (!this._sweatPopped && I.phase > 0.4) {
        this._sweatPopped = true;
        this.fx.spawn('sweat', pos.x + 0.3, 1.0, pos.z, 0.9, 1.4, 0, 0.9);
      }
    } else if (I.kind === 'toss') {
      // 颠勺：蹲起抛锅 + 双手上扬，迸两点火星
      const s = Math.sin(u * Math.PI);
      pos.y = s * 0.12;
      this.armL.rotation.x = this.armR.rotation.x = -0.9 - s * 1.4;
      this.body.rotation.x = 0.08 - s * 0.05;
      if (this._tossPopped < 2 && I.phase > dur * (0.3 + this._tossPopped * 0.35)) {
        this._tossPopped++;
        const fy = this.group.rotation.y;
        this.fx.spawn('spark', pos.x + Math.sin(fy) * 0.45, 1.0, pos.z + Math.cos(fy) * 0.45, 0, 2.2, 0, 1);
      }
    }
    if (I.phase >= dur) {
      I.kind = null;
      I.t = 6 + Math.random() * 8; // 下一个小动作 6-14 秒后
      this.resetPose();
    }
  }

  _arrive() {
    this.state = 'rest';
    this._idle.t = 3 + Math.random() * 7;
    this.resetPose();
    const cb = this.onArrive, act = this.arriveAction;
    this.onArrive = null; this.arriveAction = null;
    if (cb) cb(act);
  }

  _spawnZzz() {
    if (!this._zzz) {
      this._zzz = [];
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const g = cv.getContext('2d');
      g.font = 'bold 46px sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 8; g.strokeStyle = '#2A2138';
      g.strokeText('z', 32, 34);
      g.fillStyle = '#FFFFFF';
      g.fillText('z', 32, 34);
      this._zzzTex = new THREE.CanvasTexture(cv);
      this._zzzTex.colorSpace = THREE.SRGBColorSpace;
      for (let i = 0; i < 3; i++) {
        const s = makeSprite(this._zzzTex, 0.22, 0.22);
        s.visible = false;
        this.group.add(s);
        this._zzz.push({ s, t: 99 });
      }
    }
    const z = this._zzz.find((z) => z.t > 1.4);
    if (z) { z.t = 0; z.s.visible = true; }
  }

  _updateZzz(dt) {
    if (!this._zzz) return;
    for (const zz of this._zzz) {
      zz.t += dt;
      const u = Math.min(1, zz.t / 1.4);
      zz.s.position.set(0.35 + u * 0.25, 1.2 + u * 0.6, 0);
      zz.s.material.opacity = 1 - u;
      if (u >= 1) zz.s.visible = false;
    }
  }

  resetPose() {
    this.body.scale.set(1, 1, 1);
    this.body.rotation.set(0, 0, 0);
    this.body.position.x = 0;
    this.group.position.y = 0;
    this.armL.rotation.set(0, 0, 0);
    this.armR.rotation.set(0, 0, 0);
    if (this.eyeGroup) this.eyeGroup.rotation.y = 0;
  }

  dispose(scene) {
    scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.userData && m.userData.shared) continue; // 共享材质由 disposeShared 统一释放
          if (m.map) m.map.dispose();
          m.dispose();
        }
      }
      // 几何体为共享缓存，由 disposeShared 统一释放
    });
    if (this._zzzTex) this._zzzTex.dispose();
  }

  static disposeShared() {
    for (const k in G) { G[k].dispose(); delete G[k]; }
    for (const k in M) { M[k].dispose(); delete M[k]; }
  }
}
