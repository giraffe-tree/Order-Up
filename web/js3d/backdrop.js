// 厨房外氛围背景：黄昏天空穹顶（星 / 薄云 / 弯月）、地面夜色渐晕、木栅栏、
// 路灯（假光源：自发光 + 光晕精灵 + 贴地光池）、灌木、板条箱杂物、
// 远景剪影（山丘 / 松树 / 亮窗小屋）、萤火虫。
// 全部程序化低模，几何体 / 材质走共享缓存，重复构件合并成单次 draw call；
// scene 级一次性构建（不随 setKitchen 重建）；update(t) 只做数学摆动，零每帧分配。
// buildBackdrop(scene) → { group, update(t), setDim(d), dispose() }
import * as THREE from '../vendor/three.module.min.js';
import { PAL } from './palette.js';
import { skyDomeTexture, glowDiscTexture } from './textures.js';

const GY = -0.12; // 外地面上表面高度（与 stations.js 外圈地面一致）

// ---------- 共享几何体 / 材质缓存 ----------
const GEO = {};
const MAT = {};
function geo(key, make) { return GEO[key] || (GEO[key] = make()); }
function mat(key, color, opts = {}) {
  return MAT[key] || (MAT[key] = new THREE.MeshStandardMaterial({
    color, flatShading: true, roughness: opts.roughness ?? 0.95, metalness: 0,
    emissive: opts.emissive || 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 1,
  }));
}

// 确定性伪随机（与 textures.js 同算法，局部复刻避免跨模块依赖内部函数）
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 几何合并：若干「几何体 + 变换」拼成一个 BufferGeometry（降 draw call） ----------
function trs(x, y, z, rotY = 0, sx = 1, sy = sx, sz = sx) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0)),
    new THREE.Vector3(sx, sy, sz));
}
function mergeGeoms(items) {
  let vCount = 0, iCount = 0;
  const parts = items.map(({ g, m }) => {
    const c = g.clone().applyMatrix4(m);
    vCount += c.attributes.position.count;
    iCount += c.index ? c.index.count : c.attributes.position.count;
    return c;
  });
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = new (vCount > 65535 ? Uint32Array : Uint16Array)(iCount);
  let vo = 0, io = 0;
  for (const c of parts) {
    const n = c.attributes.position.count;
    pos.set(c.attributes.position.array, vo * 3);
    nor.set(c.attributes.normal.array, vo * 3);
    if (c.attributes.uv) uv.set(c.attributes.uv.array, vo * 2);
    if (c.index) for (let i = 0; i < c.index.count; i++) idx[io + i] = c.index.array[i] + vo;
    else for (let i = 0; i < n; i++) idx[io + i] = i + vo;
    io += c.index ? c.index.count : n;
    vo += n;
    c.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

// ---------- 天空穹顶 ----------
// 注：相机俯角 45–70° 恒朝下，穹顶只有赤道一线露出，月亮挂高了永远看不到，
// 故不单独放月亮——余晖与星点都画进穹顶贴图的可视带里。
function buildSky(g, refs) {
  const skyTex = skyDomeTexture();
  refs.textures.push(skyTex);
  const domeMat = new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false });
  const dome = new THREE.Mesh(geo('skyDome', () => new THREE.SphereGeometry(58, 48, 24)), domeMat);
  refs.skyMat = domeMat;
  g.add(dome);
}

// ---------- 木栅栏（圆环，南侧门口留缺口；全部合并为 1 个 mesh） ----------
function buildFence(g) {
  const R = 10.6;
  const post = geo('fencePost', () => new THREE.BoxGeometry(0.14, 0.72, 0.14));
  const rail = geo('fenceRail', () => new THREE.BoxGeometry(1, 0.07, 0.07));
  const items = [];
  let prev = null;
  for (let th = -Math.PI; th <= Math.PI + 1e-6; th += 0.215) {
    if (Math.abs(th) < 0.24) { prev = null; continue; } // 南侧门径缺口
    if (Math.PI - Math.abs(th) < 0.11) { prev = null; continue; } // 北侧门径缺口（餐厅区客人由此进出）
    const x = R * Math.sin(th), z = R * Math.cos(th);
    items.push({ g: post, m: trs(x, GY + 0.36, z, th) });
    if (prev) {
      const dx = x - prev.x, dz = z - prev.z;
      const len = Math.hypot(dx, dz) + 0.09;
      const yaw = Math.atan2(-dz, dx);
      const mx = (x + prev.x) / 2, mz = (z + prev.z) / 2;
      items.push({ g: rail, m: trs(mx, GY + 0.30, mz, yaw, len) });
      items.push({ g: rail, m: trs(mx, GY + 0.55, mz, yaw, len) });
    }
    prev = { x, z };
  }
  const fence = new THREE.Mesh(mergeGeoms(items), mat('fenceWood', PAL.woodDark, { roughness: 0.9 }));
  g.add(fence);
}

// ---------- 路灯 ×2（门径两侧；无真实点光：自发光灯罩 + 光晕精灵 + 贴地光池） ----------
function buildLamp(g, x, z, refs, glowTex) {
  const base = new THREE.Mesh(geo('lampBase', () => new THREE.BoxGeometry(0.3, 0.14, 0.3)), mat('lampPost', 0x3A2E28));
  base.position.set(x, GY + 0.07, z);
  const post = new THREE.Mesh(geo('lampPost', () => new THREE.CylinderGeometry(0.045, 0.06, 1.75, 8)), mat('lampPost', 0x3A2E28));
  post.position.set(x, GY + 0.95, z);
  const roof = new THREE.Mesh(geo('lampRoof', () => new THREE.ConeGeometry(0.24, 0.18, 4)), mat('lampPost', 0x3A2E28));
  roof.position.set(x, GY + 1.95, z);
  roof.rotation.y = Math.PI / 4;
  const glass = new THREE.Mesh(geo('lampGlass', () => new THREE.BoxGeometry(0.17, 0.2, 0.17)),
    mat('lampGlass', PAL.bulb, { emissive: PAL.bulb, emissiveIntensity: 2.2, roughness: 0.5 }));
  glass.position.set(x, GY + 1.78, z);
  base.castShadow = post.castShadow = roof.castShadow = true;
  // 光晕精灵（灯笼周围）+ 贴地光池（假 GI）
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: PAL.lampLight, transparent: true, opacity: 0.4,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  halo.scale.set(1.9, 1.9, 1);
  halo.position.set(x, GY + 1.78, z);
  const pool = new THREE.Mesh(geo('lampPool', () => new THREE.CircleGeometry(1.7, 20)),
    new THREE.MeshBasicMaterial({
      map: glowTex, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(x, GY + 0.015, z);
  g.add(base, post, roof, glass, halo, pool);
  refs.lamps.push({ halo, pool, glass, ph: x * 1.7 });
}

// ---------- 灌木 / 碎石（合并网格；按色调分两批） ----------
function buildGreenery(g) {
  const bush = geo('bush', () => new THREE.IcosahedronGeometry(0.55, 0));
  const spots = [ // x, z, 缩放, 色调（0 深 / 1 浅）
    [-8.6, 6.8, 0.9, 0], [8.9, 5.9, 1.1, 1], [-9.8, -3.4, 1.2, 1], [9.9, -4.2, 0.85, 0],
    [-6.4, -8.6, 1.0, 0], [6.8, -8.9, 1.15, 1], [-11.6, 1.8, 0.8, 1], [11.8, 0.6, 0.95, 0],
    [4.6, 9.9, 0.75, 1], [-4.9, 10.1, 0.85, 0],
  ];
  const byTone = [[], []];
  for (const [x, z, s, tone] of spots) {
    byTone[tone].push({ g: bush, m: trs(x, GY + 0.4 * s, z, x * 1.3 + z, s, s * 0.72, s) });
  }
  const tones = [mat('bushDark', 0x2C4426, { roughness: 1 }), mat('bushLight', 0x3A5A30, { roughness: 1 })];
  byTone.forEach((items, i) => {
    const m = new THREE.Mesh(mergeGeoms(items), tones[i]);
    m.castShadow = true;
    g.add(m);
  });
  // 碎石
  const rnd = mulberry32(20260802);
  const peb = geo('pebble', () => new THREE.IcosahedronGeometry(0.13, 0));
  const items = [];
  for (let i = 0; i < 14; i++) {
    const a = rnd() * Math.PI * 2, r = 7.4 + rnd() * 6.2;
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (Math.abs(x) < 2.6 && z > 4.5) continue; // 避开南侧门径
    const s = 0.6 + rnd() * 1.1;
    items.push({ g: peb, m: trs(x, GY + 0.05 * s, z, rnd() * 3, s, s * 0.5, s) });
  }
  g.add(new THREE.Mesh(mergeGeoms(items), mat('pebble', 0x6B5F52, { roughness: 1 })));
}

// ---------- 板条箱 / 木桶杂物（院墙边的摆盘感） ----------
function buildClutter(g) {
  const crate = geo('crateOut', () => new THREE.BoxGeometry(0.56, 0.56, 0.56));
  const crateM = mat('crateWood', PAL.crateWood);
  const mk = (x, z, s, rotY, y = 0) => {
    const m = new THREE.Mesh(crate, crateM);
    m.position.set(x, GY + 0.28 * s + y, z);
    m.scale.setScalar(s);
    m.rotation.y = rotY;
    m.castShadow = true;
    g.add(m);
  };
  mk(8.3, -1.8, 1, 0.4);
  mk(8.15, -1.65, 0.72, 1.1, 0.56);
  mk(-8.5, 3.2, 0.9, -0.3);
  const barrel = new THREE.Mesh(geo('barrel', () => new THREE.CylinderGeometry(0.27, 0.31, 0.62, 12)),
    mat('barrelWood', PAL.woodDark, { roughness: 0.9 }));
  barrel.position.set(8.95, GY + 0.31, -0.6);
  barrel.castShadow = true;
  const sack = new THREE.Mesh(geo('sack', () => new THREE.SphereGeometry(0.3, 10, 8)), mat('doughSack', PAL.dough));
  sack.scale.set(1, 0.72, 1);
  sack.position.set(-8.05, GY + 0.2, 4.05);
  sack.castShadow = true;
  g.add(barrel, sack);
}

// ---------- 远景剪影（山丘 / 松树 / 亮窗小屋；北面为主，无光照纯色 + 雾融合） ----------
function buildSilhouettes(g) {
  // 山丘：半埋的扁球（远、低、淡，只作地平线起伏，不抢戏）
  const hill = geo('hill', () => new THREE.SphereGeometry(1, 20, 14));
  const hills = [
    [0, -27.5, 12, 0.26], [-21, -24, 9, 0.22], [19, -26, 10, 0.24], [-28, -10, 8, 0.22], [28, -11, 8.5, 0.23],
  ].map(([x, z, r, sy]) => ({ g: hill, m: trs(x, GY + 0.3, z, 0, r, r * sy, r) }));
  const hillsM = new THREE.Mesh(mergeGeoms(hills),
    new THREE.MeshBasicMaterial({ color: 0x33253A }));
  g.add(hillsM);

  // 松树：三段圆锥叠塔
  const cone = geo('pineCone', () => new THREE.ConeGeometry(1, 1.6, 8));
  const pines = [ // x, z, 缩放
    [-14, -20, 1.7], [-7, -23.5, 2.1], [9.5, -22.5, 1.85], [16, -18.5, 1.4],
    [-21, -13, 1.3], [21.5, -12, 1.55], [-24.5, -2, 1.4], [24.5, -3, 1.3], [-3, -25.5, 1.55],
  ];
  const pineItems = [];
  for (const [x, z, s] of pines) {
    pineItems.push({ g: cone, m: trs(x, GY + 0.7 * s, z, x, 0.95 * s, s, 0.95 * s) });
    pineItems.push({ g: cone, m: trs(x, GY + 1.35 * s, z, x + 1, 0.72 * s, 0.85 * s, 0.72 * s) });
    pineItems.push({ g: cone, m: trs(x, GY + 1.9 * s, z, x + 2, 0.48 * s, 0.7 * s, 0.48 * s) });
  }
  g.add(new THREE.Mesh(mergeGeoms(pineItems), new THREE.MeshBasicMaterial({ color: 0x2E2133 })));

  // 小屋 ×3：方身 + 四棱锥屋顶 + 南面一扇暖窗（窗合并为一个 mesh）
  const body = geo('hutBody', () => new THREE.BoxGeometry(2.2, 1.6, 1.8));
  const roof = geo('hutRoof', () => new THREE.ConeGeometry(1.85, 1.1, 4));
  const win = geo('hutWin', () => new THREE.PlaneGeometry(0.34, 0.4));
  const huts = [[-11, -21.5, 0.35], [13.5, -20.5, -0.4], [24, -7.5, -0.85]];
  const hutItems = [], winItems = [];
  for (const [x, z, rot] of huts) {
    hutItems.push({ g: body, m: trs(x, GY + 0.96, z, rot, 1.25) });
    hutItems.push({ g: roof, m: trs(x, GY + 2.6, z, rot + Math.PI / 4, 1.25) });
    winItems.push({ g: win, m: trs(x + Math.sin(rot) * 1.14, GY + 0.95, z + Math.cos(rot) * 1.14, rot, 1.25) });
  }
  g.add(new THREE.Mesh(mergeGeoms(hutItems), new THREE.MeshBasicMaterial({ color: 0x2B2030 })));
  g.add(new THREE.Mesh(mergeGeoms(winItems),
    new THREE.MeshBasicMaterial({ color: 0xFFCA78, fog: true })));
}

// ---------- 萤火虫（12 只精灵，各自独立材质以分别闪烁；update 只改位置/透明度） ----------
function buildFireflies(g, refs, glowTex) {
  const rnd = mulberry32(20260803);
  for (let i = 0; i < 12; i++) {
    const m = new THREE.SpriteMaterial({
      map: glowTex, color: 0xCFE87A, transparent: true, opacity: 0.6,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const s = new THREE.Sprite(m);
    const sc = 0.22 + rnd() * 0.16;
    s.scale.set(sc, sc, 1);
    const a = rnd() * Math.PI * 2, r = 5.6 + rnd() * 6.4;
    const f = {
      s, m,
      cx: Math.sin(a) * r, cz: Math.cos(a) * r,
      y: 0.45 + rnd() * 1.25,
      r: 0.7 + rnd() * 1.4,
      sp: 0.22 + rnd() * 0.3,
      fl: 1.6 + rnd() * 2.2,
      ph: rnd() * Math.PI * 2,
      op: 0.6 + rnd() * 0.4,
    };
    s.position.set(f.cx, f.y, f.cz);
    g.add(s);
    refs.fireflies.push(f);
  }
}

// ---------- 总装 ----------
export function buildBackdrop(scene) {
  const g = new THREE.Group();
  scene.add(g);
  const refs = { textures: [], lamps: [], fireflies: [], skyMat: null };

  // 暮色雾：把地面边缘 / 剪影揉进夜空（厨房本体在雾起点以内，不受影响）
  scene.fog = new THREE.Fog(0x2A1C13, 46, 100);

  buildSky(g, refs);
  const glowTex = glowDiscTexture();
  refs.textures.push(glowTex);
  buildFence(g);
  buildLamp(g, -3.4, 7.9, refs, glowTex);
  buildLamp(g, 3.4, 7.9, refs, glowTex);
  buildGreenery(g);
  buildClutter(g);
  buildSilhouettes(g);
  buildFireflies(g, refs, glowTex);

  let dim = 1;
  return {
    group: g,
    setDim(d) { dim = d; },
    update(t) {
      // 歇业压暗：天空 / 灯光同步收敛，萤火虫保留一点活气
      const skyK = 0.45 + 0.55 * dim;
      refs.skyMat.color.setScalar(skyK);
      const lampK = 0.22 + 0.78 * dim;
      for (const l of refs.lamps) {
        const fl = 1 + 0.06 * Math.sin(t * 7.3 + l.ph) + 0.04 * Math.sin(t * 11.9 + l.ph * 2.3);
        l.halo.material.opacity = 0.38 * lampK * fl;
        l.pool.material.opacity = 0.5 * lampK * fl;
      }
      // 灯罩自发光为两灯共享材质，统一收敛（不逐灯设两次）
      mat('lampGlass', PAL.bulb).emissiveIntensity = 2.2 * lampK;
      const flyK = 0.45 + 0.55 * dim;
      for (const f of refs.fireflies) {
        f.s.position.set(
          f.cx + Math.cos(t * f.sp + f.ph) * f.r,
          f.y + Math.sin(t * f.sp * 1.7 + f.ph * 2) * 0.32,
          f.cz + Math.sin(t * f.sp * 0.83 + f.ph) * f.r);
        f.m.opacity = f.op * flyK * (0.5 + 0.5 * Math.sin(t * f.fl + f.ph * 3));
      }
    },
    dispose() {
      scene.fog = null;
      scene.remove(g);
      g.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) m.dispose();
        }
      });
      for (const t of refs.textures) t.dispose();
      for (const k in GEO) { GEO[k].dispose(); delete GEO[k]; }
      for (const k in MAT) { MAT[k].dispose(); delete MAT[k]; }
    },
  };
}
