// 菜品池：菜名 + 视觉元数据（配色/形状）。服务端（parser/demo）与 3D 前端（fx/dining）共用。
// 纯 JS、零依赖——禁止 import THREE 或任何 node 模块（web 端经静态服务器直接加载）。
//
// shape 形状分类（3D 端据此拼装盘中餐）：
//   chunks 块状（炒菜肉丁/番茄块/豆腐块，几枚方块堆在盘里）
//   strips 条状（丝/段/荚，几根长条交错）
//   greens 叶菜（几片叶子 + 菜梗）
//   fish   整鱼（椭圆鱼身 + 三角尾 + 点缀葱丝）
//   rice   饭类（一座小山，顶点缀配料色）
//   soup   汤类（深盘汤面 + 表面漂浮配料色小块）
// colors: [主色, 配色]（hex 数字），主色大面积、配色点缀。

export const DISHES = [
  { name: '番茄炒蛋',   shape: 'chunks', colors: [0xD94F3D, 0xF2C230] },
  { name: '青椒炒豆干', shape: 'strips', colors: [0x58B24C, 0xE8D9B0] },
  { name: '红烧肉',     shape: 'chunks', colors: [0x8A4B2A, 0xB3673B] },
  { name: '清蒸鲈鱼',   shape: 'fish',   colors: [0xC9CDD4, 0x58B24C] },
  { name: '麻婆豆腐',   shape: 'chunks', colors: [0xF0EBE0, 0xD94F3D] },
  { name: '宫保鸡丁',   shape: 'chunks', colors: [0xB3673B, 0xD94F3D] },
  { name: '蒜蓉西兰花', shape: 'greens', colors: [0x3E8E41, 0x58B24C] },
  { name: '酸辣土豆丝', shape: 'strips', colors: [0xF2C230, 0xD94F3D] },
  { name: '可乐鸡翅',   shape: 'chunks', colors: [0xA55A2E, 0x7A5230] },
  { name: '白灼虾',     shape: 'chunks', colors: [0xF57B4A, 0xF8E16C] },
  { name: '蛋炒饭',     shape: 'rice',   colors: [0xF2C230, 0x58B24C] },
  { name: '阳春面',     shape: 'soup',   colors: [0xF5EBD7, 0x58B24C] },
  { name: '番茄蛋花汤', shape: 'soup',   colors: [0xE8B04B, 0xD94F3D] },
  { name: '冬瓜排骨汤', shape: 'soup',   colors: [0xDCE8DC, 0xB89B78] },
  { name: '香煎三文鱼', shape: 'fish',   colors: [0xF57B4A, 0xF2C230] },
  { name: '糖醋里脊',   shape: 'strips', colors: [0xC65A3A, 0xF2C230] },
  { name: '地三鲜',     shape: 'chunks', colors: [0x5A3A6E, 0x58B24C] },
  { name: '干煸豆角',   shape: 'strips', colors: [0x3E8E41, 0x7A5230] },
  { name: '咖喱鸡',     shape: 'chunks', colors: [0xE0A52E, 0xB3673B] },
  { name: '水煮牛肉',   shape: 'soup',   colors: [0xB3382E, 0x58B24C] },
  { name: '香菇青菜',   shape: 'greens', colors: [0x58B24C, 0x7A5230] },
  { name: '虾仁滑蛋',   shape: 'chunks', colors: [0xF8E16C, 0xF57B4A] },
  { name: '鱼香肉丝',   shape: 'strips', colors: [0xB3673B, 0xD94F3D] },
  { name: '扬州炒饭',   shape: 'rice',   colors: [0xF2C230, 0xD94F3D] },
];

// djb2 字符串哈希 → uint32（确定性，同一 seed 永远同一道菜）
export function hashStr(s) {
  let h = 5381;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

// 根据任务 seed 从菜品池里确定性挑一道菜（"根据任务随机上"：同一任务同一道菜，不同任务分布均匀）
export function pickDish(seed) {
  return DISHES[hashStr(seed) % DISHES.length];
}

// 菜名 → 视觉元数据 { shape, colors }。池内菜查表；池外菜名（旧数据/'招牌菜'兜底）按哈希派生，保证任何名字都有稳定外观
export function dishLook(name) {
  for (let i = 0; i < DISHES.length; i++) if (DISHES[i].name === name) return DISHES[i];
  const h = hashStr(name);
  const SHAPES = ['chunks', 'strips', 'greens', 'rice', 'soup'];
  const MAIN = [0xD94F3D, 0xB3673B, 0x58B24C, 0xF2C230, 0xF57B4A, 0xE0A52E];
  const ACCENT = [0xF2C230, 0xF5EBD7, 0x58B24C, 0xD94F3D, 0x7A5230, 0xF8E16C];
  return {
    name: String(name || '招牌菜'),
    shape: SHAPES[h % SHAPES.length],
    colors: [MAIN[(h >> 3) % MAIN.length], ACCENT[(h >> 7) % ACCENT.length]],
  };
}
