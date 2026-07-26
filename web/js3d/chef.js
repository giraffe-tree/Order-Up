// 厨师角色：二头身 Q 版（大厨帽≈身体体积）、名字精灵、动作气泡、动画状态机
// 个性系统：待机小动作（东张西望/擦汗/颠勺）、走路手臂摆动、程序化眼睛（眼神/眨眼/眯眼）
// 名牌使用 THREE.Sprite —— 天然始终面向镜头
import * as THREE from '../vendor/three.module.min.js';
import { PAL } from './palette.js';
import { nameTexture, bubbleTexture, makeSprite } from './textures.js';

// ---------- 共享几何体 ----------
const G = {};
function geo(key, make) { return G[key] || (G[key] = make()); }

const WORK_KINDS = new Set(['read', 'edit', 'exec', 'search', 'tool', 'speak', 'serve']);

export class ChefActor {
  constructor(chef, fx) {
    this.id = chef.id;
    this.name = chef.name || '厨师';
    this.fx = fx;
    this.color = new THREE.Color(chef.color || '#447EE0');
    this.group = new THREE.Group();
    this.state = 'enter';        // enter|walk|work|think|burn|sleep|sit|rest
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
    this._build();
  }

  _build() {
    const c = this.color;
    const bodyMat = new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.9 });
    const apronMat = new THREE.MeshStandardMaterial({
      color: c.clone().lerp(new THREE.Color(0xFFFFFF), 0.35), flatShading: true, roughness: 0.9,
    });
    const whiteMat = new THREE.MeshStandardMaterial({ color: PAL.hat, flatShading: true, roughness: 0.95 });
    const shadeMat = new THREE.MeshStandardMaterial({ color: PAL.hatShade, flatShading: true, roughness: 0.95 });
    const skinMat = new THREE.MeshStandardMaterial({ color: PAL.skin, flatShading: true, roughness: 0.9 });

    // 脚下圆环（chef.color）
    const ring = new THREE.Mesh(
      geo('ring', () => new THREE.RingGeometry(0.42, 0.52, 24)),
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    this.group.add(ring);

    // 身体圆柱（chef.color）
    this.body = new THREE.Group();
    this.group.add(this.body);
    const torso = new THREE.Mesh(geo('torso', () => new THREE.CylinderGeometry(0.26, 0.3, 0.55, 14)), bodyMat);
    torso.position.y = 0.36;
    torso.castShadow = true;
    this.body.add(torso);
    // 围裙（chef.color 提亮）
    const apron = new THREE.Mesh(geo('apron', () => new THREE.BoxGeometry(0.3, 0.35, 0.04)), apronMat);
    apron.position.set(0, 0.34, 0.26);
    this.body.add(apron);
    // 脸
    const face = new THREE.Mesh(geo('face', () => new THREE.SphereGeometry(0.17, 12, 10)), skinMat);
    face.position.set(0, 0.72, 0.1);
    face.castShadow = true;
    this.body.add(face);
    // 眼睛组：整体可左右转动（眼神朝向）、scale.y 压缩做眨眼/眯眼
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x2A2138 });
    const hlMat = new THREE.MeshBasicMaterial({ color: 0xFFFDF6 });
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
    this.body.add(this.eyeGroup);
    // 手臂 + 白手套
    this.armL = new THREE.Group(); this.armR = new THREE.Group();
    this.armL.position.set(-0.3, 0.52, 0); this.armR.position.set(0.3, 0.52, 0);
    for (const [arm, sx] of [[this.armL, -1], [this.armR, 1]]) {
      const limb = new THREE.Mesh(geo('limb', () => new THREE.CylinderGeometry(0.05, 0.05, 0.22, 8)), bodyMat);
      limb.position.y = -0.1;
      const hand = new THREE.Mesh(geo('hand', () => new THREE.SphereGeometry(0.09, 8, 6)),
        new THREE.MeshStandardMaterial({ color: PAL.glove, flatShading: true, roughness: 0.9 }));
      hand.position.y = -0.24;
      hand.castShadow = true;
      arm.add(limb, hand);
      this.body.add(arm);
    }
    // 深色小鞋尖 ×2
    const shoeMat = new THREE.MeshStandardMaterial({ color: PAL.shoe, flatShading: true, roughness: 0.9 });
    for (const dx of [-0.12, 0.12]) {
      const shoe = new THREE.Mesh(geo('shoe', () => new THREE.BoxGeometry(0.13, 0.08, 0.2)), shoeMat);
      shoe.position.set(dx, 0.04, 0.04);
      this.body.add(shoe);
    }
    // 厨师帽：帽檐圆柱 + 白色圆顶（体积≈身体）
    this.hat = new THREE.Group();
    this.hat.position.y = 0.86;
    const brim = new THREE.Mesh(geo('brim', () => new THREE.CylinderGeometry(0.3, 0.3, 0.14, 14)), whiteMat);
    brim.castShadow = true;
    const band = new THREE.Mesh(geo('band', () => new THREE.CylinderGeometry(0.305, 0.305, 0.05, 14)),
      new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.9 }));
    band.position.y = -0.06;
    const shade = new THREE.Mesh(geo('hatShade', () => new THREE.CylinderGeometry(0.28, 0.3, 0.03, 14)), shadeMat);
    shade.position.y = -0.085;
    const dome = new THREE.Mesh(geo('dome', () => new THREE.SphereGeometry(0.32, 14, 10)), whiteMat);
    dome.scale.set(1, 0.78, 1);
    dome.position.y = 0.18;
    dome.castShadow = true;
    this.hat.add(brim, band, shade, dome);
    this.body.add(this.hat);

    // 头顶名字精灵（Sprite 自动面向镜头，任何角度都可读）
    this.nameSprite = makeSprite(nameTexture(this.name, '#' + c.getHexString()), 1.1, 0.28);
    this.nameSprite.position.y = 1.45;
    this.group.add(this.nameSprite);
    // 动作气泡（默认隐藏）
    this.bubble = null;
    this.bubbleText = null;
    // 💭 / 💥 标记精灵
    this.mark = null;
  }

  setBubble(text) {
    if (text === this.bubbleText) return;
    this.bubbleText = text;
    if (this.bubble) {
      this.bubble.material.map.dispose();
      this.bubble.material.dispose();
      this.group.remove(this.bubble);
      this.bubble = null;
    }
    if (text) {
      this.bubble = makeSprite(bubbleTexture(text), 1.15, 0.43);
      this.bubble.position.y = 1.86;
      this.group.add(this.bubble);
    }
  }

  setMark(emoji) {
    if (this.mark) {
      this.mark.material.map.dispose();
      this.mark.material.dispose();
      this.group.remove(this.mark);
      this.mark = null;
    }
    if (emoji) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      const g = cv.getContext('2d');
      g.font = '92px sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(emoji, 64, 70);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.mark = makeSprite(tex, 0.6, 0.6);
      this.mark.position.y = 1.9;
      this.group.add(this.mark);
    }
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
    this.workKind = null;
    this.station = null;
    this.path = [];
    this.onArrive = null;
    this._idle.kind = null;
    this._idle.t = 3 + Math.random() * 6;
    this._glance.active = false;
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
        } else { // speak / serve：喊话
          pos.y = Math.abs(Math.sin(t * 6)) * 0.05;
          this.armL.rotation.x = this.armR.rotation.x = frame % 2 ? -2.2 : -1.8;
        }
        this.body.scale.set(1, 1 + Math.sin(t * 8) * 0.03, 1);
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
    const canGlance = this.state === 'rest' || this.state === 'think' || this.state === 'sleep';
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
        for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
      }
      // 几何体为共享缓存，由 disposeShared 统一释放
    });
    if (this._zzzTex) this._zzzTex.dispose();
  }

  static disposeShared() {
    for (const k in G) { G[k].dispose(); delete G[k]; }
  }
}
