# Order Up! 🍳

> 把你的 AI 编程 agent 会话，实时变成一场「胡闹厨房」。
> Turn your AI coding agent sessions into a real-time Overcooked-style kitchen.

![Order Up! 实机画面](screenshots/3d-mock.png)

**Order Up!** 是一个纯本地的可视化玩具：它盯着本机的 agent 会话记录，把每一次工具调用实时演成一间 3D 卡通厨房里的忙活——每个会话是一间厨房，每个 agent / 子 agent 是一位 Q 版厨师。读文件就去案板看菜谱，改代码就去炒锅切菜，跑命令就上灶台开火，任务完成就从出餐口上一道菜：**Order up!** ✅

- 🎮 **3D 卡通厨房**：参考 Overcooked 实机画面还原，Three.js 本地内置，无任何 CDN
- 🔊 **合成音效**：纯 WebAudio 振荡器/噪声合成，切菜哒哒、炒菜嘶嘶、出餐叮叮、糊了闷响，顶栏 🔊 一键静音
- 🧭 **新手友好**：首次打开弹出引导浮层；没有厨房时显示「还没开火」空态指引；顶栏 `?` 随时重看说明
- 📦 **零外部依赖**：纯 Node.js 实现，无需构建，一行命令开火
- 🔒 **纯本地**：只读取会话文件，绝不写入；服务器只监听 localhost
- ✅ **自带自测**：`npm test` 19 项断言（回放 / SSE / demo / 健壮性），前端另有切换系统脚本化自测
- 🗺️ **路线图**：当前支持 Codex CLI，计划适配 Claude Code 与 Kimi CLI——所有 AI 厨师在同一间厨房出餐

## 玩法说明：事件 → 厨师动作

| agent 事件 | 厨师动作 | 工位 |
|---|---|---|
| 读文件 / `cat`、`rg`、`ls` 等只读命令 | 看菜谱 📖 | 案板 |
| `view_image` 查看图片 | 看图片 📖 | 案板 |
| `apply_patch` / 编辑文件成功 | 切菜炒菜 🔪 | 炒锅 |
| 补丁应用失败 | 糊了 💥（烟雾特效） | 原地 |
| `exec_command` / shell 命令 | 开火上灶 🔥 | 灶台 |
| `write_stdin` 查看终端输出 | 盯灶台 👀 | 灶台 |
| `write_stdin` 向终端输入内容 | 喂柴火 🪵 | 灶台 |
| `web_search` | 打电话订食材 📞 | 电话台 |
| MCP / 自定义工具调用 | 高压锅 ⚡ | 特殊厨具 |
| `imagegen` / 生成图片 | 画招牌 🎨 | 特殊厨具 |
| `agent_reasoning` / `update_plan` / 目标管理 | 想菜单 💭 | 原地思考 |
| `context_compacted` 上下文压缩 | 收拾台面 🧹 | 原地 |
| `thread_rolled_back` 会话回滚 | 复盘 🔙 | 原地 |
| `agent_message` / `user_message` | 喊话 / 顾客点单 🔔 | 出餐口 |
| 协作工具（`send_message` / `wait_agent` / `followup_task` 等） | 给队友传话 / 等队友 💬 | 原地 |
| `task_complete` | 出餐 ✅（计数 +1，弹 toast + 音效） | 出餐口 |
| `turn_aborted` / 子 agent 被叫停（`interrupted`） | 糊了 💥（烟雾特效） | 原地 |
| `spawn_agent` / 子 agent 开工 / 新会话 | 派出小厨师 / 新厨师入职 👨‍🍳 | 从门口走进来 |
| 5 秒无新事件 | 回休息区打瞌睡 💤 | 休息区 |

## 厨房切换与 3D 视角

- **按序展示**：顶部切换条把厨房按最近活跃（lastTs）倒序排列，一次只展示一间全屏 3D 厨房
- **任意切换**：点击厨房卡片 / `←` `→` 键前后切换 / 数字键 `1-9` 直达 / 切换条两侧 ◀ ▶ 按钮
- **跟随最新**（默认开）：别家厨房来新事件时自动跳过去围观；手动切换后暂停 30 秒再恢复跟随；其他厨房的未读事件会在卡片上累计红点
- **3D 视角**：鼠标拖拽可在有限范围内环绕厨房（方位 ±40°、俯仰 45°–70°），滚轮缩放
- **歇业置灰**：10 分钟无新写入的厨房自动歇业，切换条卡片压暗并挂「歇业中」木牌
- **断线横幅**：SSE 连接断开时舞台顶部挂出「📡 连接断开，正在自动重连…」横幅，重连成功自动消失
- 顶部全局统计（活跃厨房 / 厨师数 / 已出餐）、厨师超过 12 人时显示「后厨 +N」木牌

## 订单流水

右侧「订单流水」是 Overcooked 订单票样式（撕纸边 + 彩色时间条），点「📜 订单流水」按钮展开/收起：

- **厨房过滤**：「当前厨房 / 全部」切换，全部模式下每张票标注来源厨房名
- **类型过滤 chips**：全部 / ✅ 出餐 / 💥 糊了 / 🔔 喊话 / 🛠 工具，一键只看某类事件
- **相对时间**：「刚刚 / 12s 前 / 3m 前」每 5 秒自动刷新，悬停可看绝对时间
- **长详情展开**：过长的命令/路径默认截断，点击可展开 / 收起

## 音效与引导

- **音效**：纯 WebAudio 合成（零音频资源文件），切菜哒哒、炒菜嘶嘶、出餐叮叮、糊了闷响、新厨师号角、电话铃各有音色；同类音效有节流，密集事件不会糊成一坨。顶栏 🔊 按钮一键静音/恢复。
- **自动播放策略**：遵守浏览器规范，首次点击 / 按键（任意用户手势）之后才发声，之前静默不报错。
- **首次引导浮层**：第一次打开自动弹出玩法说明（厨师动作对照表 + 快捷键），点「开始围观 🍽」或 `Esc` 关闭并记忆（localStorage）；之后随时点顶栏 `?` 按钮或按 `?` 键重看。
- **空态引导**：还没有任何厨房时，舞台中央显示「厨房还没开火」指引卡，给出启动 codex 会话与演示模式两种入口。

## 快速开始

要求 Node.js ≥ 18。

### 方式一：本地直接跑（现在就能用）

```sh
git clone <this-repo>
cd Order-Up
node bin/codex-kitchen.js
```

### 方式二：npm link 后全局使用

```sh
npm link
codex-kitchen
```

### 方式三：一键安装脚本

```sh
curl -fsSL <your-repo-url>/install.sh | sh
```

> 使用前请把 `<your-repo-url>` 替换为实际 git 仓库地址（或先设置环境变量 `CODEX_KITCHEN_REPO`）。
> 脚本会把仓库克隆到 `~/.codex-kitchen` 并执行 `npm link`，之后可直接使用 `codex-kitchen` 命令。

### 方式四：npx（发布后）

```sh
npx codex-kitchen
```

> ⚠️ 这是发布后的目标用法，需要先把包 `npm publish` 到 npm registry。当前包尚未发布，请先用上面的本地方式。

启动后自动打开浏览器（默认 http://localhost:4848/），然后你用 agent 干活，厨房里就有厨师开始跑堂了。

## CLI 参数

| 参数 | 说明 | 默认值 |
|---|---|---|
| `--port <n>` | 监听端口；被占用时自动自增（最多试 50 个） | `4848` |
| `--demo` | 演示模式：内置模拟器产出 3 间厨房的事件流，无需真实会话 | 关 |
| `--no-open` | 启动后不自动打开浏览器 | 关（自动打开） |
| `--sessions-dir <path>` | agent 会话目录 | `~/.codex/sessions` |
| `-h, --help` | 显示帮助 | — |

## 数据源说明

- 只读取 `~/.codex/sessions/**/*.jsonl`（Codex CLI 的会话记录），**绝不写入、修改或删除**任何会话文件。
- 启动时回放最近 48 小时内（或最近 30 个）的会话文件重建厨房快照；之后通过 `fs.watch` + 轮询增量 tail，新事件实时进入厨房。
- 厨房归并规则：同一根线程（含子 agent 线程）归为一间厨房；无父子信息时按 `cwd` 归并。厨房名优先取会话标题，拿不到再取 `cwd` 的目录名，重名时自动追加 `#短id` 消歧。

## 演示模式

没有 agent 会话也能看效果，两种玩法：

- `--demo`：后端模拟器驱动，走完整 SSE 链路（用于验收真实数据通路）；
- `http://localhost:4848/?mock=1`：纯前端内置模拟数据，后端随便什么模式都行（用于前端独立开发）。

## 自测

- **服务端自测**：`npm test` 跑 `scripts/selftest-server.js`——造 fixture 会话（含坏行 / 半截行 / 全事件类型 / 父子线程），断言回放快照、SSE 实时流、demo 模式与畸形输入健壮性，共 19 项断言。
- **前端自测**：`http://localhost:4848/?mock=1&selftest=1` 脚本化断言切换条排序、跟随跳转、点击/键盘切换、未读红点、订单票渲染与过滤、渲染器降级、控制台零报错，结果写入页面 `#selftest-result`（供无头浏览器校验）。

## 路线图

- [x] Codex CLI 数据源（`~/.codex/sessions`）
- [x] 自测脚本（`npm test` 服务端 19 项断言 + 前端切换系统自测）
- [ ] Claude Code 数据源适配
- [ ] Kimi CLI 数据源适配
- [ ] 多数据源同屏：所有 AI 厨师在同一间厨房出餐
- [ ] npm 发布（`npx` 一键开火）

## 隐私说明

纯本地应用：数据不离开你的机器。服务器只监听 localhost，不联网、不上报、不收集任何信息；会话内容仅在内存中解析后通过本地页面展示。

## 项目结构

```
├── bin/codex-kitchen.js   # CLI 入口
├── server/                # 纯 Node 后端（静态托管 + SSE + JSONL 解析/监听 + demo 模拟器）
│   ├── index.js  parser.js  watcher.js  demo.js
├── web/                   # 游戏前端（无构建、无外部 CDN）
│   ├── index.html  css/style.css
│   ├── vendor/three.module.min.js   # Three.js r160 本地内置
│   ├── js3d/   kitchen3d / stations / chef / decor / fx / audio / palette / textures
│   │           （3D 厨房渲染器 + WebAudio 合成音效）
│   └── js/     store / net / mock / kitchens-ui / main / selftest / renderer-stub
│               （数据层 + 切换系统 + 前端自测 + 降级渲染器）
├── scripts/selftest-server.js   # 服务端自测（npm test，19 项断言）
├── docs/                  # art-direction.md 美术调研 / scoring.md 评分标准
├── screenshots/           # 实机截图
└── references/            # Overcooked 官方截图参考
```

## License

MIT
