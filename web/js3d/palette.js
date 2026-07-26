// 调色板 —— 严格取自 docs/art-direction.md 第 6 节（截图采样值）
export const PAL = {
  floorLight: 0xD2A06B, // 木地板·浅
  floorDark:  0x96663C, // 木地板·深（提亮）
  counterTop: 0xFEC457, // 台面·明黄
  counterBody:0x8A5A33, // 棕木台面体
  woodDark:   0x7A5230,
  crateWood:  0xA8763E, // 食材箱木
  wall:       0xC9A876, // 墙面·暖灰泥
  wallCap:    0x6E4A2F, // 描边/压顶·深木
  stone:      0xB89B78, // 石砖·米
  metal:      0x928688, // 锅/器械金属
  stoveTop:   0x3A3640, // 炉盘黑
  flame:      0xF57B4A, // 火焰/加热·橙
  flameCore:  0xF8E16C, // 焰心
  red:        0xD94F3D, // 强调红
  paper:      0xF5EBD7, // 纸面/票卡·米白
  plate:      0xF4F2EC, // 瓷白
  board:      0xF0EBE0, // 砧板白
  knife:      0xC9CDD4, // 刀身银灰
  steel:      0xA8B2BC, // 不锈钢水槽
  frameWood:  0x6E4A2F, // 出餐口框
  grate:      0x7E8894, // 金属格栅
  skin:       0xF2C9A0, // 厨师皮肤
  glove:      0xFFFFFF, // 白手套
  hat:        0xFDFBF4, // 厨师帽白
  hatShade:   0xDDE3EA, // 帽底淡蓝灰阴影面
  shoe:       0x3A3244, // 小鞋尖深色
  warmLight:  0xFFE0B3, // 暖色主光
  groundOut:  0x4A3423, // 厨房外圈压暗底色·暖木
  smoke:      0x8A8494, // 灰烟
  dust:       0xEDE4D4, // 跑动烟尘
  water:      0x39AEC1, // 点缀青蓝
};

// 官方四色（chef.color 缺失时兜底轮换）
export const CHEF_COLORS = ['#447EE0', '#E0473C', '#58B24C', '#F2C230'];
