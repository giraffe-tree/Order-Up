// 粒子 / 特效系统：共享几何体 + 固定容量对象池，单入口 update
// 粒子：chop/dust/steam/smoke/flame/spark/ember/sweat/chip/confetti
// 额外特效：出餐飞菜 + 彩纸星星庆祝、糊了浓烟火星、电话台声波圈（全部走对象池，无每帧分配）
import * as THREE from '../vendor/three.module.min.js';
import { PAL } from './palette.js';
import { drawPlank } from './textures.js';
import { dishLook } from './dishes.js';

const MAX_PARTICLES = 420;
const MAX_STARS = 12;   // 出餐庆祝星星池
const MAX_RINGS = 8;    // 电话声波圈池
const MAX_POPUPS = 6;   // 弹出文字精灵池（canvas 重绘复用，不再每次新建纹理）
const MAX_FLYERS = 4;   // 飞菜池（盘子+菜品网格复用）

const KINDS = {
  chop:   { color: 0xFFFFFF, grav: -6.0, drag: 0.92, life: 0.55, size: 0.075, spin: 8 },
  chip:   { color: 0x58B24C, grav: -6.0, drag: 0.92, life: 0.50, size: 0.065, spin: 10 }, // 彩色菜屑（多色材质）
  dust:   { color: PAL.dust, grav: 0.6,  drag: 0.90, life: 0.55, size: 0.11, spin: 4 },  // 白色小方块烟尘
  steam:  { color: 0xF6F2E8, grav: 1.3,  drag: 0.96, life: 1.35, size: 0.12, spin: 2 },  // 更蓬更慢的蒸汽
  smoke:  { color: PAL.smoke, grav: 2.0, drag: 0.97, life: 1.70, size: 0.15, spin: 2 },
  flame:  { color: PAL.flame, grav: 2.6, drag: 0.94, life: 0.55, size: 0.10, spin: 6 },
  spark:  { color: PAL.flameCore, grav: 0.4, drag: 0.92, life: 0.45, size: 0.06, spin: 10 },
  ember:  { color: 0xFFB03A, grav: -2.2, drag: 0.96, life: 0.85, size: 0.05, spin: 12 }, // 糊了迸出的火星
  sweat:  { color: 0x7FC7D4, grav: -5.5, drag: 0.96, life: 0.60, size: 0.055, spin: 6 }, // 擦汗甩出的汗滴
  confetti:{ color: 0xF2C230, grav: -3.2, drag: 0.965, life: 1.50, size: 0.075, spin: 9 }, // 出餐彩纸（多色材质）
};

// 出场弹性（squash & stretch 的「弹出来」一拍）：0→1 带轻微过冲
function easeOutBack(x) {
  const c = 1.70158, u = x - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}
// 出生即弹性放大的粒子种类（蒸汽/烟靠 grow 曲线，不叠加）
const POP_KINDS = { chop: 1, chip: 1, dust: 1, confetti: 1, ember: 1 };

// 多色粒子材质（切菜飞屑 / 出餐彩纸），spawn 时随机挑一个
const MULTI_COLORS = {
  chip:     [0x58B24C, 0xD94F3D, 0xF2C230, 0xF57B4A],  // 菜叶绿 / 番茄红 / 蛋黄 / 胡萝卜橙
  confetti: [0xE0473C, 0xF2C230, 0x58B24C, 0xF57B4A, 0xF8E16C, 0xF5EBD7],
};

// 五角星挤出几何体（出餐庆祝）
function makeStarGeo() {
  const shape = new THREE.Shape();
  const R = 0.1, r = 0.045;
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rad = i % 2 ? r : R;
    const px = Math.cos(a) * rad, py = Math.sin(a) * rad;
    if (i) shape.lineTo(px, py); else shape.moveTo(px, py);
  }
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: 0.035, bevelEnabled: false });
}

// ---------- 盘中餐构建器（fx 飞菜盘 / dining 餐厅餐盘共用） ----------
// 几何体按形状缓存（单位尺寸、实例只做缩放），材质按颜色缓存；
// 小菜件只在出餐/上菜等低频时刻重建，update 里零分配。
const DISH_GEO = {};
const DISH_MAT = {};
function dishGeo(key, make) { return DISH_GEO[key] || (DISH_GEO[key] = make()); }
function dishMat(color) {
  return DISH_MAT[color] || (DISH_MAT[color] = new THREE.MeshStandardMaterial({
    color, flatShading: true, roughness: 0.9, metalness: 0,
  }));
}

// 共享资产统一清理（fx / dining 任一方 dispose 都可调用；清空键值重复调用安全）
export function disposeDishCache() {
  for (const k in DISH_GEO) { DISH_GEO[k].dispose(); delete DISH_GEO[k]; }
  for (const k in DISH_MAT) { DISH_MAT[k].dispose(); delete DISH_MAT[k]; }
}

// 按 dishLook(name) 的视觉元数据拼一盘低模菜：返回 Group，底面对齐盘面（y=0）。
// plateR 适配盘径（飞菜盘 ≈0.26 / 餐厅盘 ≈0.2）；件上 sharedDish 标记共享资产，容器 dispose 时跳过。
export function buildDishFood(look, plateR = 0.2) {
  const g = new THREE.Group();
  const k = plateR / 0.2; // 尺寸系数：以餐厅盘 r=0.2 为基准
  const main = dishMat(look.colors[0]);
  const accent = dishMat(look.colors[1]);
  const add = (m, x, y, z, ry = 0) => { // 坐标以基准盘为 1 计，统一乘 k
    m.userData.sharedDish = true;
    m.position.set(x * k, y * k, z * k);
    m.rotation.y = ry;
    g.add(m);
    return m;
  };
  const bx = (w, h, d, mt) => { // 单位盒缩放件
    const m = new THREE.Mesh(dishGeo('box', () => new THREE.BoxGeometry(1, 1, 1)), mt);
    m.scale.set(w * k, h * k, d * k);
    return m;
  };
  const ball = (sx, sy, sz, mt) => { // 单位球缩放件
    const m = new THREE.Mesh(dishGeo('ball', () => new THREE.SphereGeometry(1, 10, 8)), mt);
    m.scale.set(sx * k, sy * k, sz * k);
    return m;
  };
  switch (look.shape) {
    case 'strips': { // 条状：4–5 根主色细长条交错 + 1–2 根配色条
      const angs = [-0.5, 0.25, -0.15, 0.6, 0.05];
      angs.forEach((a, i) => {
        add(bx(0.05, 0.04, 0.26, main), (i % 2 ? 0.03 : -0.03), 0.022 + (i % 3) * 0.03, (i - 2) * 0.03, a);
      });
      add(bx(0.045, 0.035, 0.2, accent), 0.02, 0.11, -0.02, -0.35);
      add(bx(0.045, 0.035, 0.18, accent), -0.03, 0.125, 0.04, 0.45);
      break;
    }
    case 'greens': { // 叶菜：3–4 片压扁叶片 + 浅色菜梗
      const angs = [0.2, 1.3, 2.4, 3.6];
      angs.forEach((a, i) => {
        const leaf = add(bx(0.16, 0.02, 0.1, main), Math.cos(a) * 0.05, 0.03 + i * 0.018, Math.sin(a) * 0.05, a);
        leaf.rotation.x = i % 2 ? 0.18 : -0.12;
      });
      add(bx(0.04, 0.03, 0.15, accent), 0.02, 0.03, 0, 0.5);
      add(bx(0.04, 0.03, 0.13, accent), -0.03, 0.05, 0.02, -0.4);
      break;
    }
    case 'fish': { // 整鱼：椭圆压扁鱼身 + 三角尾 + 配色细丝（葱丝）
      add(ball(0.15, 0.05, 0.075, main), 0.01, 0.045, 0); // 鱼身
      const tail = new THREE.Mesh(dishGeo('cone4', () => new THREE.ConeGeometry(1, 1, 4)), main);
      tail.scale.set(0.06 * k, 0.09 * k, 0.02 * k);
      tail.rotation.z = Math.PI / 2; // 尖端转向 -x 当尾巴
      add(tail, -0.17, 0.045, 0);
      for (const dz of [-0.03, 0, 0.03]) { // 葱丝三根横搭鱼背
        add(bx(0.16, 0.012, 0.014, accent), 0.01, 0.095, dz, 0.25);
      }
      break;
    }
    case 'rice': { // 饭山：半球饭团（下半没入盘中）+ 顶面几粒配色小方块
      add(ball(0.13, 0.1, 0.13, main), 0, 0, 0);
      add(bx(0.035, 0.03, 0.035, accent), -0.04, 0.085, 0.02, 0.4);
      add(bx(0.035, 0.03, 0.035, accent), 0.045, 0.075, -0.03, 1.1);
      add(bx(0.03, 0.028, 0.03, accent), 0.01, 0.095, 0.05, 0.8);
      break;
    }
    case 'chunks': { // 块状：4–6 枚主色小方块 + 2 枚配色小块堆在盘中
      const ring = [[-0.075, -0.05], [0.07, -0.06], [-0.06, 0.065], [0.065, 0.06]];
      ring.forEach((p, i) => {
        const s = 0.08 + (i % 2) * 0.015;
        add(bx(s, 0.07, s, main), p[0], 0.035, p[1], i * 0.7);
      });
      add(bx(0.075, 0.065, 0.075, main), 0.005, 0.1, -0.01, 0.4); // 顶层再压一枚
      add(bx(0.05, 0.045, 0.05, accent), -0.04, 0.095, 0.03, 0.9);
      add(bx(0.045, 0.04, 0.045, accent), 0.05, 0.09, -0.045, 1.4);
      break;
    }
    default: { // soup 汤类（含未知形状兜底）：盘内一圈汤面（扁圆柱）+ 表面 2–3 块配色小方块
      const disc = new THREE.Mesh(dishGeo('disc', () => new THREE.CylinderGeometry(1, 1, 1, 14)), main);
      disc.scale.set(0.15 * k, 0.035 * k, 0.15 * k);
      add(disc, 0, 0.018, 0);
      add(bx(0.045, 0.03, 0.045, accent), -0.05, 0.045, 0.03, 0.5);
      add(bx(0.04, 0.028, 0.04, accent), 0.05, 0.045, -0.04, 1.2);
      add(bx(0.035, 0.026, 0.035, accent), 0.02, 0.045, 0.06, 0.9);
      break;
    }
  }
  return g;
}

export class FX {
  constructor(scene) {
    this.scene = scene;
    this.geo = new THREE.BoxGeometry(1, 1, 1); // 共享几何体
    this.mats = {};
    for (const k in KINDS) {
      this.mats[k] = new THREE.MeshStandardMaterial({
        color: KINDS[k].color, flatShading: true, roughness: 1, metalness: 0,
      });
    }
    this._multi = {};
    for (const k in MULTI_COLORS) {
      this._multi[k] = MULTI_COLORS[k].map((c) => new THREE.MeshStandardMaterial({
        color: c, flatShading: true, roughness: 1, metalness: 0,
      }));
    }
    this.pool = [];
    this.live = [];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const m = new THREE.Mesh(this.geo, this.mats.dust);
      m.visible = false;
      m.castShadow = false;
      scene.add(m);
      this.pool.push(m);
    }
    this.emitters = [];   // { x,y,z, kind, rate, acc, on, follow? }
    this.flyers = [];     // 飞菜
    this.popups = [];     // 弹出文字精灵
    this._dishGeo = new THREE.CylinderGeometry(0.26, 0.22, 0.05, 14);
    this._dishMat = new THREE.MeshStandardMaterial({ color: PAL.plate, flatShading: true, roughness: 0.8 });

    // 出餐庆祝星星：固定容量对象池
    this._starGeo = makeStarGeo();
    this._starMat = new THREE.MeshStandardMaterial({
      color: PAL.flameCore, flatShading: true, roughness: 0.7,
      emissive: 0x8A6A1A, emissiveIntensity: 0.35,
    });
    this._starPool = [];
    this._starLive = [];
    for (let i = 0; i < MAX_STARS; i++) {
      const m = new THREE.Mesh(this._starGeo, this._starMat);
      m.visible = false;
      m.castShadow = false;
      scene.add(m);
      this._starPool.push(m);
    }

    // 电话声波圈：固定容量对象池（每圈独立材质以分别控制透明度）
    this._ringGeo = new THREE.RingGeometry(0.42, 0.5, 28);
    this._ringPool = [];
    this._ringLive = [];
    for (let i = 0; i < MAX_RINGS; i++) {
      const m = new THREE.Mesh(this._ringGeo, new THREE.MeshBasicMaterial({
        color: PAL.red, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
      }));
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      scene.add(m);
      this._ringPool.push(m);
    }

    // 弹出文字精灵池：固定 6 个，各自持有持久 canvas + CanvasTexture，
    // 每次弹出只重绘 canvas（tex.needsUpdate），零纹理分配/销毁
    this._popupAll = [];
    this._popupPool = [];
    for (let i = 0; i < MAX_POPUPS; i++) {
      const cv = document.createElement('canvas');
      cv.width = 360; cv.height = 96;
      const g2d = cv.getContext('2d');
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      const s = new THREE.Sprite(mat);
      s.scale.set(1.8, 0.48, 1);
      s.visible = false;
      scene.add(s);
      const entry = { s, tex, cv, g: g2d };
      this._popupAll.push(entry);
      this._popupPool.push(entry);
    }

    // 飞菜池：盘子网格复用，菜品按菜名重建（出餐低频；共享几何/材质，无每帧分配）
    this._flyerAll = [];
    this._flyerPool = [];
    for (let i = 0; i < MAX_FLYERS; i++) {
      const g = new THREE.Group();
      const plate = new THREE.Mesh(this._dishGeo, this._dishMat);
      g.add(plate);
      g.visible = false;
      scene.add(g);
      const entry = { g, food: null };
      this._flyerAll.push(entry);
      this._flyerPool.push(entry);
    }
  }

  spawn(kind, x, y, z, vx = 0, vy = 0, vz = 0, scale = 1) {
    const m = this.pool.pop();
    if (!m) return;
    const k = KINDS[kind];
    const multi = this._multi[kind];
    m.material = multi ? multi[(Math.random() * multi.length) | 0] : this.mats[kind];
    m.position.set(x, y, z);
    m.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    m.visible = true;
    this.live.push({
      m, kind, t: 0, life: k.life * (0.75 + Math.random() * 0.5),
      vx: vx + (Math.random() - 0.5) * 0.6,
      vy: vy + Math.random() * 0.4,
      vz: vz + (Math.random() - 0.5) * 0.6,
      size: k.size * scale * (0.7 + Math.random() * 0.6),
      spin: k.spin,
      phase: Math.random() * Math.PI * 2,
    });
  }

  burst(kind, pos, n, speed = 1.6, scale = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spawn(kind, pos.x, pos.y, pos.z,
        Math.cos(a) * speed * Math.random(),
        speed * (0.4 + Math.random() * 0.8),
        Math.sin(a) * speed * Math.random(), scale);
    }
  }

  addEmitter(e) { this.emitters.push({ acc: 0, on: true, rate: 6, ...e }); return this.emitters[this.emitters.length - 1]; }

  // 糊了：大团浓烟 + 向上迸火星 + 一记白色小方块爆点（供 ChefActor.burn 调用）
  burnBurst(pos) {
    this.burst('smoke', { x: pos.x, y: pos.y, z: pos.z }, 14, 1.3, 1.5);
    this.burst('ember', { x: pos.x, y: pos.y - 0.25, z: pos.z }, 9, 2.0, 1);
    this.burst('dust', { x: pos.x, y: pos.y + 0.1, z: pos.z }, 7, 2.2, 1.2);
  }

  // 出餐庆祝：彩纸雨 + 弹跳星星（对象池）
  celebrate(pos) {
    this.burst('confetti', pos, 16, 2.4, 1);
    for (let i = 0; i < 5; i++) {
      const m = this._starPool.pop();
      if (!m) return;
      m.position.set(
        pos.x + (Math.random() - 0.5) * 0.6,
        pos.y + Math.random() * 0.3,
        pos.z + (Math.random() - 0.5) * 0.6,
      );
      m.rotation.set(0, Math.random() * Math.PI, 0);
      m.scale.setScalar(1);
      m.visible = true;
      this._starLive.push({
        m, t: 0, life: 1.0 + Math.random() * 0.3,
        vy: 1.6 + Math.random() * 0.8, spin: 5 + Math.random() * 4,
      });
    }
  }

  // 电话台声波圈：从台面扩散的圆环，错相位连发 n 圈（对象池）
  ringWave(pos, n = 3) {
    for (let i = 0; i < n; i++) {
      const m = this._ringPool.pop();
      if (!m) return;
      m.position.set(pos.x, pos.y, pos.z);
      m.visible = false; // 负 t 相位延迟，到点才显示
      this._ringLive.push({ m, t: -i * 0.22, life: 0.85 });
    }
  }

  // 出餐仪式：热气腾腾的菜从厨师处抛物线飞向出餐口窗口，
  // 落点弹出菜名（≤24 字，超长自动缩字号）+ 彩纸星星庆祝。飞菜/弹字全走对象池。
  dishServed(from, to, name) {
    const entry = this._flyerPool.pop();
    if (!entry) return; // 池满：跳过本次飞行（高频出餐不堆积、不分配）
    // 按菜名重建盘中餐（低频 spawn 时刻；几何/材质走共享缓存）
    if (entry.food) entry.g.remove(entry.food);
    entry.food = buildDishFood(dishLook(name), 0.26);
    entry.food.position.y = 0.03;
    entry.food.rotation.y = Math.random() * Math.PI;
    entry.g.add(entry.food);
    entry.g.position.copy(from);
    entry.g.rotation.set(0, 0, 0);
    entry.g.scale.setScalar(1);
    entry.g.visible = true;
    const dest = to || { x: from.x, y: from.y, z: from.z - 3 };
    const dist = Math.hypot(dest.x - from.x, dest.z - from.z);
    this.flyers.push({
      f: entry, t: 0, life: 1.1,
      sx: from.x, sy: from.y, sz: from.z,
      ex: dest.x, ey: dest.y, ez: dest.z,
      arc: 0.7 + Math.min(1.3, dist * 0.16), // 抛物线拱高随距离
      spin: 7 + Math.random() * 4,
      steamAcc: 0,
      name: name || '神秘料理',
    });
  }

  // 弹出文字（对象池）：重绘池内精灵的 canvas 后上屏；池满时回收最老在播弹字
  popup(text, pos, color = '#D94F3D', life = 1.4) {
    let entry = this._popupPool.pop();
    if (!entry) {
      const oldest = this.popups.shift();
      if (!oldest) return;
      entry = oldest.p;
    }
    drawPlank(entry.g, entry.cv.width, entry.cv.height, text,
      { fontSize: 44, bg: '#F5EBD7', fg: color, maxChars: 7, maxLen: 24 });
    entry.tex.needsUpdate = true;
    entry.s.position.copy(pos);
    entry.s.material.opacity = 1;
    entry.s.visible = true;
    this.popups.push({ p: entry, t: 0, life });
  }

  update(dt) {
    // 发射器
    for (const e of this.emitters) {
      if (!e.on) continue;
      e.acc += dt * e.rate;
      const p = e.follow ? e.follow() : e;
      while (e.acc >= 1) {
        e.acc -= 1;
        this.spawn(e.kind, p.x + (Math.random() - 0.5) * (e.jitter || 0.2), p.y, p.z + (Math.random() - 0.5) * (e.jitter || 0.2),
          0, e.vy || 0.5, 0, e.scale || 1);
      }
    }
    // 粒子
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.t += dt;
      const k = KINDS[p.kind];
      if (p.t >= p.life) {
        p.m.visible = false;
        this.pool.push(p.m);
        this.live.splice(i, 1);
        continue;
      }
      p.vy += k.grav * dt * (k.grav > 0 ? 0.4 : 1); // 上升类减速、下落类加速
      p.vx *= k.drag; p.vy *= k.drag; p.vz *= k.drag;
      p.m.position.x += p.vx * dt;
      p.m.position.y += p.vy * dt;
      p.m.position.z += p.vz * dt;
      p.m.rotation.x += p.spin * dt;
      p.m.rotation.y += p.spin * 0.7 * dt;
      const u = 1 - p.t / p.life;
      // 蒸汽/烟：先长大再缩；其余直接缩小
      const grow = (p.kind === 'steam' || p.kind === 'smoke') ? (0.6 + 0.8 * (p.t / p.life)) : 1;
      let s = p.size * u * grow;
      // 出生一拍弹性放大（过冲回弹，Q 弹感）
      if (POP_KINDS[p.kind] && p.t < 0.1) s *= easeOutBack(p.t / 0.1);
      // 火苗/火星快速闪动（跳动）
      if (p.kind === 'flame' || p.kind === 'ember' || p.kind === 'spark') {
        s *= 0.72 + 0.48 * Math.abs(Math.sin(p.t * 22 + p.phase));
      }
      // 蒸汽左右轻摆，更「蓬」
      if (p.kind === 'steam') {
        p.m.position.x += Math.sin(p.t * 2.6 + p.phase) * 0.12 * dt;
      }
      // 彩纸左右飘摆
      if (p.kind === 'confetti') {
        p.m.position.x += Math.sin(p.t * 9 + p.phase) * 0.5 * dt;
      }
      p.m.scale.setScalar(Math.max(0.001, s));
    }
    // 出餐星星
    for (let i = this._starLive.length - 1; i >= 0; i--) {
      const st = this._starLive[i];
      st.t += dt;
      const u = st.t / st.life;
      if (u >= 1) {
        st.m.visible = false;
        this._starPool.push(st.m);
        this._starLive.splice(i, 1);
        continue;
      }
      st.m.position.y += st.vy * dt * (1 - u * 0.7);
      st.m.rotation.y += st.spin * dt;
      // 出生弹性放大，随后平方缩小消失
      const pop = st.t < 0.1 ? easeOutBack(st.t / 0.1) : 1;
      st.m.scale.setScalar(Math.max(0.001, (1 - u * u) * pop));
    }
    // 电话声波圈
    for (let i = this._ringLive.length - 1; i >= 0; i--) {
      const r = this._ringLive[i];
      r.t += dt;
      if (r.t < 0) continue; // 相位延迟中
      r.m.visible = true;
      const u = r.t / r.life;
      if (u >= 1) {
        r.m.visible = false;
        r.m.material.opacity = 0;
        this._ringPool.push(r.m);
        this._ringLive.splice(i, 1);
        continue;
      }
      r.m.scale.setScalar(0.3 + u * 2.6);
      r.m.material.opacity = 0.65 * (1 - u);
    }
    // 飞菜：厨师处 → 出餐口抛物线，全程蒸汽尾迹；落点弹菜名 + 彩纸星星
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const fl = this.flyers[i];
      fl.t += dt;
      const g = fl.f.g;
      if (fl.t >= fl.life) {
        g.visible = false;
        this._flyerPool.push(fl.f);
        this.flyers.splice(i, 1);
        // 落点：白色烟尘「噗」一记 + 菜名弹字（≤24 字）+ 庆祝彩纸星星
        this.burst('dust', { x: fl.ex, y: fl.ey + 0.08, z: fl.ez }, 7, 1.5, 1);
        this.popup(fl.name, new THREE.Vector3(fl.ex, fl.ey + 0.55, fl.ez + 0.35), '#D94F3D');
        this.celebrate(new THREE.Vector3(fl.ex, fl.ey + 0.15, fl.ez + 0.25));
        continue;
      }
      const u = fl.t / fl.life;
      g.position.x = fl.sx + (fl.ex - fl.sx) * u;
      g.position.z = fl.sz + (fl.ez - fl.sz) * u;
      g.position.y = fl.sy + (fl.ey - fl.sy) * u + Math.sin(u * Math.PI) * fl.arc;
      g.rotation.y += fl.spin * dt;
      // squash & stretch：起跳压扁蹬地 → 空中舒展 → 落地前再压扁蓄势
      let sy = 1, sxz = 1;
      if (u < 0.14) { const k = 1 - u / 0.14; sy = 1 - 0.26 * k; sxz = 1 + 0.22 * k; }
      else if (u > 0.86) { const k = (u - 0.86) / 0.14; sy = 1 - 0.3 * k; sxz = 1 + 0.26 * k; }
      g.scale.set(sxz, sy, sxz);
      // 热气腾腾：飞行沿途冒蒸汽
      fl.steamAcc += dt;
      if (fl.steamAcc > 0.05) {
        fl.steamAcc = 0;
        this.spawn('steam',
          g.position.x + (Math.random() - 0.5) * 0.1, g.position.y + 0.06, g.position.z + (Math.random() - 0.5) * 0.1,
          0, 0.6, 0, 0.9);
      }
    }
    // 弹出字（池化精灵：上升 + 尾段淡出，结束归还池）
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.t += dt;
      if (p.t >= p.life) {
        p.p.s.visible = false;
        this._popupPool.push(p.p);
        this.popups.splice(i, 1);
        continue;
      }
      const u = p.t / p.life;
      p.p.s.position.y += dt * 0.9;
      p.p.s.material.opacity = u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
    }
  }

  dispose() {
    for (const m of this.pool) this.scene.remove(m);
    for (const p of this.live) this.scene.remove(p.m);
    for (const e of this._flyerAll) this.scene.remove(e.g);
    for (const e of this._popupAll) { e.tex.dispose(); e.s.material.dispose(); this.scene.remove(e.s); }
    for (const m of this._starPool) this.scene.remove(m);
    for (const st of this._starLive) this.scene.remove(st.m);
    for (const m of this._ringPool) { m.material.dispose(); this.scene.remove(m); }
    for (const r of this._ringLive) { r.m.material.dispose(); this.scene.remove(r.m); }
    this.pool = []; this.live = []; this.flyers = []; this.popups = []; this.emitters = [];
    this._starPool = []; this._starLive = []; this._ringPool = []; this._ringLive = [];
    this._flyerAll = []; this._flyerPool = []; this._popupAll = []; this._popupPool = [];
    this.geo.dispose();
    for (const k in this.mats) this.mats[k].dispose();
    for (const k in this._multi) for (const mt of this._multi[k]) mt.dispose();
    this._dishGeo.dispose(); this._dishMat.dispose();
    disposeDishCache(); // 盘中餐共享几何/材质
    this._starGeo.dispose(); this._starMat.dispose();
    this._ringGeo.dispose();
  }
}
