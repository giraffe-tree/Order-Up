// 餐厅区：出餐吧台前的露天小餐厅 —— 木平台 / 餐桌椅 / 蜡烛 / 卡通客人 / 服务员小二
// 上菜动线：厨师 → 出餐口吧台（kitchen3d.dishServed 第一程）→ 本模块接力第二程：
// 吧台排队（最多 4 盘可见）→ 有等菜客人 → 服务员小碎步到吧台前取餐、顶盘送到客人桌上
// → 客人低头用餐 8–15 秒（中途弹「好吃！」）→ 满意起身、从北门径走入夜色消失（回池复用）
// → 新客人陆续从北门径入场落座。服务员一次端一盘，送完再取下一盘（吧台可短暂积盘）。
// 客人等菜超过 PATIENCE 秒没吃到会失望离席；满座时新菜在吧台排队。
// 歇业（setDim<1）：蜡烛光晕收敛、服务员不再接新单（手上的送完）、不再迎接新客人，
// 在座客人吃完/等不到陆续离开。
// 全部程序化低模：几何/材质走模块级共享缓存；客人固定池（MAX_GUESTS）复用，零每帧分配。
// 餐桌拉到出餐吧台正前方，与厨房隔窗相望连成一体；z 区间经过视线计算：
// 默认 60° 俯角下 z≈-8.0 视线恰好擦过 3.2 砖墙顶落地，桌椅客人完整可见（再近会被墙挡）。
// buildDining(scene, fx) → { group, update(dt, t), serveDish(name), setDim(d), stats(), dispose() }
import * as THREE from '../vendor/three.module.min.js';
import { PAL } from './palette.js';
import { GH } from './stations.js';
import { glowDiscTexture } from './textures.js';
import { dishLook } from './dishes.js';
import { buildDishFood, disposeDishCache } from './fx.js';

const GY = -0.12;                                              // 外地面上表面（与 stations/backdrop 一致）
const WIN = { x: 0, y: 1.15, z: -(GH - 1) / 2 - 0.66 + 0.3 };  // 出餐口吧台内侧（第二程起飞点，同 kitchen3d 落点）
const SILL = { y: 1.19, z: -(GH - 1) / 2 - 0.66 - 0.04 };      // 等位菜盘在吧台面上的摆放高度/进深
const GATE = { x: 0, z: -10.9 };                               // 北栅栏门径（backdrop 在北面留的缺口）
const SPAWN_Z = -13.8;                                         // 客人入场/退场没入夜色的位置
const MAX_GUESTS = 6;                                          // 客人池（≥ 座位数：离席路上的也占一个）
const MAX_SILL = 4;                                            // 吧台上可见的等位菜盘
const MAX_QUEUE = 6;                                           // 吧台排队上限，溢出直接丢弃（高频出餐不堆积）
const PATIENCE = 26;                                           // 等菜耐心（秒），超时空手离席
const TABLE_TOP = 0.69;                                        // 餐桌面上沿高度
const BACK_LANE = -9.5;                                        // 餐桌北侧后巷（服务员送餐/回位走廊，不跨客人入场动线）

// 餐桌：出餐吧台正前方一排，客人围坐吧台前等菜，与厨房隔传菜窗相望；
// 座位在桌子东西侧面对面（z 向只伸出桌面半径，不顶到北栅栏）；
// z ≈ -8.0 是视线临界：默认 60° 俯角下视线恰好擦过 3.2 砖墙顶落到地面，
// 客人全身/桌椅完整可见（再近会被墙挡下半身，再远就与吧台脱节）
const TABLES = [
  { x: -2.4, z: -8.0, seats: 2 },
  { x: 0.1, z: -8.3, seats: 2 },
  { x: 2.5, z: -8.0, seats: 1 },
];

// 便服配色：低饱和日常色，与厨师制服色板（CHEF_OUTFITS 高饱和）明显区分
const OUTFITS = ['#7E93B8', '#C08A5E', '#9A82B0', '#6FA08C', '#B0766E', '#A89A62', '#5E8CA0', '#B0829A'];
const PANTS = [0x4A4458, 0x5A4A3A, 0x3E4A52, 0x54423E];
const HAIR_COLS = [0x4A3828, 0x2E2620, 0x7A5636, 0x8C8C94, 0xB87A4A];
const SKINS = [0xF2C9A0, 0xEAB98C, 0xD89E6E, 0xF7DDBB];
const PRAISE = ['好吃！', '满足～', '赞！', '再来一份！'];

// ---------- 共享几何体 / 材质缓存 ----------
const GEO = {};
const MAT = {};
function geo(key, make) { return GEO[key] || (GEO[key] = make()); }
function mat(key, color, opts = {}) {
  return MAT[key] || (MAT[key] = new THREE.MeshStandardMaterial({
    color, flatShading: true, roughness: opts.roughness ?? 0.92, metalness: 0,
    emissive: opts.emissive || 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 1,
  }));
}
function box(w, h, d, m) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.castShadow = true;
  return mesh;
}

// 给餐盘容器挂上对应菜品（同菜名不重建；小菜件几何/材质走 fx 共享缓存，仅低频重建）
function setPlateDish(holder, name, plateR = 0.2) {
  const look = dishLook(name);
  if (holder._dishName === look.name) return;
  holder._dishName = look.name;
  if (holder._food) holder.remove(holder._food);
  const food = buildDishFood(look, plateR);
  food.position.y = 0.028;
  holder.add(food);
  holder._food = food;
}

// ---------- 客人（Q 版低模：无厨师帽、便服、发型/针织帽，与厨师一眼区分） ----------
// 状态机：idle(池中) → walkin → seated(等菜) → served(菜在飞) → eating → done(回味) → leaving → idle
class Guest {
  constructor(fx) {
    this.fx = fx;
    this.state = 'idle';
    this.group = new THREE.Group();
    this.group.visible = false;
    this.path = [];
    this.seat = null;
    this.animT = Math.random() * 10;
    this.faceY = 0;
    this._build();
  }

  _build() {
    this.body = new THREE.Group();
    this.group.add(this.body);
    this.figure = new THREE.Group();
    this.body.add(this.figure);
    const F = this.figure;

    // 上衣 + 裤腰（材质在 spawn 时按形象换装，均来自共享缓存）
    this.torso = new THREE.Mesh(geo('gTorso', () => new THREE.CylinderGeometry(0.24, 0.28, 0.5, 14)));
    this.torso.position.y = 0.38;
    this.torso.castShadow = true;
    this.pants = new THREE.Mesh(geo('gPants', () => new THREE.CylinderGeometry(0.28, 0.3, 0.16, 14)));
    this.pants.position.y = 0.14;
    F.add(this.torso, this.pants);
    // 脸
    this.face = new THREE.Mesh(geo('gFace', () => new THREE.SphereGeometry(0.16, 12, 10)));
    this.face.position.set(0, 0.7, 0.08);
    this.face.castShadow = true;
    F.add(this.face);
    // 眼睛（高光点 + 眨眼压缩，同厨师程序化脸）
    const eyeMat = mat('gEye', 0x2A2138);
    const hlMat = mat('gEyeHL', 0xFFFDF6);
    this.eyeGroup = new THREE.Group();
    this.eyeGroup.position.set(0, 0.73, 0.2);
    for (const dx of [-0.055, 0.055]) {
      const eye = new THREE.Mesh(geo('gEye', () => new THREE.SphereGeometry(0.023, 6, 5)), eyeMat);
      eye.position.set(dx, 0, 0.02);
      const hl = new THREE.Mesh(geo('gEyeHL', () => new THREE.SphereGeometry(0.008, 4, 3)), hlMat);
      hl.position.set(dx + 0.011, 0.011, 0.042);
      this.eyeGroup.add(eye, hl);
    }
    F.add(this.eyeGroup);
    // 手臂（衣袖便服色 + 肤色手，无白手套——与厨师的区分点之一）
    this.armL = new THREE.Group(); this.armR = new THREE.Group();
    this.armL.position.set(-0.27, 0.5, 0); this.armR.position.set(0.27, 0.5, 0);
    this.hands = [];
    for (const [arm, sx] of [[this.armL, -1], [this.armR, 1]]) {
      const limb = new THREE.Mesh(geo('gLimb', () => new THREE.CylinderGeometry(0.045, 0.045, 0.2, 8)));
      limb.position.y = -0.09;
      arm.add(limb);
      const hand = new THREE.Mesh(geo('gHand', () => new THREE.SphereGeometry(0.075, 8, 6)));
      hand.position.y = -0.21;
      hand.castShadow = true;
      arm.add(hand);
      if (sx === -1) this.armLimbL = limb; else this.armLimbR = limb;
      this.hands.push(hand);
      F.add(arm);
    }
    // 小勺（用餐时右手举起，惰性挂接一次）
    this.spoon = new THREE.Mesh(geo('gSpoon', () => new THREE.CylinderGeometry(0.014, 0.014, 0.15, 6)),
      mat('gSpoon', PAL.steel, { metalness: 0.35, roughness: 0.5 }));
    this.spoon.position.set(0, -0.24, 0.08);
    this.spoon.rotation.x = 0.5;
    this.spoon.visible = false;
    this.armR.add(this.spoon);
    // 深色小鞋尖
    const shoeMat = mat('gShoe', PAL.shoe);
    for (const dx of [-0.11, 0.11]) {
      const shoe = new THREE.Mesh(geo('gShoe', () => new THREE.BoxGeometry(0.12, 0.07, 0.18)), shoeMat);
      shoe.position.set(dx, 0.035, 0.03);
      F.add(shoe);
    }
    // 发型 3 变体（预建后按形象切换可见性）：0 短发盖 | 1 丸子头 | 2 针织帽
    this.hairStyles = [];
    { // 短发盖：压扁球扣在头顶
      const g = new THREE.Group();
      const cap = new THREE.Mesh(geo('gHairCap', () => new THREE.SphereGeometry(0.175, 12, 8)));
      cap.scale.set(1, 0.66, 1);
      cap.position.set(0, 0.79, 0.03);
      cap.castShadow = true;
      const fringe = new THREE.Mesh(geo('gFringe', () => new THREE.BoxGeometry(0.2, 0.05, 0.06)));
      fringe.position.set(0, 0.77, 0.2);
      g.add(cap, fringe);
      g.userData.parts = [cap, fringe];
      this.hairStyles.push(g); F.add(g);
    }
    { // 丸子头：发盖 + 头顶丸子
      const g = new THREE.Group();
      const cap = new THREE.Mesh(geo('gHairCap', () => new THREE.SphereGeometry(0.175, 12, 8)));
      cap.scale.set(1, 0.6, 1);
      cap.position.set(0, 0.78, 0.02);
      const bun = new THREE.Mesh(geo('gBun', () => new THREE.SphereGeometry(0.08, 8, 6)));
      bun.position.set(0, 0.93, -0.02);
      bun.castShadow = true;
      const tie = new THREE.Mesh(geo('gBunTie', () => new THREE.CylinderGeometry(0.085, 0.085, 0.03, 10)),
        mat('gBunTie', PAL.red));
      tie.position.set(0, 0.885, -0.02);
      g.add(cap, bun, tie);
      g.userData.parts = [cap, bun]; // tie 固定红，不换材质
      this.hairStyles.push(g); F.add(g);
    }
    { // 针织帽：帽檐罗纹 + 圆顶 + 绒球（便服感最强）
      const g = new THREE.Group();
      const brim = new THREE.Mesh(geo('gBeanieBrim', () => new THREE.CylinderGeometry(0.19, 0.19, 0.07, 12)));
      brim.position.set(0, 0.8, 0.02);
      const dome = new THREE.Mesh(geo('gBeanieDome', () => new THREE.SphereGeometry(0.18, 12, 8)));
      dome.scale.set(1, 0.6, 1);
      dome.position.set(0, 0.84, 0.02);
      dome.castShadow = true;
      const pompom = new THREE.Mesh(geo('gPompom', () => new THREE.SphereGeometry(0.05, 6, 5)));
      pompom.position.set(0, 0.95, 0.02);
      g.add(brim, dome, pompom);
      g.userData.parts = [brim, dome, pompom]; // 针织帽跟衣服同色系（换装时赋便服材质）
      this.hairStyles.push(g); F.add(g);
    }
  }

  // 出场形象：按流水号确定性派生（同一批客人形象稳定，批次间有变化）
  spawn(seat, look, path) {
    this.seat = seat;
    this.state = 'walkin';
    this.path = path;
    this.animT = Math.random() * 10;
    this._blinkT = 1 + Math.random() * 3;
    this._glanceT = 2 + Math.random() * 4;
    this._glanceYaw = 0;
    this._winT = 3 + Math.random() * 4; // 望向出餐口计时
    const outfitMat = mat('gOut:' + look.outfit, look.outfit);
    const skinMat = mat('gSkin:' + look.skin, look.skin);
    this.torso.material = outfitMat;
    this.armLimbL.material = outfitMat;
    this.armLimbR.material = outfitMat;
    this.pants.material = mat('gPants:' + look.pants, look.pants);
    this.face.material = skinMat;
    for (const h of this.hands) h.material = skinMat;
    const hairMat = look.style === 2 ? outfitMat : mat('gHair:' + look.hair, look.hair);
    this.hairStyles.forEach((g, i) => {
      g.visible = i === look.style;
      if (i === look.style) for (const p of g.userData.parts) p.material = hairMat;
    });
    this.figure.scale.set(look.widthK, look.heightK, look.widthK);
    // 出场姿态复位
    this.group.position.set(path[0].x, 0, path[0].z);
    this.group.rotation.y = 0;
    this.faceY = 0;
    this.group.visible = true;
    this.spoon.visible = false;
    this.body.scale.set(1, 1, 1);
    this.body.rotation.set(0, 0, 0);
    this.armL.rotation.set(0, 0, 0);
    this.armR.rotation.set(0, 0, 0);
  }

  // 菜已上桌（服务员放盘时刻）
  beginEat(t, dur) {
    this.state = 'eating';
    this._eatStart = t;
    this._eatUntil = t + dur;
    this._praiseAt = t + dur * 0.55; // 吃到一半弹「好吃！」
    this._praised = false;
    this._steamAcc = 0;
    this.spoon.visible = true;
  }

  finishMeal() { // 吃完 → 回味片刻（done），随后渲染层发离席
    this.state = 'done';
    this._doneT = 0;
    this.spoon.visible = false;
  }

  leave(path) { // 起身离席（满意或等不到菜）
    this.state = 'leaving';
    this.path = path;
    this.seat = null;
    this.spoon.visible = false;
  }

  retire() { // 走出门径：回池
    this.state = 'idle';
    this.group.visible = false;
    this.path = [];
  }

  update(dt, t) {
    this.animT += dt;
    const at = this.animT;
    const pos = this.group.position;
    // 平滑转身
    let dy = this.faceY - this.group.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.group.rotation.y += dy * Math.min(1, dt * 8);
    // 眨眼
    this._blinkT -= dt;
    if (this._blinkT < 0) this._blinkT = 2 + Math.random() * 3.5;
    const blinkTarget = this._blinkT < 0.12 ? 0.12 : 1;
    this.eyeGroup.scale.y += (blinkTarget - this.eyeGroup.scale.y) * Math.min(1, dt * 22);

    switch (this.state) {
      case 'walkin': case 'leaving': {
        if (!this.path.length) return true; // 到达终点：由渲染层处理（落座 / 回池）
        const wp = this.path[0];
        const dx = wp.x - pos.x, dz = wp.z - pos.z;
        const dist = Math.hypot(dx, dz);
        const step = 1.7 * dt; // 客人踱步，比厨师小跑慢
        if (dist <= step) { pos.x = wp.x; pos.z = wp.z; this.path.shift(); }
        else { pos.x += (dx / dist) * step; pos.z += (dz / dist) * step; this.faceY = Math.atan2(dx, dz); }
        // 恢复站姿 + 走路颠簸/摆臂
        this.body.scale.y += (1 - this.body.scale.y) * Math.min(1, dt * 6);
        const s = Math.abs(Math.sin(at * 9));
        pos.y += (s * 0.055 - pos.y) * Math.min(1, dt * 10);
        this.armL.rotation.x = Math.sin(at * 9) * 0.45;
        this.armR.rotation.x = -Math.sin(at * 9) * 0.45;
        this.body.rotation.x += (0 - this.body.rotation.x) * Math.min(1, dt * 6);
        break;
      }
      case 'seated': case 'served': {
        // 落座：下沉 + 身体压缩（坐椅子的 Q 版表达）
        pos.y += (0.22 - pos.y) * Math.min(1, dt * 6);
        this.body.scale.y += (0.72 - this.body.scale.y) * Math.min(1, dt * 6);
        this.armL.rotation.x += (-0.35 - this.armL.rotation.x) * Math.min(1, dt * 6);
        this.armR.rotation.x += (-0.35 - this.armR.rotation.x) * Math.min(1, dt * 6);
        // 呼吸
        this.body.scale.x = this.body.scale.z = 1 + Math.sin(at * 2.1) * 0.02;
        // 偶尔东张西望 / 望向出餐口等菜
        this._glanceT -= dt;
        if (this._glanceT <= 0) {
          this._glanceT = 2.5 + Math.random() * 4;
          this._glanceYaw = (Math.random() - 0.5) * 0.7;
        }
        this._winT -= dt;
        let targetYaw = this._glanceYaw;
        if (this._winT < 1.1 && this.seat) { // 转头望向厨房窗口（等菜心切）
          targetYaw = Math.atan2(WIN.x - pos.x, WIN.z - pos.z) - this.group.rotation.y;
          while (targetYaw > Math.PI) targetYaw -= Math.PI * 2;
          while (targetYaw < -Math.PI) targetYaw += Math.PI * 2;
          targetYaw *= 0.55;
          if (this._winT <= 0) this._winT = 3.5 + Math.random() * 4;
        }
        this.body.rotation.y += (targetYaw - this.body.rotation.y) * Math.min(1, dt * 4);
        break;
      }
      case 'eating': {
        pos.y += (0.22 - pos.y) * Math.min(1, dt * 6);
        this.body.scale.y += (0.72 - this.body.scale.y) * Math.min(1, dt * 6);
        this.body.rotation.y += (0 - this.body.rotation.y) * Math.min(1, dt * 4);
        // 低头扒饭循环：埋头 ↔ 抬勺送嘴里
        const cyc = ((t - this._eatStart) % 1.2) / 1.2;
        const bite = Math.max(0, Math.sin(cyc * Math.PI * 2));
        this.body.rotation.x = 0.1 + bite * 0.16;
        this.armR.rotation.x = -0.5 - Math.max(0, Math.sin((cyc + 0.5) % 1 * Math.PI * 2)) * 1.6;
        this.armL.rotation.x += (-0.35 - this.armL.rotation.x) * Math.min(1, dt * 6);
        // 热气腾腾
        this._steamAcc += dt;
        if (this._steamAcc > 0.38 && this.seat) {
          this._steamAcc = 0;
          const d = this.seat.dishPos;
          this.fx.spawn('steam', d.x + (Math.random() - 0.5) * 0.08, TABLE_TOP + 0.16, d.z, 0, 0.5, 0, 0.65);
        }
        // 吃到一半弹一句夸奖
        if (!this._praised && t >= this._praiseAt) {
          this._praised = true;
          this.fx.popup(PRAISE[(Math.random() * PRAISE.length) | 0],
            new THREE.Vector3(pos.x, 1.25, pos.z), '#6FA34E');
        }
        if (t >= this._eatUntil) return 'finished';
        break;
      }
      case 'done': { // 吃饱回味：后仰、双手放下，1.6 秒后由渲染层送离席
        this._doneT += dt;
        this.body.rotation.x += (-0.08 - this.body.rotation.x) * Math.min(1, dt * 5);
        this.armL.rotation.x += (0 - this.armL.rotation.x) * Math.min(1, dt * 5);
        this.armR.rotation.x += (0 - this.armR.rotation.x) * Math.min(1, dt * 5);
        if (this._doneT >= 1.6) return 'leave';
        break;
      }
    }
    return false;
  }
}

// ---------- 服务员（Q 版店小二：红头巾 + 枣红马甲 + 米白围裙 + 白衬衫袖，矮胖圆身，不戴厨师帽） ----------
// 状态机：idle(待命点待机) → toSill(小碎步去吧台) → pickup(取餐，顶盘过头)
//   → toTable(端到客人桌旁) → serve(放菜上桌) → back(空手回待命点) → idle。
// 行走与厨师同风格：身体几乎不转只平移 + 上下颠簸 + 挤压拉伸，转向平滑；一次端一盘。
class Waiter {
  constructor(fx) {
    this.fx = fx;
    this.state = 'idle';
    this.group = new THREE.Group();
    this.path = [];
    this.entry = null;  // 手上这趟的吧台队列项
    this.target = null; // 目标座位
    this.animT = 0;
    this.faceY = 0;
    this._pause = 0;
    this._walking = false;
    this._blinkT = 2;
    this._glanceT = 3;
    this._glanceYaw = 0;
    this._build();
  }

  _build() {
    this.body = new THREE.Group();
    this.group.add(this.body);
    const F = new THREE.Group();
    F.scale.set(1.15, 0.9, 1.15); // 矮胖圆身（比厨师矮一截、宽一圈）
    this.body.add(F);
    const skinMat = mat('wSkin', 0xF2C9A0);
    // 枣红马甲 + 米白围裙（制服感，与厨师白袍大帽、客人便服一眼区分）
    const torso = new THREE.Mesh(geo('wTorso', () => new THREE.CylinderGeometry(0.27, 0.33, 0.48, 14)), mat('wVest', 0x8C4A3A));
    torso.position.y = 0.36;
    torso.castShadow = true;
    const apron = new THREE.Mesh(geo('wApron', () => new THREE.BoxGeometry(0.34, 0.3, 0.05)), mat('wApron', PAL.paper));
    apron.position.set(0, 0.28, 0.28);
    F.add(torso, apron);
    // 脸 + 眼睛（同客人程序化脸）
    const face = new THREE.Mesh(geo('gFace', () => new THREE.SphereGeometry(0.16, 12, 10)), skinMat);
    face.position.set(0, 0.68, 0.07);
    face.castShadow = true;
    F.add(face);
    const eyeMat = mat('gEye', 0x2A2138);
    const hlMat = mat('gEyeHL', 0xFFFDF6);
    this.eyeGroup = new THREE.Group();
    this.eyeGroup.position.set(0, 0.71, 0.19);
    for (const dx of [-0.055, 0.055]) {
      const eye = new THREE.Mesh(geo('gEye', () => new THREE.SphereGeometry(0.023, 6, 5)), eyeMat);
      eye.position.set(dx, 0, 0.02);
      const hl = new THREE.Mesh(geo('gEyeHL', () => new THREE.SphereGeometry(0.008, 4, 3)), hlMat);
      hl.position.set(dx + 0.011, 0.011, 0.042);
      this.eyeGroup.add(eye, hl);
    }
    F.add(this.eyeGroup);
    // 红头巾 + 脑后巾结（代替帽子，是「小二」的标志性轮廓）
    const bandMat = mat('wBand', PAL.red);
    const band = new THREE.Mesh(geo('wBand', () => new THREE.SphereGeometry(0.185, 12, 8)), bandMat);
    band.scale.set(1, 0.55, 1);
    band.position.set(0, 0.76, 0.02);
    band.castShadow = true;
    const knot = new THREE.Mesh(geo('wKnot', () => new THREE.BoxGeometry(0.09, 0.07, 0.07)), bandMat);
    knot.position.set(0, 0.74, -0.17);
    F.add(band, knot);
    // 手臂（白衬衫袖 + 肤色手，无白手套）
    this.armL = new THREE.Group(); this.armR = new THREE.Group();
    this.armL.position.set(-0.3, 0.48, 0); this.armR.position.set(0.3, 0.48, 0);
    const sleeveMat = mat('wSleeve', 0xF4EFE2);
    for (const arm of [this.armL, this.armR]) {
      const limb = new THREE.Mesh(geo('wLimb', () => new THREE.CylinderGeometry(0.05, 0.05, 0.2, 8)), sleeveMat);
      limb.position.y = -0.09;
      arm.add(limb);
      const hand = new THREE.Mesh(geo('gHand', () => new THREE.SphereGeometry(0.075, 8, 6)), skinMat);
      hand.position.y = -0.21;
      hand.castShadow = true;
      arm.add(hand);
      F.add(arm);
    }
    // 深色小鞋尖
    const shoeMat = mat('gShoe', PAL.shoe);
    for (const dx of [-0.12, 0.12]) {
      const shoe = new THREE.Mesh(geo('gShoe', () => new THREE.BoxGeometry(0.12, 0.07, 0.18)), shoeMat);
      shoe.position.set(dx, 0.035, 0.03);
      F.add(shoe);
    }
    // 头顶菜盘（取餐后可见，随身体颠簸；菜品按所端菜名拼装，取餐时切换）
    this.carry = new THREE.Group();
    const cplate = new THREE.Mesh(geo('gDish', () => new THREE.CylinderGeometry(0.2, 0.17, 0.04, 14)),
      mat('gPlate', PAL.plate, { roughness: 0.8 }));
    this.carry.add(cplate);
    this.carry.position.set(0, 1.0, 0.05);
    this.carry.visible = false;
    F.add(this.carry);
  }

  // 接单一趟：去吧台前取 entry 这道菜，送给 target 座位
  deliver(entry, target, path) {
    this.entry = entry;
    this.target = target;
    this.path = path;
    this.state = 'toSill';
  }

  // 取餐完成：顶盘 → 绕桌间空隙穿到餐桌北侧后巷，从桌子北侧上桌
  // （桌南站位 z≈-7.0 会被北墙挡住；桌间空隙 x≈-1.15 / 1.3 是唯一的南北通道）
  pickUp() {
    const dishX = this.target.dishPos.x;
    const gapX = dishX < 0 ? -1.15 : 1.3;
    setPlateDish(this.carry, this.entry && this.entry.name); // 顶盘换成所取菜品
    this.carry.visible = true;
    this.path = [
      { x: gapX, z: -7.6 },
      { x: gapX, z: BACK_LANE + 0.15 },
      { x: dishX, z: this.target.z - 0.95 },
    ];
    this.state = 'toTable';
  }

  // 送完（或目标失效弃盘）：沿后巷空手回待命点
  headBack(post) {
    this.carry.visible = false;
    this.entry = null;
    this.target = null;
    this.path = [{ x: post.x, z: BACK_LANE }, { x: post.x, z: post.z }];
    this.state = 'back';
  }

  _walk(dt) { // 小碎步平移，返回 true 表示已到路径终点
    if (!this.path.length) return true;
    const pos = this.group.position;
    const wp = this.path[0];
    const dx = wp.x - pos.x, dz = wp.z - pos.z;
    const dist = Math.hypot(dx, dz);
    const step = 2.0 * dt; // 比客人略快的小碎步
    if (dist <= step) { pos.x = wp.x; pos.z = wp.z; this.path.shift(); }
    else { pos.x += (dx / dist) * step; pos.z += (dz / dist) * step; this.faceY = Math.atan2(dx, dz); }
    this._walking = true;
    const s = Math.abs(Math.sin(this.animT * 10));
    pos.y += (s * 0.05 - pos.y) * Math.min(1, dt * 12);
    this.body.scale.set(1 + 0.06 * s, 1 - 0.08 * s, 1 + 0.06 * s); // 挤压拉伸
    this.body.rotation.y += (0 - this.body.rotation.y) * Math.min(1, dt * 6);
    return false;
  }

  update(dt) {
    this.animT += dt;
    const at = this.animT;
    const pos = this.group.position;
    this._walking = false;
    // 平滑转身
    let dy = this.faceY - this.group.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.group.rotation.y += dy * Math.min(1, dt * 8);
    // 眨眼
    this._blinkT -= dt;
    if (this._blinkT < 0) this._blinkT = 2 + Math.random() * 3.5;
    const blinkTarget = this._blinkT < 0.12 ? 0.12 : 1;
    this.eyeGroup.scale.y += (blinkTarget - this.eyeGroup.scale.y) * Math.min(1, dt * 22);

    let ev = null;
    switch (this.state) {
      case 'idle': { // 待命：轻微呼吸 + 东张西望
        pos.y += (0 - pos.y) * Math.min(1, dt * 8);
        this.body.scale.y += (1 - this.body.scale.y) * Math.min(1, dt * 8);
        this.body.scale.x = this.body.scale.z = 1 + Math.sin(at * 2.2) * 0.02;
        this._glanceT -= dt;
        if (this._glanceT <= 0) {
          this._glanceT = 2.5 + Math.random() * 4;
          this._glanceYaw = (Math.random() - 0.5) * 0.8;
        }
        this.body.rotation.y += (this._glanceYaw - this.body.rotation.y) * Math.min(1, dt * 4);
        break;
      }
      case 'toSill':
        if (this._walk(dt)) {
          this.state = 'pickup';
          this._pause = 0.35;
          this.faceY = Math.atan2(WIN.x - pos.x, WIN.z - pos.z); // 面向传菜窗取餐
        }
        break;
      case 'pickup':
        this._pause -= dt;
        if (this._pause <= 0) ev = 'pickupDone';
        break;
      case 'toTable':
        if (this._walk(dt)) {
          this.state = 'serve';
          this._pause = 0.4;
          this.faceY = Math.atan2(this.target.dishPos.x - pos.x, this.target.dishPos.z - pos.z); // 面向桌上餐位
        }
        break;
      case 'serve':
        this._pause -= dt;
        if (this._pause <= 0) ev = 'serveDone';
        break;
      case 'back':
        if (this._walk(dt)) {
          this.state = 'idle';
          this.faceY = -1.1; // 面向餐桌区待命（三四分之一侧脸对镜头）
        }
        break;
    }
    // 手臂：端盘时双手举过头顶扶盘，空手走路前后摆臂，待机垂手（统一缓动防突变）
    let al = 0, ar = 0;
    if (this.carry.visible) { al = ar = -2.55; }
    else if (this._walking) { al = Math.sin(at * 10) * 0.5; ar = -al; }
    this.armL.rotation.x += (al - this.armL.rotation.x) * Math.min(1, dt * 12);
    this.armR.rotation.x += (ar - this.armR.rotation.x) * Math.min(1, dt * 12);
    return ev;
  }
}

// ---------- 餐厅区 ----------
export function buildDining(scene, fx) {
  const g = new THREE.Group();
  scene.add(g);
  const textures = [];
  const rnd = (a, b) => a + Math.random() * (b - a);

  // 木平台（餐厅区地面标识，南沿伸到吧台脚下，抬高 0.01 避免与外地面 z-fighting）
  const patio = new THREE.Mesh(geo('gPatio', () => new THREE.CircleGeometry(4.7, 28)),
    mat('gPatioWood', 0x7A5638, { roughness: 1 }));
  patio.rotation.x = -Math.PI / 2;
  patio.scale.set(1.15, 0.62, 1);
  patio.position.set(0.1, GY + 0.012, -7.9);
  patio.receiveShadow = true;
  g.add(patio);

  // 蜡烛光晕贴图（桌面暖光点，假光源同 backdrop 路灯）
  const glowTex = glowDiscTexture();
  textures.push(glowTex);
  const candleMat = mat('gCandle', PAL.flameCore, { emissive: PAL.flameCore, emissiveIntensity: 1.8, roughness: 0.6 });

  // 贴地暖光池：出餐吧台灯火烘亮整片餐厅露台，把餐厅区从夜色里提出来（与厨房视觉连成一体）
  const patioGlow = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 4.2),
    new THREE.MeshBasicMaterial({
      map: glowTex, color: PAL.lampLight, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
  patioGlow.rotation.x = -Math.PI / 2;
  patioGlow.position.set(0.1, GY + 0.03, -7.5);
  g.add(patioGlow);

  // 餐桌椅 + 蜡烛；座位表（西座/东座面对面；单座桌只摆西座，面向镜头一侧）
  const seats = [];
  const tableTopMat = mat('gTableTop', PAL.paper, { roughness: 0.85 });
  const tableWoodMat = mat('gTableWood', PAL.woodDark);
  const chairMat = mat('gChair', PAL.crateWood);
  for (const tb of TABLES) {
    const top = new THREE.Mesh(geo('gTableTop', () => new THREE.CylinderGeometry(0.55, 0.55, 0.06, 18)), tableTopMat);
    top.position.set(tb.x, TABLE_TOP - 0.03, tb.z);
    top.castShadow = true;
    const rim = new THREE.Mesh(geo('gTableRim', () => new THREE.CylinderGeometry(0.57, 0.57, 0.025, 18)), tableWoodMat);
    rim.position.set(tb.x, TABLE_TOP - 0.065, tb.z);
    const leg = new THREE.Mesh(geo('gTableLeg', () => new THREE.CylinderGeometry(0.06, 0.08, 0.6, 10)), tableWoodMat);
    leg.position.set(tb.x, GY + 0.32, tb.z);
    const base = new THREE.Mesh(geo('gTableBase', () => new THREE.CylinderGeometry(0.26, 0.3, 0.06, 12)), tableWoodMat);
    base.position.set(tb.x, GY + 0.05, tb.z);
    g.add(top, rim, leg, base);
    // 蜡烛：烛台 + 火苗 + 光晕精灵
    const stick = new THREE.Mesh(geo('gCandleStick', () => new THREE.CylinderGeometry(0.035, 0.05, 0.1, 8)), tableWoodMat);
    stick.position.set(tb.x, TABLE_TOP + 0.05, tb.z);
    const flame = new THREE.Mesh(geo('gCandleFlame', () => new THREE.ConeGeometry(0.028, 0.09, 8)), candleMat);
    flame.position.set(tb.x, TABLE_TOP + 0.15, tb.z);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: PAL.lampLight, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    halo.scale.set(0.7, 0.7, 1);
    halo.position.set(tb.x, TABLE_TOP + 0.16, tb.z);
    g.add(stick, flame, halo);
    tb._halo = halo;

    // 座位：西座朝东(faceY=+π/2) / 东座朝西(faceY=-π/2)，菜放座位与桌心之间
    const seatDefs = tb.seats === 2 ? [-0.62, 0.62] : [-0.62];
    for (const off of seatDefs) {
      const sx = tb.x + off, sz = tb.z;
      const seat = {
        x: sx, z: sz, table: tb,
        faceY: off < 0 ? Math.PI / 2 : -Math.PI / 2, // 面向桌心
        dishPos: { x: tb.x + off * 0.42, y: TABLE_TOP + 0.03, z: tb.z },
        guest: null, nextArrive: 0, plate: null,
      };
      // 椅子：坐面 + 靠背（靠背在远离桌子一侧）+ 立柱
      const chair = new THREE.Group();
      const cSeat = box(0.34, 0.05, 0.34, chairMat);
      cSeat.position.set(sx, GY + 0.3, sz);
      const cBack = box(0.34, 0.4, 0.05, chairMat);
      cBack.position.set(sx + (off < 0 ? -0.19 : 0.19), GY + 0.52, sz);
      const cPost = new THREE.Mesh(geo('gChairPost', () => new THREE.CylinderGeometry(0.04, 0.05, 0.28, 8)), tableWoodMat);
      cPost.position.set(sx, GY + 0.15, sz);
      chair.add(cSeat, cBack, cPost);
      g.add(chair);
      // 桌上餐盘（上菜时显示对应菜品，客人离席收起）
      const plateG = new THREE.Group();
      plateG.add(new THREE.Mesh(geo('gDish', () => new THREE.CylinderGeometry(0.2, 0.17, 0.04, 14)),
        mat('gPlate', PAL.plate, { roughness: 0.8 })));
      plateG.position.set(seat.dishPos.x, seat.dishPos.y, seat.dishPos.z);
      plateG.visible = false;
      g.add(plateG);
      seat.plate = plateG;
      seats.push(seat);
    }
  }

  // 吧台等位菜盘（第一程落点排队展示，第二程起飞后归还池；盘里按队列菜名摆菜）
  const sillPool = [];
  for (let i = 0; i < MAX_SILL; i++) {
    const pg = new THREE.Group();
    pg.add(new THREE.Mesh(geo('gDish', () => new THREE.CylinderGeometry(0.2, 0.17, 0.04, 14)),
      mat('gPlate', PAL.plate, { roughness: 0.8 })));
    pg.visible = false;
    g.add(pg);
    sillPool.push(pg);
  }
  // 重排吧台：队列前 MAX_SILL 个各拿一个盘并摆到槽位，其余无盘（溢出仅计数）
  function layoutSill() {
    for (const p of sillPool) p.visible = false;
    queue.forEach((e, i) => { e.plate = i < MAX_SILL ? sillPool[i] : null; });
    queue.forEach((e, i) => {
      if (!e.plate) return;
      e.plate.position.set(WIN.x - 0.75 + i * 0.5, SILL.y, SILL.z);
      setPlateDish(e.plate, e.name); // 盘里摆上对应菜品（同菜名不重建）
      e.plate.visible = true;
    });
  }

  // 客人池
  const guests = [];
  for (let i = 0; i < MAX_GUESTS; i++) {
    const guest = new Guest(fx);
    g.add(guest.group);
    guests.push(guest);
  }

  // 服务员小二：固定待命点在餐厅东侧（视线临界 z≈-7.4 以北会被 3.2 北墙挡住，
  // 故待命/上桌站位都收在可见区；只有去吧台取餐那一小段没入墙后，从吧台取餐再端着盘子走回来）
  const POST = { x: 3.7, z: -8.5 };       // 待命点（餐厅东侧空地，不挡客人动线）
  const SILL_FRONT = SILL.z - 0.68;       // 吧台前取餐站位进深
  const waiter = new Waiter(fx);
  waiter.group.position.set(POST.x, 0, POST.z);
  g.add(waiter.group);

  let dim = 1;
  let now = 0;
  let spawnSeq = 0;
  const queue = []; // { name, readyAt, plate }
  seats.forEach((s, i) => { s.nextArrive = 1.2 + i * 1.6 + rnd(0, 1.5); }); // 开业陆续来客

  function deriveLook() {
    const n = spawnSeq++;
    return {
      outfit: OUTFITS[n % OUTFITS.length],
      pants: PANTS[(n * 3 + 1) % PANTS.length],
      hair: HAIR_COLS[(n * 5 + 2) % HAIR_COLS.length],
      skin: SKINS[(n * 7 + 3) % SKINS.length],
      style: n % 3,
      heightK: 0.92 + (n % 5) * 0.03,
      widthK: 0.9 + ((n * 3) % 5) * 0.05,
    };
  }

  function walkPathTo(seat) {
    const outX = seat.x + (seat.faceY > 0 ? -0.55 : 0.55); // 椅子外侧
    return [
      { x: GATE.x + rnd(-0.5, 0.5), z: GATE.z },
      { x: outX, z: seat.z },
      { x: seat.x, z: seat.z },
    ];
  }

  function walkPathOut(guest) {
    return [
      { x: GATE.x + rnd(-0.6, 0.6), z: GATE.z },
      { x: rnd(-2.5, 2.5), z: SPAWN_Z },
    ];
  }

  // 用餐时长 8.5–15 秒：逐桌逐餐确定性（同一座位第 N 餐时长稳定，节奏可预期又带差异）
  function eatDuration(seat) {
    seat._mealN = (seat._mealN || 0) + 1;
    return 8.5 + ((seat._mealN * 5 + Math.round((seat.x + 3) * 4) + Math.round(-seat.z)) % 7);
  }

  function freeSeat(guest, t, happy) {
    const seat = guest.seat;
    if (!seat) return;
    if (seat.plate) seat.plate.visible = false;
    seat.guest = null;
    seat.nextArrive = t + rnd(3, happy ? 7 : 10); // 翻台：满意离开来得快些
    guest.seat = null;
  }

  return {
    group: g,

    // 出餐接力：菜先落在出餐吧台（第一程 1.1s），再排队等上桌
    serveDish(name) {
      if (queue.length >= MAX_QUEUE) return;
      queue.push({ name: name || '招牌菜', readyAt: now + 1.15, plate: null });
      layoutSill();
    },

    setDim(d) { dim = d; },

    stats() {
      let seated = 0, eating = 0;
      for (const gst of guests) {
        if (gst.state === 'seated' || gst.state === 'served') seated++;
        if (gst.state === 'eating') eating++;
      }
      return { seated, eating, queue: queue.length, waiter: waiter.state };
    },

    update(dt, t) {
      now = t;
      // 蜡烛：火苗闪烁 + 歇业收敛
      const dimK = 0.2 + 0.8 * dim;
      candleMat.emissiveIntensity = 1.8 * dimK * (1 + 0.18 * Math.sin(t * 9.3) + 0.1 * Math.sin(t * 15.7));
      for (const tb of TABLES) tb._halo.material.opacity = 0.32 * dimK * (1 + 0.15 * Math.sin(t * 9.3 + tb.x));
      patioGlow.material.opacity = 0.4 * dimK; // 歇业时光池同步收敛

      // 新客人入场（歇业时不迎客）
      if (dim >= 1) {
        for (const seat of seats) {
          if (seat.guest || t < seat.nextArrive) continue;
          const guest = guests.find((gg) => gg.state === 'idle');
          if (!guest) break;
          seat.guest = guest;
          guest.spawn(seat, deriveLook(), walkPathTo(seat));
        }
      }

      // 吧台队列 → 派单给服务员（一次端一盘，送完再接下一单；歇业不接新单，手上的送完）
      if (waiter.state === 'idle' && dim >= 1 && queue.length && queue[0].readyAt <= t) {
        let target = null;
        for (const seat of seats) {
          if (!seat.guest || seat.guest.state !== 'seated') continue;
          if (!target || seat._waitSince < target._waitSince) target = seat;
        }
        if (target) {
          const entry = queue[0]; // 先不出队：盘子留在吧台上等小二走到跟前
          target.guest.state = 'served'; // 已有小二接单，别再派给别人
          waiter.deliver(entry, target,
            [{ x: 4.2, z: -7.2 }, { x: entry.plate ? entry.plate.position.x : WIN.x, z: SILL_FRONT }]);
        }
      }

      // 服务员事件：取到餐 → 顶盘送去目标桌；放菜上桌 → 客人开吃、小二空手回待命点
      const wr = waiter.update(dt);
      if (wr === 'pickupDone') {
        const qi = queue.indexOf(waiter.entry);
        if (qi >= 0) queue.splice(qi, 1);
        layoutSill(); // 吧台剩余等位盘往前挪
        waiter.pickUp();
      } else if (wr === 'serveDone') {
        const seat = waiter.target;
        if (seat && seat.guest && seat.guest.state === 'served') { // 客人还在等：摆盘开吃
          setPlateDish(seat.plate, waiter.entry && waiter.entry.name); // 桌上餐盘摆出对应菜品
          seat.plate.visible = true;
          seat.guest.beginEat(t, eatDuration(seat));
        }
        waiter.headBack(POST);
      }

      // 客人状态推进
      for (const guest of guests) {
        if (guest.state === 'idle') continue;
        // 等菜耐心
        if (guest.state === 'seated' && guest.seat) {
          if (guest.seat._waitSince == null) guest.seat._waitSince = t;
          if (t - guest.seat._waitSince > PATIENCE) {
            freeSeat(guest, t, false);
            guest.leave(walkPathOut(guest));
          }
        }
        const r = guest.update(dt, t);
        if (r === true) { // 走到路径终点
          if (guest.state === 'walkin' && guest.seat) {
            guest.state = 'seated';
            guest.faceY = guest.seat.faceY;
            guest.group.position.set(guest.seat.x, 0.22, guest.seat.z);
            guest.seat._waitSince = t;
          } else if (guest.state === 'leaving') {
            guest.retire();
          }
        } else if (r === 'finished') {
          guest.finishMeal();
        } else if (r === 'leave') {
          freeSeat(guest, t, true);
          guest.leave(walkPathOut(guest));
        }
      }
    },

    dispose() {
      scene.remove(g);
      g.traverse((o) => {
        if (o.userData.sharedDish) return; // 盘中餐共享资产由 disposeDishCache 统一清理
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) m.dispose();
        }
      });
      for (const tx of textures) tx.dispose();
      for (const k in GEO) { GEO[k].dispose(); delete GEO[k]; }
      for (const k in MAT) { MAT[k].dispose(); delete MAT[k]; }
      disposeDishCache(); // 盘中餐共享几何/材质
    },
  };
}
