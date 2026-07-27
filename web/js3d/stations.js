// 厨房静态场景：12×9 地板、矮墙、沿墙台面 + 中央岛台（回字走道≥2格）、全部工位
import * as THREE from '../vendor/three.module.min.js';
import { PAL } from './palette.js';
import { iconTexture, floorTexture, outerGroundTexture, brickTexture } from './textures.js';

export const GW = 12, GH = 9;
export const cellToWorld = (ix, iz) => ({ x: ix - (GW - 1) / 2, z: iz - (GH - 1) / 2 });

// ---------- 共享几何体 / 材质缓存 ----------
const GEO = {};
const MAT = {};
function geo(key, make) { return GEO[key] || (GEO[key] = make()); }
function mat(key, color, opts = {}) {
  return MAT[key] || (MAT[key] = new THREE.MeshStandardMaterial({
    color, flatShading: true, roughness: opts.roughness ?? 0.95, metalness: opts.metalness ?? 0,
    emissive: opts.emissive || 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 1,
  }));
}
function box(w, h, d, m) {
  const g = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(g, m);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

// ---------- 布局表 ----------
// kind: counter | board | wok | stove | phone | pressure | serve | crate | sink | plates | menu
// face: 厨师站位朝向 ('n'|'s'|'e'|'w')，approach 由 face 推出
export const LAYOUT = [
  // 北墙一排 (z=0)
  { ix: 0, iz: 0, kind: 'counter' }, { ix: 1, iz: 0, kind: 'crate', icon: '🍅', face: 'n' },
  { ix: 2, iz: 0, kind: 'crate', icon: '🥬', face: 'n' }, { ix: 3, iz: 0, kind: 'plates' },
  { ix: 4, iz: 0, kind: 'counter' }, { ix: 5, iz: 0, kind: 'serve', icon: '🔔', face: 'n' },
  { ix: 6, iz: 0, kind: 'serve', icon: '🔔', face: 'n' },
  // 菜单角（ix=7 北墙，正好在 decor 菜单黑板下方）：想菜单的厨师来这里翻阅菜单
  { ix: 7, iz: 0, kind: 'menu', icon: '💭', face: 'n' },
  { ix: 8, iz: 0, kind: 'sink' }, { ix: 9, iz: 0, kind: 'phone', icon: '📞', face: 'n' },
  { ix: 10, iz: 0, kind: 'counter' }, { ix: 11, iz: 0, kind: 'counter' },
  // 西墙一列 (x=0)
  { ix: 0, iz: 1, kind: 'counter' }, { ix: 0, iz: 2, kind: 'crate', icon: '🥩', face: 'w' },
  { ix: 0, iz: 3, kind: 'counter' }, { ix: 0, iz: 4, kind: 'counter' },
  { ix: 0, iz: 5, kind: 'counter' }, { ix: 0, iz: 6, kind: 'counter' },
  { ix: 0, iz: 7, kind: 'counter' },
  // 东墙一列 (x=11)；iz=4 为增设的炒锅（炒菜区外摆，站位 x=10 东走道，不挡门/出餐口）
  { ix: 11, iz: 1, kind: 'counter' }, { ix: 11, iz: 2, kind: 'counter' },
  { ix: 11, iz: 3, kind: 'counter' }, { ix: 11, iz: 4, kind: 'wok', icon: '🔪', face: 'e' },
  { ix: 11, iz: 5, kind: 'counter' }, { ix: 11, iz: 6, kind: 'counter' },
  { ix: 11, iz: 7, kind: 'counter' },
  // 南墙一排 (z=8)，x=5,6 为门口
  { ix: 1, iz: 8, kind: 'counter' }, { ix: 2, iz: 8, kind: 'counter' },
  { ix: 9, iz: 8, kind: 'counter' }, { ix: 10, iz: 8, kind: 'counter' },
  // 中央岛台 (x=4..7, z=3..4)
  // 岛台 2 格深，站位必须在岛外走道：北排(z=3) face 's' → 厨师站 z=2 北走道朝南操作；
  // 南排(z=4) face 'n' → 厨师站 z=5 南走道朝北操作（否则站位落在岛内台面上，模型与灶台重合）
  { ix: 4, iz: 3, kind: 'board', icon: '📖', face: 's' },
  { ix: 5, iz: 3, kind: 'stove', icon: '🔥', face: 's', stoveId: 'A' },
  { ix: 6, iz: 3, kind: 'stove', icon: '🔥', face: 's', stoveId: 'B' },
  { ix: 7, iz: 3, kind: 'wok', icon: '🔪', face: 'w' },
  { ix: 4, iz: 4, kind: 'pressure', icon: '⚡', face: 'n' },
  { ix: 5, iz: 4, kind: 'plates' },
  { ix: 6, iz: 4, kind: 'crate', icon: '🍚', face: 'n' },
  // 岛台东南角增设第二炒锅（与 iz=3 的老炒锅组成炒菜区）：face 'n' → 厨师站 z=5 南走道
  { ix: 7, iz: 4, kind: 'wok', icon: '🔪', face: 'n' },
];

export const DOOR_CELLS = [{ ix: 5, iz: 8 }, { ix: 6, iz: 8 }];
export const SPAWN = { x: 0, z: (GH - 1) / 2 + 1.4 }; // 门外的世界坐标

// 休息区格子（南走道）
export const REST_CELLS = [];
for (const iz of [6, 7]) for (const ix of [2, 3, 4, 7, 8, 9, 1, 10]) REST_CELLS.push({ ix, iz });

export function buildWalkGrid() {
  const walk = Array.from({ length: GH + 2 }, () => Array(GW).fill(false));
  for (const s of LAYOUT) walk[s.iz][s.ix] = false;
  for (let iz = 0; iz < GH; iz++) for (let ix = 0; ix < GW; ix++) walk[iz][ix] = true;
  for (const s of LAYOUT) walk[s.iz][s.ix] = false;
  for (const d of DOOR_CELLS) { walk[d.iz][d.ix] = true; walk[d.iz + 1] = walk[d.iz + 1] || Array(GW).fill(false); walk[d.iz + 1][d.ix] = true; }
  return walk;
}

// BFS 寻路（格子 → 格子），返回世界坐标路径点
export function findPath(walk, from, to) {
  if (from.ix === to.ix && from.iz === to.iz) return [cellToWorld(to.ix, to.iz)];
  const key = (ix, iz) => iz * GW + ix;
  const prev = new Map([[key(from.ix, from.iz), null]]);
  const q = [[from.ix, from.iz]];
  while (q.length) {
    const [cx, cz] = q.shift();
    if (cx === to.ix && cz === to.iz) break;
    for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nx >= GW || nz < 0 || nz > GH) continue;
      if (!walk[nz][nx] || prev.has(key(nx, nz))) continue;
      prev.set(key(nx, nz), [cx, cz]);
      q.push([nx, nz]);
    }
  }
  if (!prev.has(key(to.ix, to.iz))) return [cellToWorld(to.ix, to.iz)];
  const cells = [];
  let cur = [to.ix, to.iz];
  while (cur) { cells.push(cur); cur = prev.get(key(cur[0], cur[1])); }
  cells.reverse();
  // 合并直线段，只留拐点
  const pts = [];
  for (let i = 1; i < cells.length; i++) {
    const [px, pz] = cells[i - 1], [cx, cz] = cells[i];
    const [nx, nz] = cells[i + 1] || [null, null];
    pts.push(cellToWorld(cx, cz));
    if (nx !== null && (nx - cx === cx - px) && (nz - cz === cz - pz)) { /* 直线，拐点已够 */ }
  }
  return pts;
}

export function nearestCell(x, z) {
  return { ix: Math.round(x + (GW - 1) / 2), iz: Math.round(z + (GH - 1) / 2) };
}

// ---------- 台面与工位模型 ----------
function counterBase(group, x, z) {
  const body = box(1, 0.9, 1, mat('counterBody', PAL.counterBody));
  body.position.set(x, 0.45, z);
  const top = box(1.05, 0.08, 1.05, mat('counterTop', PAL.counterTop));
  top.position.set(x, 0.94, z);
  const plinth = box(1.02, 0.1, 1.02, mat('wallCap', PAL.wallCap));
  plinth.position.set(x, 0.05, z);
  group.add(body, top, plinth);
  return 0.98; // 台面顶面高度
}

function iconPlane(emoji, size = 0.5) {
  const tex = iconTexture(emoji);
  const g = new THREE.PlaneGeometry(size, size);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

function buildStation(group, s) {
  const { x, z } = cellToWorld(s.ix, s.iz);
  const topY = counterBase(group, x, z);
  const spot = { kind: s.kind, ix: s.ix, iz: s.iz, x, z, topY, face: s.face || null, group: null };
  const sub = new THREE.Group();
  group.add(sub);
  spot.group = sub;

  switch (s.kind) {
    case 'board': { // 案板：白砧板 + 菜刀 + 待切蔬菜与面团
      const board = box(0.6, 0.05, 0.4, mat('board', PAL.board));
      board.position.set(x, topY + 0.025, z);
      const blade = box(0.3, 0.02, 0.08, mat('knife', PAL.knife, { metalness: 0.4, roughness: 0.5 }));
      blade.position.set(x + 0.08, topY + 0.06, z);
      const handle = box(0.12, 0.03, 0.05, mat('wallCap', PAL.wallCap));
      handle.position.set(x - 0.13, topY + 0.06, z);
      sub.add(board, blade, handle);
      // 番茄（两半）+ 生菜球 + 面团
      const tom1 = new THREE.Mesh(geo('tomato', () => new THREE.SphereGeometry(0.075, 10, 8)), mat('tomato', PAL.tomato, { roughness: 0.7 }));
      tom1.position.set(x - 0.24, topY + 0.125, z - 0.1);
      const tom2 = new THREE.Mesh(geo('tomatoHalf', () => new THREE.SphereGeometry(0.06, 10, 6, 0, Math.PI)), mat('tomato', PAL.tomato, { roughness: 0.7 }));
      tom2.rotation.z = -Math.PI / 2;
      tom2.position.set(x - 0.1, topY + 0.11, z + 0.13);
      const lettuce = new THREE.Mesh(geo('lettuce', () => new THREE.IcosahedronGeometry(0.09, 0)), mat('lettuce', PAL.lettuce, { roughness: 0.85 }));
      lettuce.position.set(x + 0.26, topY + 0.14, z - 0.14);
      const dough = new THREE.Mesh(geo('dough', () => new THREE.SphereGeometry(0.1, 10, 8)), mat('dough', PAL.dough, { roughness: 0.95 }));
      dough.scale.y = 0.62;
      dough.position.set(x + 0.28, topY + 0.11, z + 0.16);
      sub.add(tom1, tom2, lettuce, dough);
      spot.knife = blade; spot.knifeHome = blade.position.clone();
      break;
    }
    case 'wok': { // 炒锅台：黑铁锅 + 锅耳
      const wok = new THREE.Mesh(geo('wok', () => new THREE.CylinderGeometry(0.3, 0.2, 0.16, 14)), mat('stoveTop', PAL.stoveTop));
      wok.position.set(x, topY + 0.08, z);
      wok.castShadow = true;
      const ear1 = box(0.1, 0.04, 0.06, mat('metal', PAL.metal, { metalness: 0.3 }));
      ear1.position.set(x + 0.32, topY + 0.12, z);
      const ear2 = ear1.clone(); ear2.position.x = x - 0.32;
      sub.add(wok, ear1, ear2);
      spot.wok = wok;
      break;
    }
    case 'stove': { // 灶台：黑炉盘 + 红点 + 金属锅（带盖柄/蒸汽口）+ 炉前旋钮
      const plate = new THREE.Mesh(geo('stovePlate', () => new THREE.CylinderGeometry(0.32, 0.32, 0.06, 20)), mat('stoveTop', PAL.stoveTop));
      plate.position.set(x, topY + 0.03, z);
      plate.castShadow = true;
      const dot = new THREE.Mesh(geo('stoveDot', () => new THREE.CylinderGeometry(0.06, 0.06, 0.02, 10)), mat('redGlow', PAL.red, { emissive: PAL.red, emissiveIntensity: 0.6 }));
      dot.position.set(x + 0.34, topY + 0.05, z + 0.3);
      const pot = new THREE.Mesh(geo('pot', () => new THREE.CylinderGeometry(0.26, 0.24, 0.28, 14)), mat('metal', PAL.metal, { metalness: 0.3, roughness: 0.6 }));
      pot.position.set(x, topY + 0.2, z);
      pot.castShadow = true;
      // 锅盖 + 盖柄（蒸汽从口沿冒出，粒子由 FX 发射器驱动）
      const lid = new THREE.Mesh(geo('potLid', () => new THREE.CylinderGeometry(0.27, 0.25, 0.05, 14)), mat('steelM', PAL.steel, { metalness: 0.35, roughness: 0.55 }));
      lid.position.set(x, topY + 0.36, z);
      const knobTop = new THREE.Mesh(geo('lidKnob', () => new THREE.SphereGeometry(0.045, 8, 6)), mat('wallCap', PAL.wallCap));
      knobTop.position.set(x, topY + 0.41, z);
      // 锅耳
      const ear1 = box(0.08, 0.04, 0.05, mat('metal', PAL.metal, { metalness: 0.3 }));
      ear1.position.set(x + 0.28, topY + 0.24, z);
      const ear2 = ear1.clone(); ear2.position.x = x - 0.28;
      // 炉前旋钮（朝南面板，厨师站位侧）
      const knobs = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const k = new THREE.Mesh(geo('stoveKnob', () => new THREE.CylinderGeometry(0.035, 0.035, 0.03, 8)),
          i === 0 ? mat('red', PAL.red) : mat('wallCap', PAL.wallCap));
        k.rotation.x = Math.PI / 2;
        k.position.set(x - 0.2 + i * 0.2, 0.72, z + 0.51);
        knobs.add(k);
      }
      const glow = new THREE.Mesh(geo('stoveGlow', () => new THREE.CylinderGeometry(0.34, 0.34, 0.02, 20)),
        new THREE.MeshBasicMaterial({ color: PAL.flame, transparent: true, opacity: 0.0 }));
      glow.position.set(x, topY + 0.045, z);
      sub.add(plate, dot, pot, lid, knobTop, ear1, ear2, knobs, glow);
      spot.pot = pot; spot.glow = glow; spot.stoveId = s.stoveId;
      break;
    }
    case 'phone': { // 电话台：红色座机 + 点单便签
      const base = box(0.34, 0.1, 0.26, mat('red', PAL.red));
      base.position.set(x, topY + 0.05, z);
      const receiver = box(0.3, 0.06, 0.09, mat('red', PAL.red));
      receiver.position.set(x, topY + 0.14, z);
      const note = box(0.18, 0.015, 0.24, mat('ticketPaper', PAL.ticketPaper));
      note.position.set(x + 0.26, topY + 0.01, z + 0.1);
      note.rotation.y = -0.25;
      const pencil = box(0.02, 0.015, 0.16, mat('spiceYolk', PAL.spiceYolk));
      pencil.position.set(x + 0.3, topY + 0.02, z - 0.12);
      pencil.rotation.y = 0.5;
      sub.add(base, receiver, note, pencil);
      spot.receiver = receiver; spot.receiverHome = receiver.position.clone();
      break;
    }
    case 'pressure': { // 高压锅：锅体 + 盖 + 泄压阀
      const body = new THREE.Mesh(geo('pcBody', () => new THREE.CylinderGeometry(0.27, 0.27, 0.3, 14)), mat('steelM', PAL.steel, { metalness: 0.35, roughness: 0.55 }));
      body.position.set(x, topY + 0.15, z);
      body.castShadow = true;
      const lid = new THREE.Mesh(geo('pcLid', () => new THREE.CylinderGeometry(0.28, 0.28, 0.06, 14)), mat('metal', PAL.metal, { metalness: 0.3 }));
      lid.position.set(x, topY + 0.33, z);
      const valve = new THREE.Mesh(geo('pcValve', () => new THREE.CylinderGeometry(0.045, 0.06, 0.1, 8)), mat('red', PAL.red));
      valve.position.set(x, topY + 0.41, z);
      sub.add(body, lid, valve);
      spot.valve = valve;
      break;
    }
    case 'serve': { // 出餐口台面：金属格栅小平台 + 铃铛 + 待出餐盘 + 餐巾
      const tray = box(0.8, 0.04, 0.5, mat('grate', PAL.grate, { metalness: 0.4, roughness: 0.5 }));
      tray.position.set(x, topY + 0.02, z);
      const bell = new THREE.Mesh(geo('bell', () => new THREE.SphereGeometry(0.12, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)),
        mat('bellGold', 0xF2C230, { metalness: 0.5, roughness: 0.4 }));
      bell.position.set(x - 0.28, topY + 0.04, z + 0.12);
      bell.castShadow = true;
      // 待出餐的空盘 + 折叠餐巾
      const dish = new THREE.Mesh(geo('plate', () => new THREE.CylinderGeometry(0.25, 0.22, 0.045, 14)), mat('plate', PAL.plate));
      dish.position.set(x + 0.2, topY + 0.065, z - 0.08);
      dish.castShadow = true;
      const napkin = box(0.2, 0.025, 0.16, mat('towel', PAL.towel));
      napkin.position.set(x + 0.22, topY + 0.055, z + 0.16);
      sub.add(tray, bell, dish, napkin);
      spot.bell = bell;
      break;
    }
    case 'crate': { // 食材箱：开口木箱 + 食材堆 + 正面图标牌
      const rim = mat('crateWood', PAL.crateWood);
      const wallT = 0.06, cw = 0.8, ch = 0.35;
      const mk = (w, h, d, px, py, pz) => { const b = box(w, h, d, rim); b.position.set(px, py, pz); sub.add(b); };
      mk(cw, ch, wallT, x, topY + ch / 2, z - cw / 2);
      mk(cw, ch, wallT, x, topY + ch / 2, z + cw / 2);
      mk(wallT, ch, cw, x - cw / 2, topY + ch / 2, z);
      mk(wallT, ch, cw, x + cw / 2, topY + ch / 2, z);
      // 食材堆（彩色圆球）
      const foodColors = { '🍅': 0xD94F3D, '🥬': 0x58B24C, '🥩': 0xC96A5A, '🍚': 0xF4F2EC };
      const fm = new THREE.MeshStandardMaterial({ color: foodColors[s.icon] || 0xD94F3D, flatShading: true, roughness: 0.9 });
      for (let i = 0; i < 4; i++) {
        const f = new THREE.Mesh(geo('foodBall', () => new THREE.SphereGeometry(0.11, 8, 6)), fm);
        f.position.set(x + (i % 2 - 0.5) * 0.28, topY + 0.32 + (i > 1 ? 0.12 : 0), z + (Math.floor(i / 2) - 0.5) * 0.28);
        f.castShadow = true;
        sub.add(f);
      }
      // 正面图标牌（挂在厨师站位一侧）
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.44),
        new THREE.MeshBasicMaterial({ map: iconTexture(s.icon), transparent: true }));
      const APPROACH_DELTA = { n: [0, 1], s: [0, -1], e: [-1, 0], w: [1, 0] };
      const [fdx, fdz] = APPROACH_DELTA[s.face] || [0, 1];
      sign.position.set(x + fdx * 0.53, 0.55, z + fdz * 0.53);
      sign.rotation.y = Math.atan2(fdx, fdz);
      sub.add(sign);
      break;
    }
    case 'plates': { // 盘子摞 + 旁边小碗堆
      for (let i = 0; i < 4; i++) {
        const p = new THREE.Mesh(geo('plate', () => new THREE.CylinderGeometry(0.25, 0.22, 0.045, 14)), mat('plate', PAL.plate));
        p.position.set(x, topY + 0.03 + i * 0.05, z);
        p.castShadow = true;
        sub.add(p);
      }
      for (let i = 0; i < 2; i++) {
        const b = new THREE.Mesh(geo('bowl', () => new THREE.CylinderGeometry(0.15, 0.1, 0.09, 12)), mat('board', PAL.board));
        b.position.set(x + 0.3, topY + 0.05 + i * 0.1, z + 0.28);
        b.castShadow = true;
        sub.add(b);
      }
      break;
    }
    case 'sink': { // 水池 + 弯管水龙头
      const basin = box(0.7, 0.08, 0.6, mat('steelM', PAL.steel, { metalness: 0.35, roughness: 0.5 }));
      basin.position.set(x, topY + 0.02, z);
      const waterM = box(0.6, 0.02, 0.5, mat('water', PAL.water, { roughness: 0.3 }));
      waterM.position.set(x, topY + 0.06, z);
      const pipe = new THREE.Mesh(geo('faucetPipe', () => new THREE.CylinderGeometry(0.035, 0.035, 0.3, 8)), mat('metal', PAL.metal, { metalness: 0.4, roughness: 0.45 }));
      pipe.position.set(x, topY + 0.17, z - 0.22);
      const spout = new THREE.Mesh(geo('faucetSpout', () => new THREE.CylinderGeometry(0.03, 0.03, 0.22, 8)), mat('metal', PAL.metal, { metalness: 0.4, roughness: 0.45 }));
      spout.rotation.x = Math.PI / 2;
      spout.position.set(x, topY + 0.3, z - 0.12);
      sub.add(basin, waterM, pipe, spout);
      break;
    }
    case 'menu': { // 菜单角：立式菜单展示架 + 翻开的大菜单（右页可翻动）+ 一摞菜谱书
      // 展示架：加高斜面板（顶边远离厨师，板面迎向站位与镜头，翻开的书能露出厨师帽檐上方）
      // + 底部挡条 + 背后斜撑
      const back = box(0.6, 0.72, 0.05, mat('crateWood', PAL.crateWood));
      back.position.set(x, topY + 0.44, z - 0.16);
      back.rotation.x = -0.42;
      const ledge = box(0.6, 0.05, 0.09, mat('frameWood', PAL.frameWood));
      ledge.position.set(x, topY + 0.13, z + 0.02);
      const strut = box(0.07, 0.52, 0.05, mat('frameWood', PAL.frameWood));
      strut.position.set(x, topY + 0.26, z - 0.38);
      strut.rotation.x = 0.55;
      sub.add(back, ledge, strut);
      // 翻开的大菜单：红封面垫底 + 左右米白书页 + 书脊处铰链的可翻页
      const book = new THREE.Group();
      book.position.set(x, topY + 0.46, z - 0.12);
      book.rotation.x = -0.42;
      const cover = box(0.56, 0.02, 0.44, mat('red', PAL.red));
      cover.position.y = -0.012;
      const pageL = box(0.25, 0.015, 0.4, mat('paper', PAL.paper));
      pageL.position.set(-0.135, 0.01, 0);
      const pageR = pageL.clone();
      pageR.position.x = 0.135;
      // 可翻页：铰链挂在书脊（x=0），厨师翻阅时绕 z 轴掀起/落下（由 chef.js 驱动）
      const hinge = new THREE.Group();
      hinge.position.set(0, 0.022, 0);
      const flip = box(0.25, 0.012, 0.4, mat('ticketPaper', PAL.ticketPaper));
      flip.position.x = 0.135;
      hinge.add(flip);
      // 红色丝带书签垂在封面下沿
      const ribbon = box(0.04, 0.012, 0.16, mat('red', PAL.red));
      ribbon.position.set(0.05, 0.005, 0.27);
      book.add(cover, pageL, pageR, hinge, ribbon);
      sub.add(book);
      // 旁边一摞菜谱书（三色书脊叠放）
      const bookCols = [PAL.spiceGreen, PAL.spiceYolk, PAL.red];
      bookCols.forEach((col, i) => {
        const bk = box(0.2, 0.045, 0.28, mat('menuBook' + i, col, { roughness: 0.8 }));
        bk.position.set(x + 0.33, topY + 0.025 + i * 0.05, z + 0.08);
        bk.rotation.y = (i - 1) * 0.16;
        sub.add(bk);
      });
      spot.menuHinge = hinge;
      break;
    }
    case 'counter': { // 空白台面：按格子坐标确定性摆放生活道具（低模程序化）
      const v = (s.ix * 7 + s.iz * 13) % 6;
      if (v === 0) { // 调料瓶三件套
        const cols = [PAL.spiceRed, PAL.spiceYolk, PAL.spiceGreen];
        cols.forEach((col, i) => {
          const jar = new THREE.Mesh(geo('spiceJar', () => new THREE.CylinderGeometry(0.07, 0.075, 0.18, 10)), mat('spice' + i, col, { roughness: 0.55 }));
          jar.position.set(x - 0.2 + i * 0.2, topY + 0.09, z + (i % 2 ? 0.06 : -0.06));
          jar.castShadow = true;
          const cap = new THREE.Mesh(geo('spiceCap', () => new THREE.CylinderGeometry(0.075, 0.075, 0.04, 10)), mat('wallCap', PAL.wallCap));
          cap.position.set(jar.position.x, topY + 0.2, jar.position.z);
          sub.add(jar, cap);
        });
      } else if (v === 1) { // 面团 + 擀面杖
        const d1 = new THREE.Mesh(geo('dough', () => new THREE.SphereGeometry(0.1, 10, 8)), mat('dough', PAL.dough, { roughness: 0.95 }));
        d1.scale.y = 0.6; d1.position.set(x - 0.15, topY + 0.08, z);
        const d2 = d1.clone(); d2.scale.set(0.75, 0.45, 0.75); d2.position.set(x + 0.12, topY + 0.06, z + 0.15);
        const pin = new THREE.Mesh(geo('rollPin', () => new THREE.CylinderGeometry(0.045, 0.045, 0.44, 8)), mat('crateWood', PAL.crateWood));
        pin.rotation.z = Math.PI / 2; pin.rotation.y = 0.4;
        pin.position.set(x + 0.05, topY + 0.05, z - 0.18);
        pin.castShadow = true;
        sub.add(d1, d2, pin);
      } else if (v === 2) { // 一碗番茄
        const bowl = new THREE.Mesh(geo('bowl', () => new THREE.CylinderGeometry(0.15, 0.1, 0.09, 12)), mat('red', PAL.red));
        bowl.position.set(x, topY + 0.05, z);
        bowl.castShadow = true;
        sub.add(bowl);
        for (let i = 0; i < 3; i++) {
          const t = new THREE.Mesh(geo('tomatoSm', () => new THREE.SphereGeometry(0.06, 8, 6)), mat('tomato', PAL.tomato, { roughness: 0.7 }));
          t.position.set(x + (i - 1) * 0.09, topY + 0.12 + (i === 1 ? 0.05 : 0), z + (i % 2 ? 0.05 : -0.04));
          sub.add(t);
        }
      } else if (v === 3) { // 翻开的菜谱 + 马克杯
        const pg1 = box(0.22, 0.02, 0.3, mat('paper', PAL.paper));
        pg1.position.set(x - 0.1, topY + 0.02, z);
        pg1.rotation.y = 0.1;
        const pg2 = pg1.clone(); pg2.position.x = x + 0.1; pg2.rotation.y = -0.1;
        const mug = new THREE.Mesh(geo('mug', () => new THREE.CylinderGeometry(0.07, 0.06, 0.14, 10)), mat('red', PAL.red));
        mug.position.set(x + 0.28, topY + 0.07, z + 0.2);
        mug.castShadow = true;
        sub.add(pg1, pg2, mug);
      } else if (v === 4) { // 叠放的抹布 + 刷子
        const t1 = box(0.3, 0.03, 0.24, mat('towel', PAL.towel));
        t1.position.set(x - 0.1, topY + 0.015, z);
        const t2 = box(0.26, 0.03, 0.2, mat('water', PAL.water));
        t2.position.set(x - 0.08, topY + 0.045, z + 0.02);
        t2.rotation.y = 0.3;
        const brush = box(0.16, 0.04, 0.06, mat('crateWood', PAL.crateWood));
        brush.position.set(x + 0.24, topY + 0.02, z - 0.12);
        sub.add(t1, t2, brush);
      } else { // 刀架 + 两把刀
        const block = box(0.16, 0.24, 0.12, mat('crateWood', PAL.crateWood));
        block.position.set(x, topY + 0.12, z);
        block.castShadow = true;
        const k1 = box(0.02, 0.14, 0.05, mat('knife', PAL.knife, { metalness: 0.4, roughness: 0.5 }));
        k1.position.set(x - 0.03, topY + 0.28, z);
        k1.rotation.z = 0.12;
        const k2 = k1.clone(); k2.position.x = x + 0.04; k2.rotation.z = -0.1;
        sub.add(block, k1, k2);
      }
      break;
    }
  }
  // 台面图标（除食材箱已挂正面牌）
  if (s.icon && s.kind !== 'crate') {
    const ip = iconPlane(s.icon);
    ip.position.set(x + 0.32, topY + 0.012, z + 0.32);
    sub.add(ip);
  }
  return spot;
}

// ---------- 整体构建 ----------
export function buildKitchen(scene) {
  const group = new THREE.Group();
  scene.add(group);

  // 地板：单块贴图盒（棋盘格 + 每格色差 + 磨损斑，替代 108 块独立地砖）
  const floorTex = floorTexture(GW, GH, { light: PAL.floorLight, dark: PAL.floorDark, grout: PAL.wallCap });
  const floorTop = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.92, metalness: 0 });
  const floorSide = mat('floorEdge', PAL.floorEdge);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(GW, 0.1, GH),
    [floorSide, floorSide, floorTop, floorSide, floorSide, floorSide]);
  floor.position.set(0, -0.05, 0);
  floor.receiveShadow = true;
  group.add(floor);
  // 厨房外大地面（中心被灯光烘暖 → 边缘没入夜色，带石板/沙砾/草叶碎点）
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ map: outerGroundTexture(), roughness: 1 }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.12;
  outer.receiveShadow = true;
  group.add(outer);

  // 墙体：北墙 3.2 高暖砖墙（挂饰舞台），出餐口一带开传菜窗 + 出餐吧台（见下）；
  // 东西墙 1.7 灰泥，南墙 1.5（不挡相机），均带压顶
  const wallMat = mat('wall', PAL.wall);
  const capMat = mat('wallCap', PAL.wallCap);
  const brickTex = brickTexture({ a: PAL.brickA, b: PAL.brickB, mortar: PAL.mortar });
  brickTex.repeat.set(5, 2.2);
  const brickMat = new THREE.MeshStandardMaterial({ map: brickTex, roughness: 0.95, metalness: 0 });
  // 挡视线墙体消隐：各侧墙用共享材质的独立克隆（改 opacity 互不牵连），
  // 网格打 userData.wallSide 标记，由 kitchen3d 按相机方位角整侧平滑淡出/淡入
  const wallFadeMats = { n: [], s: [], e: [], w: [] };
  const fadeClone = {}; // side → Map<源材质, 该侧克隆>
  const sideMat = (side, src) => {
    const cache = fadeClone[side] || (fadeClone[side] = new Map());
    if (!cache.has(src)) { const c = src.clone(); cache.set(src, c); wallFadeMats[side].push(c); }
    return cache.get(src);
  };
  const tagWall = (side, meshes) => { for (const m of meshes) m.userData.wallSide = side; };
  const mkWall = (x, z, w, d, h = 1.7, m = wallMat, side = null) => {
    const wall = box(w, h, d, side ? sideMat(side, m) : m);
    wall.position.set(x, h / 2, z);
    const cap = box(w + 0.06, 0.1, d + 0.06, side ? sideMat(side, capMat) : capMat);
    cap.position.set(x, h + 0.05, z);
    if (side) tagWall(side, [wall, cap]);
    group.add(wall, cap);
  };
  const N = -(GH - 1) / 2 - 0.66, S = (GH - 1) / 2 + 0.66, W = -(GW - 1) / 2 - 0.66, E = (GW - 1) / 2 + 0.66;
  // 北墙·出餐口开放式传菜窗：窗洞开在出餐工位(ix=5,6)正上方，两侧砖墙+墙垛支撑，
  // 上方砖过梁托住订单票杆(decor)与厨房名牌(kitchen3d)，窗台加宽成贯通内外的出餐吧台
  const WIN_X = 1.35;   // 窗洞半宽
  const SILL_Y = 1.16;  // 出餐吧台面上沿 = 窗洞下沿（第一程飞菜落点高度 1.15 恰好落上吧台）
  const HEAD_Y = 2.2;   // 窗洞上沿 = 过梁下沿
  const PIER_X = WIN_X + 0.18; // 墙垛中心（内缘与窗洞齐平）
  mkWall(-(6.65 + PIER_X + 0.21) / 2, N, 6.65 - PIER_X - 0.21, 0.3, 3.2, brickMat, 'n'); // 北墙·左段（挂饰舞台）
  mkWall((6.65 + PIER_X + 0.21) / 2, N, 6.65 - PIER_X - 0.21, 0.3, 3.2, brickMat, 'n');  // 北墙·右段
  for (const px of [-PIER_X, PIER_X]) { // 窗洞两侧砖墙垛（比墙面略凸，撑住过梁）
    const pier = box(0.42, HEAD_Y, 0.46, sideMat('n', brickMat));
    pier.position.set(px, HEAD_Y / 2, N);
    const pierCap = box(0.52, 0.1, 0.54, sideMat('n', capMat));
    pierCap.position.set(px, HEAD_Y + 0.05, N);
    tagWall('n', [pier, pierCap]);
    group.add(pier, pierCap);
  }
  const header = box(PIER_X * 2 + 0.42, 3.2 - HEAD_Y, 0.3, sideMat('n', brickMat)); // 砖过梁
  header.position.set(0, (3.2 + HEAD_Y) / 2, N);
  const headerCap = box(PIER_X * 2 + 0.42, 0.1, 0.36, sideMat('n', capMat));
  headerCap.position.set(0, 3.25, N);
  tagWall('n', [header, headerCap]);
  group.add(header, headerCap);
  // 窗洞木衬框（嵌在墙体内，左右上三边；下边即吧台面）
  const trimMat = mat('frameWood', PAL.frameWood);
  for (const tx of [-WIN_X + 0.05, WIN_X - 0.05]) {
    const trim = box(0.1, HEAD_Y - SILL_Y, 0.34, sideMat('n', trimMat));
    trim.position.set(tx, (SILL_Y + HEAD_Y) / 2, N);
    trim.userData.wallSide = 'n';
    group.add(trim);
  }
  const trimTop = box(WIN_X * 2, 0.1, 0.34, sideMat('n', trimMat));
  trimTop.position.set(0, HEAD_Y - 0.05, N);
  trimTop.userData.wallSide = 'n';
  group.add(trimTop);
  // 出餐吧台：贯通厨房与餐厅的木台面（等位菜盘在餐厅一侧排队，见 dining.js）
  const barTop = box(3.4, 0.12, 1.2, mat('counterTop', PAL.counterTop));
  barTop.position.set(0, SILL_Y - 0.06, N - 0.24);
  const barFascia = box(3.46, 0.15, 0.06, capMat); // 前檐深色描边
  barFascia.position.set(0, SILL_Y - 0.07, N - 0.85);
  group.add(barTop, barFascia);
  for (const bx of [-1.35, 1.35]) { // 吧台前腿（落到外地面）
    const leg = box(0.14, SILL_Y + 0.02, 0.14, trimMat);
    leg.position.set(bx, (SILL_Y - 0.22) / 2, N - 0.72);
    group.add(leg);
  }
  // 木质雨棚：红白拼色板条斜顶（餐厅感）+ 前檐招牌板 + 两斜撑（罩住餐厅一侧吧台）
  // 雨棚整体随北墙一起淡出（出餐吧台台面/前檐/腿不淡，保持出餐口-餐厅衔接可读）
  const slatRed = mat('lampShade', PAL.lampShade, { roughness: 0.85 });
  const slatWhite = mat('paper', PAL.paper, { roughness: 0.85 });
  for (let i = 0; i < 7; i++) { // 沿 x 交替拼色，整列随前檐一起下斜
    const slat = box(0.53, 0.07, 1.2, sideMat('n', i % 2 ? slatWhite : slatRed));
    slat.position.set(-1.59 + i * 0.53, 2.66, N - 0.72);
    slat.rotation.x = -0.24; // 前（北）檐压低
    slat.userData.wallSide = 'n';
    group.add(slat);
  }
  // 前檐招牌板：立在雨棚前缘，板面越过墙顶视线、迎着镜头，中央挂 🍽 小招牌
  const awnValance = box(3.7, 0.3, 0.05, sideMat('n', capMat));
  awnValance.position.set(0, 2.44, N - 1.31);
  awnValance.userData.wallSide = 'n';
  const valanceIcon = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26),
    new THREE.MeshBasicMaterial({ map: iconTexture('🍽'), transparent: true }));
  valanceIcon.position.set(0, 2.44, N - 1.27);
  valanceIcon.userData.wallSide = 'n';
  wallFadeMats.n.push(valanceIcon.material); // 独立材质直接纳入北墙淡出组
  group.add(awnValance, valanceIcon);
  for (const sx of [-1.55, 1.55]) {
    const strut = box(0.07, 0.55, 0.07, sideMat('n', trimMat));
    strut.position.set(sx, 2.42, N - 0.55);
    strut.rotation.x = 0.65;
    strut.userData.wallSide = 'n';
    group.add(strut);
  }
  // 暖灯串：挂在招牌板下沿一排小灯泡，中段微微下垂（越过墙顶可见，兼作餐厅氛围光）
  const bulbMat = mat('awnBulb', PAL.bulb, { emissive: PAL.bulb, emissiveIntensity: 1.4, roughness: 0.5 });
  for (let i = 0; i < 9; i++) {
    const bx = -1.6 + i * 0.4;
    const bulb = new THREE.Mesh(geo('awnBulb', () => new THREE.SphereGeometry(0.05, 8, 6)), sideMat('n', bulbMat));
    bulb.position.set(bx, 2.24 - 0.07 * (1 - (bx / 1.6) ** 2), N - 1.29);
    bulb.userData.wallSide = 'n';
    group.add(bulb);
  }
  mkWall(W, 0, 0.3, GH + 1.3, 1.7, wallMat, 'w'); // 西墙
  mkWall(E, 0, 0.3, GH + 1.3, 1.7, wallMat, 'e'); // 东墙
  mkWall(-3.75, S, 5.5, 0.3, 1.5, wallMat, 's'); // 南墙左段（门洞 x∈[-1,1]）
  mkWall(3.75, S, 5.5, 0.3, 1.5, wallMat, 's');  // 南墙右段
  // 门框 + 门垫（门垫底面抬高 0.01，不与地板顶面共面，避免门口地面 z-fighting）
  const post1 = box(0.24, 2.0, 0.34, mat('frameWood', PAL.frameWood));
  post1.position.set(-1.12, 1.0, S);
  const post2 = post1.clone(); post2.position.x = 1.12;
  const lintel = box(2.5, 0.24, 0.34, mat('frameWood', PAL.frameWood));
  lintel.position.set(0, 2.0, S);
  const matDoor = box(2.0, 0.03, 1.0, mat('wallCap', PAL.wallCap));
  matDoor.position.set(0, 0.025, S - 0.7);
  group.add(post1, post2, lintel, matDoor);
  // 门口 🚪 图标
  const doorIcon = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6),
    new THREE.MeshBasicMaterial({ map: iconTexture('🚪'), transparent: true }));
  doorIcon.position.set(0, 2.45, S + 0.2);
  group.add(doorIcon);

  // 墙面火把 ×2（北墙两端）
  for (const tx of [-4.2, 4.2]) {
    const bracket = box(0.12, 0.3, 0.12, mat('frameWood', PAL.frameWood));
    bracket.position.set(tx, 1.35, N + 0.25);
    const flame = box(0.16, 0.24, 0.16, mat('torch', PAL.flame, { emissive: PAL.flame, emissiveIntensity: 1.2 }));
    flame.position.set(tx, 1.6, N + 0.25);
    const core = box(0.08, 0.12, 0.08, mat('torchCore', PAL.flameCore, { emissive: PAL.flameCore, emissiveIntensity: 1.5 }));
    core.position.set(tx, 1.66, N + 0.25);
    group.add(bracket, flame, core);
  }

  // 工位
  const spots = [];
  for (const s of LAYOUT) spots.push(buildStation(group, s));

  const walk = buildWalkGrid();
  return { group, spots, walk, wallFadeMats };
}

// 释放场景静态资源（共享材质/几何体整体 dispose）
export function disposeKitchen(scene, built) {
  if (!built) return;
  scene.remove(built.group);
  built.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
    }
  });
  for (const k in GEO) { GEO[k].dispose(); delete GEO[k]; }
  for (const k in MAT) { MAT[k].dispose(); delete MAT[k]; }
}
