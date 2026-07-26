# Order Up! 🍳

> 把你的 AI 编程 agent 会话，实时变成一场「胡闹厨房」。
> Turn your AI coding agent sessions into a real-time Overcooked-style kitchen.

![Order Up! 实机画面](screenshots/3d-mock.png)

**Order Up!** 是一个纯本地的可视化玩具：它盯着本机的 agent 会话记录，把每一次工具调用实时演成一间 3D 卡通厨房里的忙活——每个会话是一间厨房，每个 agent / 子 agent 是一位 Q 版厨师。读文件就去案板看菜谱，改代码就去炒锅切菜，跑命令就上灶台开火，任务完成就从出餐口上一道菜：**Order up!** ✅

- 🎮 **3D 卡通厨房**：参考 Overcooked 实机画面还原，Three.js 本地内置，无任何 CDN
- 📦 **零外部依赖**：纯 Node.js 实现，无需构建，一行命令开火
- 🔒 **纯本地**：只读取会话文件，绝不写入；服务器只监听 localhost
- 🗺️ **路线图**：当前支持 Codex CLI，计划适配 Claude Code 与 Kimi CLI——所有 AI 厨师在同一间厨房出餐

## 玩法说明：事件 → 厨师动作

| agent 事件 | 厨师动作 | 工位 |
|---|---|---|
| 读文件 / `cat`、`rg`、`ls` 等只读命令 | 看菜谱 📖 | 案板 |
| `apply_patch` / 编辑文件 | 切菜炒菜 🔪 | 炒锅 |
| `exec_command` / shell 命令 | 开火上灶 🔥 | 灶台 |
| `web_search` | 打电话订食材 📞 | 电话台 |
| MCP / 自定义工具调用 | 高压锅 ⚡ | 特殊厨具 |
| `agent_reasoning` / 规划 | 想菜单 💭 | 原地思考 |
| `agent_message` / `user_message` | 喊话 / 顾客点单 🔔 | 出餐口 |
| `task_complete` | 出餐 ✅（计数 +1，弹 toast） | 出餐口 |
| `turn_aborted` / 补丁失败 | 糊了 💥（烟雾特效） | 原地 |
| 子 agent 开工 / 新会话 | 新厨师入职 👨‍🍳 | 从门口走进来 |
| 5 秒无新事件 | 回休息区打瞌睡 💤 | 休息区 |

## 厨房切换与 3D 视角

- **按序展示**：顶部切换条把厨房按最近活跃（lastTs）倒序排列，一次只展示一间全屏 3D 厨房
- **任意切换**：点击厨房卡片 / `←` `→` 键前后切换 / 数字键 `1-9` 直达 / 切换条两侧 ◀ ▶ 按钮
- **跟随最新**（默认开）：别家厨房来新事件时自动跳过去围观；手动切换后暂停 30 秒再恢复跟随；其他厨房的未读事件会在卡片上累计红点
- **3D 视角**：鼠标拖拽可在有限范围内环绕厨房（方位 ±40°、俯仰 45°–70°），滚轮缩放
- 右侧「订单流水」是 Overcooked 订单票样式（撕纸边 + 彩色时间条），可切换「当前厨房 / 全部」过滤
- 顶部全局统计（厨房数 / 活跃数 / 厨师数 / 已出餐）、歇业厨房压暗并挂「歇业中」木牌、厨师超过 12 人时显示「后厨 +N」木牌

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
- 厨房归并规则：同一根线程（含子 agent 线程）归为一间厨房；无父子信息时按 `cwd` 归并。厨房名取 `cwd` 的目录名，重名时自动追加 `#短id` 消歧。

## 演示模式

没有 agent 会话也能看效果，两种玩法：

- `--demo`：后端模拟器驱动，走完整 SSE 链路（用于验收真实数据通路）；
- `http://localhost:4848/?mock=1`：纯前端内置模拟数据，后端随便什么模式都行（用于前端独立开发）。

## 路线图

- [x] Codex CLI 数据源（`~/.codex/sessions`）
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
│   ├── js3d/   kitchen3d / stations / chef / fx / palette / textures（3D 厨房渲染器）
│   └── js/     store / net / mock / kitchens-ui / main / renderer-stub（数据层 + 切换系统 + 降级渲染器）
├── docs/art-direction.md  # Overcooked 实机画面美术调研
├── screenshots/           # 实机截图
└── references/            # Overcooked 官方截图参考
```

## License

MIT
