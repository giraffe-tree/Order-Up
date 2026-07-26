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
  t.anisotropy = 4;
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

// 动作气泡（白底圆角 + 小尾巴）
export function bubbleTexture(text) {
  const w = 256, h = 96;
  const [c, g] = makeCanvas(w, h);
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
  g.font = `bold 34px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#2A2138';
  const label = text.length > 6 ? text.slice(0, 6) : text;
  g.fillText(label, w / 2, (h - 24) / 2 + 2);
  return toTexture(c);
}

// 木牌（歇业中 / 后厨+N / 厨房名）
export function plankTexture(text, { w = 320, h = 96, fontSize = 44, bg = '#7A5230', fg = '#F5EBD7' } = {}) {
  const [c, g] = makeCanvas(w, h);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  // 木纹深色边框
  g.strokeStyle = '#2A2138';
  g.lineWidth = 8;
  g.strokeRect(4, 4, w - 8, h - 8);
  g.strokeStyle = 'rgba(0,0,0,0.18)';
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(10, h * 0.35); g.lineTo(w - 10, h * 0.35); g.stroke();
  g.beginPath(); g.moveTo(10, h * 0.7); g.lineTo(w - 10, h * 0.7); g.stroke();
  g.font = `bold ${fontSize}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = '#2A2138';
  g.strokeText(text, w / 2, h / 2 + 2);
  g.fillStyle = fg;
  g.fillText(text, w / 2, h / 2 + 2);
  return toTexture(c);
}

// 精灵封装
export function makeSprite(texture, w, h) {
  const m = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const s = new THREE.Sprite(m);
  s.scale.set(w, h, 1);
  return s;
}
