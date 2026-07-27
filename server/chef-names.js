// chef-names.js — 128 人预定义厨师池 + 稳定 hash 命名
// 厨师名不再用会话标题（那是厨房名/招牌）或 agent_nickname
// （真实数据里常是「019f9e57…」这类线程 id 前缀），统一按
// hash(thread 稳定 id) 映射到池中一名；同一厨房内撞名顺延（见 parser.js）。
// 名字风格：科学家/计算史短名 + 厨房食材英文名 + 中式小名，全部去重。

export const CHEF_NAMES = [
  // 科学家 / 计算史（38）
  'Boole', 'Peirce', 'Boyle', 'Curie', 'Turing', 'Hopper', 'Noether', 'Hypatia',
  'Faraday', 'Maxwell', 'Hertz', 'Pascal', 'Euler', 'Gauss', 'Fermat', 'Kepler',
  'Hubble', 'Feynman', 'Bohr', 'Planck', 'Dirac', 'Lovelace', 'Edison', 'Tesla',
  'Darwin', 'Mendel', 'Pavlov', 'Hooke', 'Leibniz', 'Riemann', 'Cantor', 'Godel',
  'Shannon', 'Neumann', 'Wiener', 'Ramsey', 'Ampere', 'Zuse',
  // 厨房 / 食材英文名（42）
  'Basil', 'Sage', 'Thyme', 'Pepper', 'Ginger', 'Olive', 'Maple', 'Honey',
  'Miso', 'Mocha', 'Latte', 'Cocoa', 'Waffle', 'Bagel', 'Pretzel', 'Noodle',
  'Pickle', 'Truffle', 'Caramel', 'Vanilla', 'Saffron', 'Wasabi', 'Sesame', 'Peanut',
  'Cashew', 'Almond', 'Butter', 'Cheese', 'Bacon', 'Muffin', 'Cookie', 'Donut',
  'Pudding', 'Tofu', 'Sushi', 'Ramen', 'Udon', 'Soba', 'Taco', 'Nacho',
  'Salsa', 'Brisket',
  // 中式小名 / 点心菜名（48）
  '阿汤', '小炒', '老白', '阿糖', '椒椒', '团团', '果果', '阿明',
  '小锅', '阿卜', '老王', '阿花', '小辣椒', '阿酱', '小笼', '锅贴',
  '麻婆', '年糕', '汤圆', '豆花', '烧饼', '馒头', '花卷', '包子',
  '饺子', '烧麦', '春卷', '糖藕', '卤蛋', '咸蛋', '皮蛋', '豆浆',
  '油条', '米粉', '米线', '馄饨', '抄手', '云吞', '煲仔', '砂锅',
  '铁板', '炭火', '老汤', '高汤', '头灶', '二灶', '掌勺', '颠锅',
];

// FNV-1a 32bit：简单确定性 hash（同一 thread id 永远得到同一基准位）
export function chefNameIndex(id) {
  const s = String(id ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % CHEF_NAMES.length;
}
