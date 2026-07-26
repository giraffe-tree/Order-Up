# Fun_FX 集成说明（厨师个性 / 特效 / 音效）

本文件由 Fun_FX 组维护，说明 `chef.js` / `fx.js` / `audio.js` 的新能力，
以及需要其他组（kitchen3d.js / index.html 所有者）配合的集成点。

**好消息：3D 特效与厨师个性零集成成本** —— 所有视觉新特性都在
`ChefActor.update(dt)` 与 `FX.update(dt)` 内部完成，kitchen3d.js 现有的
`_update(dt, t)` 每帧已调用这两者，**无需新增 dt 或事件钩子**。
唯一需要配合的是：① 页面加载 `audio.js`；② 在 5 个事件点补 1 行音效调用（可选但强烈建议）。

---

## 1. 【需配合 · index.html（UIShell）】加载 audio.js

文件：`web/index.html`，在 `<script type="module">` 入口之前加一行普通脚本：

```html
<script src="js3d/audio.js"></script>
```

说明：
- 纯 IIFE，无 import/export，普通 `<script>` 与 module 加载顺序无关；
- 加载后自动暴露 `window.COSound`，并在首次用户手势前保持完全静默
  （符合浏览器自动播放策略，不会在控制台产生警告）；
- `web/js3d/test.html` 建议同样加一行 `<script src="./audio.js"></script>`，便于自测音效。

## 2. 【需配合 · kitchen3d.js（Engine3D）】5 个音效触发点（各 1 行，均有空值保护）

全部用 `window.COSound && window.COSound.play(...)` 形式，audio.js 未加载时自动跳过，
即使不接音效，视觉特效已完整可用。

### 2.1 `chefAction(chefId, action)` —— 按动作类型发声
位置：`const kind = action.kind;` 之后（约第 124 行附近）：

```js
if (window.COSound) {
  if (kind === 'edit') window.COSound.play('chop');        // 切菜哒哒
  else if (kind === 'exec') window.COSound.play('sizzle'); // 炒菜嘶嘶
  else if (kind === 'burn') window.COSound.play('burn');   // 糊了闷响
  else if (kind === 'join') window.COSound.play('horn');   // 新厨师入职号角
}
```

### 2.2 `dishServed(dish)` —— 出餐叮叮
位置：`this.fx.dishServed(...)` 调用之后（约第 160 行附近）：

```js
if (window.COSound) window.COSound.play('ding');
```

### 2.3（可选）静音开关
UI 若做音效开关按钮，直接调 `window.COSound.setMuted(true/false)`，
读取状态用 `window.COSound.muted`。默认不静音（但手势前静默）。

---

## 3. 【已内置 · 无需改动 kitchen3d.js】视觉特性清单

以下全部在 chef.js / fx.js 内部实现，现有渲染循环自动生效：

| 特性 | 实现位置 | 说明 |
|---|---|---|
| 待机小动作 | `ChefActor._updateIdle` | rest 状态每 6–14 秒随机：东张西望 / 擦汗（甩汗滴粒子）/ 颠勺（蹲起+火星），各厨师相位随机 |
| 打瞌睡 Zzz | `ChefActor._spawnZzz`（原有） | sleep 状态持续冒 z，眼睛眯成一条缝 |
| 走路上下颠簸 | `ChefActor.update` walk 分支（原有+强化） | 挤压拉伸 + 新增手臂前后摆动 |
| 转向平滑 | `ChefActor.update` 顶部（原有） | faceY 角度插值，最短弧 |
| 程序化脸部 | `ChefActor._updateEyes` | 眼睛组：周期性眨眼、休息/思考时眼神左右游移、睡觉眯眼、白色高光点 |
| 名牌面向镜头 | `makeSprite`（原有） | THREE.Sprite 天然 billboard，任何角度可读 |
| 切菜飞屑 | `FX.spawn('chip')` | 彩色菜屑（菜叶绿/番茄红/蛋黄/胡萝卜橙，多色材质随机），edit 动作高频迸发 |
| 灶台火苗跳动 | `FX.update` flame 分支 | 火焰粒子叠加 22Hz 亮度/尺寸闪动，exec 时厨师还不时颠出火星 |
| 糊了浓烟+火星 | `FX.burnBurst` | burn 瞬间 14 团浓烟 + 9 颗上迸火星，burn 状态持续烟柱中随机夹火星 |
| 出餐彩纸/星星 | `FX.celebrate` | `dishServed` 内置调用：16 片飘摆彩纸 + 5 颗旋转弹跳五角星（12 颗对象池） |
| 电话声波圈 | `FX.ringWave` | search 动作每 0.85s 从电话台面扩散 3 圈红色圆环（8 圈对象池，错相位） |
| 对象池 | `FX` 构造器 | 粒子池 420、星星池 12、声波圈池 8，运行期零分配（纹理弹字除外，沿用原设计） |

---

## 4. 兼容性说明

- `fx.dishServed(from)` 签名不变，内部自动追加彩纸星星，kitchen3d.js 不调 celebrate 也有完整效果；
- `chef.burn()` 签名不变，内部改调 `fx.burnBurst`（fx.js 新方法），无需上游改动；
- 未引入任何新依赖；three.js 仅用 r160 已有的 `ExtrudeGeometry` / `RingGeometry`；
- 若 `audio.js` 未加载，所有视觉特性不受影响，音效调用点因空值保护静默跳过。
