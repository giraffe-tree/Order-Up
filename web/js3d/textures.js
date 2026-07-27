// CanvasTexture 工具：图标 / 名字牌 / 气泡 / 木牌文字（唯一允许使用贴图的地方）
import * as THREE from '../vendor/three.module.min.js';

const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function toTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8; // 斜视角下文字/纹理更清晰
  return t;
}

// 台面上的 emoji 图标（米白圆角底牌）
export function iconTexture(emoji, { bg = '#F5EBD7', size = 128 } = {}) {
  const [c, g] = makeCanvas(size, size);
  if (bg) {
    g.fillStyle = bg;
    g.beginPath();
    g.roundRect(4, 4, size - 8, size - 8, size * 0.18);
    g.fill();
    g.strokeStyle = '#2A2138';
    g.lineWidth = size * 0.045;
    g.stroke();
  }
  g.font = `${size * 0.62}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(emoji, size / 2, size / 2 + size * 0.03);
  return toTexture(c);
}

// 厨师头顶名字牌（深底白字胶囊）
export function nameTexture(name, colorHex) {
  const w = 256, h = 64;
  const [c, g] = makeCanvas(w, h);
  g.fillStyle = 'rgba(30,22,40,0.82)';
  g.beginPath(); g.roundRect(6, 8, w - 12, h - 16, 22); g.fill();
  g.strokeStyle = colorHex || '#F5EBD7';
  g.lineWidth = 4;
  g.stroke();
  g.font = `bold 30px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#FFFFFF';
  const label = name.length > 8 ? name.slice(0, 8) + '…' : name;
  g.fillText(label, w / 2, h / 2 + 1);
  return toTexture(c);
}

// 把气泡画进既有 2D 上下文（对象池复用：同一 canvas 反复重绘，不再每次新建纹理）
export function drawBubble(g, w, h, text) {
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#FFFDF6';
  g.beginPath(); g.roundRect(8, 6, w - 16, h - 28, 24); g.fill();
  g.strokeStyle = '#2A2138';
  g.lineWidth = 5;
  g.stroke();
  // 尾巴
  g.beginPath();
  g.moveTo(w / 2 - 14, h - 24);
  g.lineTo(w / 2, h - 4);
  g.lineTo(w / 2 + 14, h - 24);
  g.closePath();
  g.fillStyle = '#FFFDF6';
  g.fill();
  g.stroke();
  g.fillStyle = '#FFFDF6';
  g.fillRect(w / 2 - 13, h - 30, 26, 8);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#2A2138';
  const label = text.length > 6 ? text.slice(0, 6) : text;
  g.font = `bold 34px ${FONT}`;
  g.fillText(label, w / 2, (h - 24) / 2 + 2);
}

// 动作气泡（白底圆角 + 小尾巴）
export function bubbleTexture(text) {
  const w = 256, h = 96;
  const [c, g] = makeCanvas(w, h);
  drawBubble(g, w, h, text);
  return toTexture(c);
}

// 自适应文字：按实际测量宽度缩字号（而非按字数估算，中文/emoji 宽度差异大），
// 超出 maxLen 个字符时截断并加省略号（Array.from 避免切断 emoji 代理对）
function fitFont(g, text, fontSize, maxChars, maxLen, maxWidth) {
  let chars = Array.from(text);
  let truncated = false;
  if (chars.length > maxLen) { chars = chars.slice(0, Math.max(1, maxLen - 1)); truncated = true; }
  let label = chars.join('') + (truncated ? '…' : '');
  let size = fontSize;
  g.font = `bold ${size}px ${FONT}`;
  while (size > 18 && g.measureText(label).width > maxWidth) {
    size -= 2;
    g.font = `bold ${size}px ${FONT}`;
  }
  // 缩到最小字号仍放不下：才逐字截断到能容纳省略号为止
  if (g.measureText(label).width > maxWidth) {
    while (chars.length > 1 && g.measureText(chars.join('') + '…').width > maxWidth) chars.pop();
    label = chars.join('') + '…';
  }
  return label;
}

// 把木牌画进既有 2D 上下文（对象池复用：同一 canvas 反复重绘，不再每次新建纹理）
// maxChars 保留兼容（不再使用）；maxLen 限制字符数；文字按测量宽度自动缩字号、居中且不贴边
export function drawPlank(g, w, h, text, { fontSize = 44, bg = '#7A5230', fg = '#F5EBD7', maxChars = Infinity, maxLen = Infinity } = {}) {
  g.clearRect(0, 0, w, h);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  // 木纹深色边框 + 内侧一道奶油色高光，营造卡通「雕刻招牌」感
  g.strokeStyle = '#2A2138';
  g.lineWidth = 8;
  g.strokeRect(4, 4, w - 8, h - 8);
  g.strokeStyle = 'rgba(245,235,215,0.16)';
  g.lineWidth = 3;
  g.strokeRect(11, 11, w - 22, h - 22);
  g.strokeStyle = 'rgba(0,0,0,0.18)';
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(14, h * 0.35); g.lineTo(w - 14, h * 0.35); g.stroke();
  g.beginPath(); g.moveTo(14, h * 0.7); g.lineTo(w - 14, h * 0.7); g.stroke();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round'; // 中文笔画转角圆润，描边不出尖刺
  const padX = Math.max(18, w * 0.08);
  const label = fitFont(g, text, fontSize, maxChars, maxLen, w - padX * 2);
  const tx = w / 2, ty = h / 2 + 2;
  const outline = Math.max(4, Math.round(fontSize * 0.13));
  // 柔和投影（错位深影），让奶油字从深色牌面上「浮」出来
  g.lineWidth = outline;
  g.strokeStyle = 'rgba(26,18,34,0.9)';
  g.strokeText(label, tx, ty + 2);
  g.fillStyle = 'rgba(26,18,34,0.55)';
  g.fillText(label, tx, ty + 3);
  // 主文字：深色描边 + 奶油填充
  g.lineWidth = outline;
  g.strokeStyle = '#2A2138';
  g.strokeText(label, tx, ty);
  g.fillStyle = fg;
  g.fillText(label, tx, ty);
}

// 木牌（歇业中 / 后厨+N / 厨房名）：内部 2x 超采样绘制，下采样后文字更锐利
export function plankTexture(text, { w = 320, h = 96, fontSize = 44, bg = '#7A5230', fg = '#F5EBD7', maxLen = Infinity, ss = 2 } = {}) {
  const [c, g] = makeCanvas(w * ss, h * ss);
  g.scale(ss, ss);
  drawPlank(g, w, h, text, { fontSize, bg, fg, maxLen });
  return toTexture(c);
}

// 精灵封装
export function makeSprite(texture, w, h) {
  const m = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const s = new THREE.Sprite(m);
  s.scale.set(w, h, 1);
  return s;
}

// ---------- 程序化场景纹理（确定性伪随机，禁外部资源） ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexRGB(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

function shade(hex, f) {
  const [r, g, b] = hexRGB(hex);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

// 棋盘格地板：双色相间 + 每格色差 + 砖缝 + 磨损斑/划痕（seed 固定，每次构建一致）
export function floorTexture(gw, gh, { light = 0xD2A06B, dark = 0x96663C, grout = 0x6E4A2F, cell = 128 } = {}) {
  const w = gw * cell, h = gh * cell;
  const [c, g] = makeCanvas(w, h);
  const rnd = mulberry32(20260727);
  for (let iz = 0; iz < gh; iz++) {
    for (let ix = 0; ix < gw; ix++) {
      const base = (ix + iz) % 2 === 0 ? light : dark;
      const jitter = 0.90 + rnd() * 0.18;               // 每格色差
      g.fillStyle = shade(base, jitter);
      g.fillRect(ix * cell, iz * cell, cell, cell);
      // 格内轻微拉丝（木纹感）
      g.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.04})`;
      const sy = iz * cell + rnd() * cell;
      g.fillRect(ix * cell, sy, cell, 2 + rnd() * 3);
    }
  }
  // 磨损斑：半透明明暗椭圆
  for (let i = 0; i < 46; i++) {
    const x = rnd() * w, y = rnd() * h, rx = cell * (0.15 + rnd() * 0.5), ry = rx * (0.4 + rnd() * 0.5);
    const dark2 = rnd() > 0.45;
    g.fillStyle = dark2 ? `rgba(40,22,10,${0.04 + rnd() * 0.07})` : `rgba(255,240,214,${0.03 + rnd() * 0.05})`;
    g.beginPath(); g.ellipse(x, y, rx, ry, rnd() * 3, 0, Math.PI * 2); g.fill();
  }
  // 划痕
  g.strokeStyle = 'rgba(52,32,16,0.12)';
  for (let i = 0; i < 22; i++) {
    const x = rnd() * w, y = rnd() * h, len = 20 + rnd() * 90, a = rnd() * Math.PI;
    g.lineWidth = 1 + rnd() * 1.5;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke();
  }
  // 砖缝（描在每格边缘，带内侧高光）
  for (let ix = 0; ix <= gw; ix++) {
    g.fillStyle = 'rgba(60,38,20,0.5)';
    g.fillRect(ix * cell - 2, 0, 4, h);
    g.fillStyle = 'rgba(255,235,200,0.10)';
    g.fillRect(ix * cell + 2, 0, 2, h);
  }
  for (let iz = 0; iz <= gh; iz++) {
    g.fillStyle = 'rgba(60,38,20,0.5)';
    g.fillRect(0, iz * cell - 2, w, 4);
    g.fillStyle = 'rgba(255,235,200,0.10)';
    g.fillRect(0, iz * cell + 2, w, 2);
  }
  const t = toTexture(c);
  t.anisotropy = 8;
  return t;
}

// 厨房外大地面：中心暖木 → 边缘压暗的径向渐变（避免画面发灰发平）
export function outerGroundTexture({ inner = 0x54402C, outer = 0x2E1F13 } = {}) {
  const [c, g] = makeCanvas(512, 512);
  const grad = g.createRadialGradient(256, 256, 60, 256, 256, 360);
  const [r1, g1, b1] = hexRGB(inner), [r2, g2, b2] = hexRGB(outer);
  grad.addColorStop(0, `rgb(${r1},${g1},${b1})`);
  grad.addColorStop(1, `rgb(${r2},${g2},${b2})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  return toTexture(c);
}

// 暖砖墙：错缝砖块 + 灰泥缝 + 每砖色差（可 RepeatWrapping 平铺）
export function brickTexture({ a = 0xC79F72, b = 0xAD8557, mortar = 0xE2CEA9, tw = 512, th = 256, rows = 4, cols = 4 } = {}) {
  const [c, g] = makeCanvas(tw, th);
  const rnd = mulberry32(20260728);
  g.fillStyle = shade(mortar, 1);
  g.fillRect(0, 0, tw, th);
  const bw = tw / cols, bh = th / rows, gap = Math.max(3, bh * 0.12);
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * bw * 0.5;
    for (let cx = -1; cx < cols + 1; cx++) {
      const x = cx * bw + off, y = r * bh;
      const f = 0.9 + rnd() * 0.2;
      const base = rnd() > 0.5 ? a : b;
      g.fillStyle = shade(base, f);
      g.fillRect(x + gap / 2, y + gap / 2, bw - gap, bh - gap);
      // 砖面顶部微光、底部微暗，增加体积感
      g.fillStyle = 'rgba(255,240,214,0.10)';
      g.fillRect(x + gap / 2, y + gap / 2, bw - gap, 3);
      g.fillStyle = 'rgba(50,30,14,0.12)';
      g.fillRect(x + gap / 2, y + bh - gap / 2 - 3, bw - gap, 3);
      // 偶发小疵点
      if (rnd() > 0.6) {
        g.fillStyle = `rgba(60,36,18,${0.05 + rnd() * 0.08})`;
        g.beginPath();
        g.ellipse(x + bw * (0.2 + rnd() * 0.6), y + bh * (0.3 + rnd() * 0.4), 3 + rnd() * 8, 2 + rnd() * 5, rnd() * 3, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  const t = toTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// 菜单黑板：深绿板面 + 粉笔字菜单（今日菜单 + 三行菜）
export function chalkboardTexture({ w = 384, h = 288 } = {}) {
  const [c, g] = makeCanvas(w, h);
  const rnd = mulberry32(20260729);
  g.fillStyle = '#33413A';
  g.fillRect(0, 0, w, h);
  // 板面做旧
  for (let i = 0; i < 26; i++) {
    g.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.05})`;
    g.beginPath();
    g.ellipse(rnd() * w, rnd() * h, 12 + rnd() * 40, 6 + rnd() * 20, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = 'rgba(243,237,221,0.85)';
  g.lineWidth = 3;
  g.strokeRect(10, 10, w - 20, h - 20);
  const CHALK = 'rgba(243,237,221,0.94)';
  g.fillStyle = CHALK;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold 40px ${FONT}`;
  g.fillText('今日菜单', w / 2, 48);
  // 粉笔波浪下划线
  g.strokeStyle = CHALK;
  g.lineWidth = 2.5;
  g.beginPath();
  for (let x = w / 2 - 90; x <= w / 2 + 90; x += 6) {
    const y = 76 + Math.sin(x * 0.25) * 3;
    x === w / 2 - 90 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.stroke();
  g.font = `34px ${FONT}`;
  const rows = [
    ['🍅 + 🥬 → 🍲', '番茄浓汤'],
    ['🍚 + 🥒 → 🍣', '寿司卷'],
    ['🥩 + 🍔 → 🍔', '汉堡排'],
  ];
  rows.forEach(([line], i) => {
    const y = 120 + i * 52;
    g.fillStyle = i === 0 ? 'rgba(248,225,108,0.95)' : CHALK; // 首行暖黄高亮
    g.fillText(line, w / 2, y);
  });
  // 角落星形涂鸦
  g.fillStyle = CHALK;
  g.font = '26px sans-serif';
  g.fillText('✦', 32, h - 32);
  g.fillText('✦', w - 32, 32);
  return toTexture(c);
}
