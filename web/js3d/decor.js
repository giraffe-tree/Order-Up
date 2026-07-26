// 场景装饰：吊灯（点光源）、火把点光、北墙挂饰（挂锅架 / 暖窗 / 菜单黑板 / 置物架 / 订单票杆）
// 全部低多边形程序化生成，共享几何体/材质；禁外部资源。
// buildDecor(parent) → { group, update(t), setDim(d), dispose() }
import * as THREE from '../vendor/three.module.min.js';
import { PAL } from './palette.js';
import { chalkboardTexture } from './textures.js';

// ---------- 共享几何体 / 材质缓存 ----------
const DGEO = {};
const DMAT = {};
function geo(key, make) { return DGEO[key] || (DGEO[key] = make()); }
function mat(key, color, opts = {}) {
  return DMAT[key] || (DMAT[key] = new THREE.MeshStandardMaterial({
    color, flatShading: true, roughness: opts.roughness ?? 0.9, metalness: opts.metalness ?? 0,
    emissive: opts.emissive || 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 1,
  }));
}
function box(w, h, d, m) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.castShadow = true;
  return mesh;
}

// ---------- 吊灯 ----------
function buildPendant(g, x, z, flickers) {
  const wire = new THREE.Mesh(geo('lampWire', () => new THREE.CylinderGeometry(0.012, 0.012, 1.8, 6)), mat('lampWire', PAL.wallCap));
  wire.position.set(x, 3.62, z);
  wire.castShadow = false; // 细电线不投影，避免地面出现长杆状阴影
  const shade = new THREE.Mesh(geo('lampShade', () => new THREE.CylinderGeometry(0.09, 0.27, 0.18, 12, 1, true)),
    mat('lampShade', PAL.lampShade, { roughness: 0.7 }));
  shade.position.set(x, 2.68, z);
  shade.castShadow = true;
  const shadeRim = new THREE.Mesh(geo('lampRim', () => new THREE.CylinderGeometry(0.28, 0.28, 0.03, 12, 1, true)),
    mat('lampRim', PAL.wallCap));
  shadeRim.position.set(x, 2.6, z);
  const bulb = new THREE.Mesh(geo('bulb', () => new THREE.SphereGeometry(0.07, 10, 8)),
    mat('bulb', PAL.bulb, { emissive: PAL.bulb, emissiveIntensity: 1.6, roughness: 0.4 }));
  bulb.position.set(x, 2.56, z);
  // 向下的暖光晕片（顶视角也能感到灯在亮）
  const halo = new THREE.Mesh(geo('lampHalo', () => new THREE.CircleGeometry(0.2, 12)),
    new THREE.MeshBasicMaterial({ color: PAL.bulb, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
  halo.rotation.x = Math.PI / 2;
  halo.position.set(x, 2.585, z);
  const light = new THREE.PointLight(PAL.lampLight, 16, 11, 1.8);
  light.position.set(x, 2.45, z);
  g.add(wire, shade, shadeRim, bulb, halo, light);
  flickers.push({ light, base: 16, amp: 0.045, sp: 6.3, ph: x });
}

// ---------- 火把点光（火焰盒体在 stations.js，灯光在这里） ----------
function buildTorchLight(g, x, y, z, flickers) {
  const light = new THREE.PointLight(PAL.torchLight, 9, 7.5, 2);
  light.position.set(x, y, z);
  g.add(light);
  flickers.push({ light, base: 9, amp: 0.22, sp: 9.7, ph: x * 2.1 });
}

// ---------- 北墙挂饰（z = 墙面内侧前方） ----------
// 挂锅架：横杆 + 挂钩 + 3 口大小不一的平底锅
function buildPanRack(g, x0, y, z) {
  const bar = new THREE.Mesh(geo('panBar', () => new THREE.CylinderGeometry(0.025, 0.025, 1.5, 8)),
    mat('metal', PAL.metal, { metalness: 0.35, roughness: 0.55 }));
  bar.rotation.z = Math.PI / 2;
  bar.position.set(x0, y, z);
  bar.castShadow = true;
  g.add(bar);
  const sizes = [0.24, 0.19, 0.28];
  sizes.forEach((r, i) => {
    const px = x0 - 0.5 + i * 0.5;
    const hook = box(0.03, 0.12, 0.03, mat('metal', PAL.metal));
    hook.position.set(px, y - 0.06, z);
    const pan = new THREE.Mesh(geo('pan' + i, () => new THREE.CylinderGeometry(r, r * 0.86, 0.05, 14)),
      mat('stoveTop', PAL.stoveTop));
    pan.rotation.x = Math.PI / 2;
    pan.position.set(px, y - 0.18 - r, z);
    pan.castShadow = true;
    const handle = box(0.05, r * 1.3, 0.03, mat('stoveTop', PAL.stoveTop));
    handle.position.set(px, y - 0.14 - r * 2 - r * 0.5, z);
    g.add(hook, pan, handle);
  });
}

// 暖窗：木框 + 自发光暖玻璃 + 十字棂 + 小窗台
function buildWindow(g, x, y, z) {
  const frame = box(1.15, 1.5, 0.1, mat('frameWood', PAL.frameWood));
  frame.position.set(x, y, z);
  const glass = new THREE.Mesh(geo('winGlass', () => new THREE.PlaneGeometry(0.96, 1.3)),
    new THREE.MeshStandardMaterial({
      color: PAL.glassWarm, emissive: PAL.glassWarm, emissiveIntensity: 0.85,
      roughness: 0.6, metalness: 0,
    }));
  glass.position.set(x, y, z + 0.055);
  const mullV = box(0.06, 1.3, 0.04, mat('frameWood', PAL.frameWood));
  mullV.position.set(x, y, z + 0.075);
  const mullH = box(0.96, 0.06, 0.04, mat('frameWood', PAL.frameWood));
  mullH.position.set(x, y, z + 0.075);
  const sill = box(1.3, 0.08, 0.2, mat('frameWood', PAL.frameWood));
  sill.position.set(x, y - 0.79, z + 0.05);
  g.add(frame, glass, mullV, mullH, sill);
}

// 菜单黑板：木框 + 粉笔菜单纹理
function buildBlackboard(g, x, y, z, texHolder) {
  const frame = box(1.14, 0.9, 0.08, mat('frameWood', PAL.frameWood));
  frame.position.set(x, y, z);
  const tex = chalkboardTexture();
  texHolder.push(tex);
  const board = new THREE.Mesh(geo('chalkPlane', () => new THREE.PlaneGeometry(1.0, 0.76)),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  board.position.set(x, y, z + 0.045);
  g.add(frame, board);
}

// 置物架：搁板 + 托架 + 3 个调料罐
function buildShelf(g, x, y, z) {
  const board = box(1.15, 0.06, 0.26, mat('crateWood', PAL.crateWood));
  board.position.set(x, y, z + 0.1);
  const br1 = box(0.06, 0.16, 0.2, mat('wallCap', PAL.wallCap));
  br1.position.set(x - 0.42, y - 0.11, z + 0.08);
  const br2 = br1.clone(); br2.position.x = x + 0.42;
  g.add(board, br1, br2);
  const jarCols = [PAL.spiceRed, PAL.spiceYolk, PAL.spiceGreen];
  jarCols.forEach((col, i) => {
    const jar = new THREE.Mesh(geo('jar', () => new THREE.CylinderGeometry(0.095, 0.095, 0.24, 10)),
      mat('jar' + i, col, { roughness: 0.6 }));
    jar.position.set(x - 0.32 + i * 0.32, y + 0.15, z + 0.1);
    jar.castShadow = true;
    const lid = new THREE.Mesh(geo('jarLid', () => new THREE.CylinderGeometry(0.1, 0.1, 0.05, 10)),
      mat('wallCap', PAL.wallCap));
    lid.position.set(x - 0.32 + i * 0.32, y + 0.295, z + 0.1);
    g.add(jar, lid);
  });
}

// 订单票杆：金属横杆 + 4 张微微倾斜的票纸（出餐口上方）
function buildTicketRail(g, x, y, z) {
  const rod = new THREE.Mesh(geo('ticketRod', () => new THREE.CylinderGeometry(0.02, 0.02, 1.7, 8)),
    mat('grate', PAL.grate, { metalness: 0.4, roughness: 0.5 }));
  rod.rotation.z = Math.PI / 2;
  rod.position.set(x, y, z);
  g.add(rod);
  const tilt = [-0.06, 0.05, -0.04, 0.07];
  for (let i = 0; i < 4; i++) {
    const t = box(0.24, 0.34, 0.012, mat('ticketPaper', PAL.ticketPaper, { roughness: 1 }));
    t.position.set(x - 0.6 + i * 0.4, y - 0.19, z + 0.01);
    t.rotation.z = tilt[i];
    g.add(t);
    const stripe = box(0.24, 0.05, 0.014, mat('red', PAL.red));
    stripe.position.set(x - 0.6 + i * 0.4, y - 0.075, z + 0.012);
    stripe.rotation.z = tilt[i];
    g.add(stripe);
  }
}

// ---------- 总装 ----------
export function buildDecor(parent, { wallN = -4.66 } = {}) {
  const g = new THREE.Group();
  parent.add(g);
  const flickers = [];
  const texHolder = [];
  const zWall = wallN + 0.15 + 0.04; // 北墙内侧面再往前一点

  // 吊灯 ×2（南走道上方，避开岛台/灶台视线遮挡）
  buildPendant(g, -2.5, 2.3, flickers);
  buildPendant(g, 2.5, 2.3, flickers);
  // 火把点光 ×2（配合 stations.js 的火把盒体）
  buildTorchLight(g, -4.2, 1.85, wallN + 0.5, flickers);
  buildTorchLight(g, 4.2, 1.85, wallN + 0.5, flickers);

  // 北墙挂饰：挂锅架 | 暖窗 | 出餐口 | 菜单黑板 | 暖窗 | 置物架
  buildPanRack(g, -5.1, 2.55, zWall);
  buildWindow(g, -3.4, 2.4, zWall);
  buildTicketRail(g, 0, 2.28, zWall + 0.08);
  buildBlackboard(g, 2.15, 1.95, zWall, texHolder);
  buildWindow(g, 3.6, 2.4, zWall);
  buildShelf(g, 5.15, 1.95, zWall);

  let dim = 1;
  return {
    group: g,
    setDim(d) { dim = d; },
    update(t) {
      for (const f of flickers) {
        f.light.intensity = f.base * dim *
          (1 + f.amp * Math.sin(t * f.sp + f.ph) + f.amp * 0.55 * Math.sin(t * f.sp * 1.83 + f.ph * 2.7));
      }
    },
    dispose() {
      parent.remove(g);
      g.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
        }
      });
      for (const k in DGEO) { DGEO[k].dispose(); delete DGEO[k]; }
      for (const k in DMAT) { DMAT[k].dispose(); delete DMAT[k]; }
    },
  };
}
