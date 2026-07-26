// 粒子 / 特效系统：共享几何体 + 固定容量对象池，单入口 update
import * as THREE from '../vendor/three.module.min.js';
import { PAL } from './palette.js';
import { plankTexture } from './textures.js';

const MAX_PARTICLES = 320;

const KINDS = {
  chop:   { color: 0xFFFFFF, grav: -6.0, drag: 0.92, life: 0.55, size: 0.07, spin: 8 },
  dust:   { color: PAL.dust, grav: 0.6,  drag: 0.90, life: 0.50, size: 0.09, spin: 4 },
  steam:  { color: 0xF6F2E8, grav: 1.6,  drag: 0.96, life: 1.10, size: 0.10, spin: 2 },
  smoke:  { color: PAL.smoke, grav: 2.2, drag: 0.97, life: 1.60, size: 0.13, spin: 2 },
  flame:  { color: PAL.flame, grav: 2.6, drag: 0.94, life: 0.55, size: 0.10, spin: 6 },
  spark:  { color: PAL.flameCore, grav: 0.4, drag: 0.92, life: 0.45, size: 0.06, spin: 10 },
};

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
    this._foodGeo = new THREE.BoxGeometry(0.22, 0.12, 0.22);
    this._dishMat = new THREE.MeshStandardMaterial({ color: PAL.plate, flatShading: true, roughness: 0.8 });
    this._foodMat = new THREE.MeshStandardMaterial({ color: PAL.flame, flatShading: true, roughness: 0.9 });
    this._foodMat2 = new THREE.MeshStandardMaterial({ color: 0x58B24C, flatShading: true, roughness: 0.9 });
  }

  spawn(kind, x, y, z, vx = 0, vy = 0, vz = 0, scale = 1) {
    const m = this.pool.pop();
    if (!m) return;
    const k = KINDS[kind];
    m.material = this.mats[kind];
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

  // 出餐：菜品从出餐口飞出 + 「出餐 +1」弹出
  dishServed(from) {
    const g = new THREE.Group();
    const plate = new THREE.Mesh(this._dishGeo, this._dishMat);
    const food = new THREE.Mesh(this._foodGeo, Math.random() > 0.5 ? this._foodMat : this._foodMat2);
    food.position.y = 0.08;
    food.rotation.y = Math.random();
    g.add(plate, food);
    g.position.copy(from);
    this.scene.add(g);
    this.flyers.push({ g, t: 0, life: 1.25, spin: 7 + Math.random() * 4 });
    this.popup('出餐 +1', new THREE.Vector3(from.x, from.y + 0.5, from.z + 0.3), '#D94F3D');
  }

  popup(text, pos, color = '#D94F3D') {
    const tex = plankTexture(text, { w: 300, h: 90, fontSize: 46, bg: '#F5EBD7', fg: color });
    this._popupWith(tex, pos);
  }

  _popupWith(tex, pos) {
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const s = new THREE.Sprite(mat);
    s.scale.set(1.5, 0.45, 1);
    s.position.copy(pos);
    this.scene.add(s);
    this.popups.push({ s, t: 0, life: 1.4 });
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
      p.m.scale.setScalar(Math.max(0.001, p.size * u * grow));
    }
    // 飞菜
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i];
      f.t += dt;
      if (f.t >= f.life) {
        this.scene.remove(f.g);
        this.flyers.splice(i, 1);
        continue;
      }
      const u = f.t / f.life;
      f.g.position.z -= dt * 3.2;          // 飞进窗口（北）
      f.g.position.y += dt * (2.2 - u * 2.6); // 先扬后落
      f.g.rotation.y += f.spin * dt;
      f.g.scale.setScalar(1 - u * 0.55);
    }
    // 弹出字
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.t += dt;
      if (p.t >= p.life) {
        p.s.material.map.dispose();
        p.s.material.dispose();
        this.scene.remove(p.s);
        this.popups.splice(i, 1);
        continue;
      }
      const u = p.t / p.life;
      p.s.position.y += dt * 0.9;
      p.s.material.opacity = u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
    }
  }

  dispose() {
    for (const m of this.pool) this.scene.remove(m);
    for (const p of this.live) this.scene.remove(p.m);
    for (const f of this.flyers) this.scene.remove(f.g);
    for (const p of this.popups) { p.s.material.map.dispose(); p.s.material.dispose(); this.scene.remove(p.s); }
    this.pool = []; this.live = []; this.flyers = []; this.popups = []; this.emitters = [];
    this.geo.dispose();
    for (const k in this.mats) this.mats[k].dispose();
    this._dishGeo.dispose(); this._foodGeo.dispose();
    this._dishMat.dispose(); this._foodMat.dispose(); this._foodMat2.dispose();
  }
}
