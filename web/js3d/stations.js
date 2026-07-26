// 厨房静态场景：12×9 地板、矮墙、沿墙台面 + 中央岛台（回字走道≥2格）、全部工位
import * as THREE from '../vendor/three.module.min.js';
import { PAL } from './palette.js';
import { iconTexture } from './textures.js';

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
// kind: counter | board | wok | stove | phone | pressure | serve | crate | sink | plates
// face: 厨师站位朝向 ('n'|'s'|'e'|'w')，approach 由 face 推出
export const LAYOUT = [
  // 北墙一排 (z=0)
  { ix: 0, iz: 0, kind: 'counter' }, { ix: 1, iz: 0, kind: 'crate', icon: '🍅', face: 'n' },
  { ix: 2, iz: 0, kind: 'crate', icon: '🥬', face: 'n' }, { ix: 3, iz: 0, kind: 'plates' },
  { ix: 4, iz: 0, kind: 'counter' }, { ix: 5, iz: 0, kind: 'serve', icon: '🔔', face: 'n' },
  { ix: 6, iz: 0, kind: 'serve', icon: '🔔', face: 'n' }, { ix: 7, iz: 0, kind: 'counter' },
  { ix: 8, iz: 0, kind: 'sink' }, { ix: 9, iz: 0, kind: 'phone', icon: '📞', face: 'n' },
  { ix: 10, iz: 0, kind: 'counter' }, { ix: 11, iz: 0, kind: 'counter' },
  // 西墙一列 (x=0)
  { ix: 0, iz: 1, kind: 'counter' }, { ix: 0, iz: 2, kind: 'crate', icon: '🥩', face: 'w' },
  { ix: 0, iz: 3, kind: 'counter' }, { ix: 0, iz: 4, kind: 'counter' },
  { ix: 0, iz: 5, kind: 'counter' }, { ix: 0, iz: 6, kind: 'counter' },
  { ix: 0, iz: 7, kind: 'counter' },
  // 东墙一列 (x=11)
  { ix: 11, iz: 1, kind: 'counter' }, { ix: 11, iz: 2, kind: 'counter' },
  { ix: 11, iz: 3, kind: 'counter' }, { ix: 11, iz: 4, kind: 'counter' },
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
  { ix: 7, iz: 4, kind: 'counter' },
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
    case 'board': { // 案板：白砧板 + 菜刀
      const board = box(0.6, 0.05, 0.4, mat('board', PAL.board));
      board.position.set(x, topY + 0.025, z);
      const blade = box(0.3, 0.02, 0.08, mat('knife', PAL.knife, { metalness: 0.4, roughness: 0.5 }));
      blade.position.set(x + 0.08, topY + 0.06, z);
      const handle = box(0.12, 0.03, 0.05, mat('wallCap', PAL.wallCap));
      handle.position.set(x - 0.13, topY + 0.06, z);
      sub.add(board, blade, handle);
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
    case 'stove': { // 灶台：黑炉盘 + 红点 + 金属锅
      const plate = new THREE.Mesh(geo('stovePlate', () => new THREE.CylinderGeometry(0.32, 0.32, 0.06, 20)), mat('stoveTop', PAL.stoveTop));
      plate.position.set(x, topY + 0.03, z);
      plate.castShadow = true;
      const dot = new THREE.Mesh(geo('stoveDot', () => new THREE.CylinderGeometry(0.06, 0.06, 0.02, 10)), mat('redGlow', PAL.red, { emissive: PAL.red, emissiveIntensity: 0.6 }));
      dot.position.set(x + 0.34, topY + 0.05, z + 0.3);
      const pot = new THREE.Mesh(geo('pot', () => new THREE.CylinderGeometry(0.26, 0.24, 0.28, 14)), mat('metal', PAL.metal, { metalness: 0.3, roughness: 0.6 }));
      pot.position.set(x, topY + 0.2, z);
      pot.castShadow = true;
      const glow = new THREE.Mesh(geo('stoveGlow', () => new THREE.CylinderGeometry(0.34, 0.34, 0.02, 20)),
        new THREE.MeshBasicMaterial({ color: PAL.flame, transparent: true, opacity: 0.0 }));
      glow.position.set(x, topY + 0.045, z);
      sub.add(plate, dot, pot, glow);
      spot.pot = pot; spot.glow = glow; spot.stoveId = s.stoveId;
      break;
    }
    case 'phone': { // 电话台：红色座机
      const base = box(0.34, 0.1, 0.26, mat('red', PAL.red));
      base.position.set(x, topY + 0.05, z);
      const receiver = box(0.3, 0.06, 0.09, mat('red', PAL.red));
      receiver.position.set(x, topY + 0.14, z);
      sub.add(base, receiver);
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
    case 'serve': { // 出餐口台面：金属格栅小平台 + 铃铛
      const tray = box(0.8, 0.04, 0.5, mat('grate', PAL.grate, { metalness: 0.4, roughness: 0.5 }));
      tray.position.set(x, topY + 0.02, z);
      const bell = new THREE.Mesh(geo('bell', () => new THREE.SphereGeometry(0.12, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)),
        mat('bellGold', 0xF2C230, { metalness: 0.5, roughness: 0.4 }));
      bell.position.set(x - 0.28, topY + 0.04, z + 0.12);
      bell.castShadow = true;
      sub.add(tray, bell);
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
    case 'plates': { // 盘子摞
      for (let i = 0; i < 4; i++) {
        const p = new THREE.Mesh(geo('plate', () => new THREE.CylinderGeometry(0.25, 0.22, 0.045, 14)), mat('plate', PAL.plate));
        p.position.set(x, topY + 0.03 + i * 0.05, z);
        p.castShadow = true;
        sub.add(p);
      }
      break;
    }
    case 'sink': { // 水池
      const basin = box(0.7, 0.08, 0.6, mat('steelM', PAL.steel, { metalness: 0.35, roughness: 0.5 }));
      basin.position.set(x, topY + 0.02, z);
      const waterM = box(0.6, 0.02, 0.5, mat('water', PAL.water, { roughness: 0.3 }));
      waterM.position.set(x, topY + 0.06, z);
      sub.add(basin, waterM);
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

  // 地板 12×9 双色暖木相间
  const floorGeoA = new THREE.BoxGeometry(1, 0.1, 1);
  for (let iz = 0; iz < GH; iz++) {
    for (let ix = 0; ix < GW; ix++) {
      const light = (ix + iz) % 2 === 0;
      const tile = new THREE.Mesh(floorGeoA, mat(light ? 'floorL' : 'floorD', light ? PAL.floorLight : PAL.floorDark));
      const { x, z } = cellToWorld(ix, iz);
      tile.position.set(x, -0.05, z);
      tile.receiveShadow = true;
      group.add(tile);
    }
  }
  // 厨房外大地面（压暗）
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), mat('outer', PAL.groundOut));
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.12;
  outer.receiveShadow = true;
  group.add(outer);

  // 矮墙（高 1.5、厚 0.3、带压顶），南墙留门
  const wallMat = mat('wall', PAL.wall);
  const capMat = mat('wallCap', PAL.wallCap);
  const mkWall = (x, z, w, d) => {
    const wall = box(w, 1.5, d, wallMat);
    wall.position.set(x, 0.75, z);
    const cap = box(w + 0.06, 0.1, d + 0.06, capMat);
    cap.position.set(x, 1.55, z);
    group.add(wall, cap);
  };
  const N = -(GH - 1) / 2 - 0.66, S = (GH - 1) / 2 + 0.66, W = -(GW - 1) / 2 - 0.66, E = (GW - 1) / 2 + 0.66;
  mkWall(0, N, GW + 1.3, 0.3);            // 北墙
  mkWall(W, 0, 0.3, GH + 1.3);            // 西墙
  mkWall(E, 0, 0.3, GH + 1.3);            // 东墙
  mkWall(-3.75, S, 5.5, 0.3);             // 南墙左段（门洞 x∈[-1,1]）
  mkWall(3.75, S, 5.5, 0.3);              // 南墙右段
  // 门框 + 门垫
  const post1 = box(0.24, 2.0, 0.34, mat('frameWood', PAL.frameWood));
  post1.position.set(-1.12, 1.0, S);
  const post2 = post1.clone(); post2.position.x = 1.12;
  const lintel = box(2.5, 0.24, 0.34, mat('frameWood', PAL.frameWood));
  lintel.position.set(0, 2.0, S);
  const matDoor = box(2.0, 0.03, 1.0, mat('wallCap', PAL.wallCap));
  matDoor.position.set(0, 0.015, S - 0.7);
  group.add(post1, post2, lintel, matDoor);
  // 门口 🚪 图标
  const doorIcon = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6),
    new THREE.MeshBasicMaterial({ map: iconTexture('🚪'), transparent: true }));
  doorIcon.position.set(0, 2.45, S + 0.2);
  group.add(doorIcon);

  // 出餐口窗洞（北墙中央上方窗框 + 格栅）
  const win = new THREE.Group();
  const winZ = N + 0.05;
  const mkBar = (w, h, px, py) => {
    const b = box(w, h, 0.18, mat('frameWood', PAL.frameWood));
    b.position.set(px, py, winZ);
    win.add(b);
  };
  mkBar(2.4, 0.16, 0, 2.06);         // 上框
  mkBar(2.4, 0.14, 0, 1.02);         // 下框（窗台）
  mkBar(0.16, 1.2, -1.12, 1.54);     // 左框
  mkBar(0.16, 1.2, 1.12, 1.54);      // 右框
  const hole = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 0.9),
    new THREE.MeshBasicMaterial({ color: 0x120D18 }));
  hole.position.set(0, 1.54, winZ - 0.1);
  win.add(hole);
  for (let i = 0; i < 3; i++) { // 金属格栅竖条
    const bar = box(0.05, 0.9, 0.05, mat('grate', PAL.grate, { metalness: 0.4 }));
    bar.position.set(-0.5 + i * 0.5, 1.54, winZ - 0.02);
    win.add(bar);
  }
  group.add(win);

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
  return { group, spots, walk };
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
