# Codex Overcooked — 把 Codex 会话变成「胡闹厨房」

## 目标
一个游戏化（Overcooked 风格）的本地网站：实时读取本机 `~/.codex/sessions/**/*.jsonl`，
把每个顶级会话渲染成一间厨房，每个 agent / 子 agent 是一位像素厨师，按真实事件
（读文件、编辑、执行命令、搜索、思考、说话）在工位之间跑动干活。
一行命令安装并打开本地网站。

## 侦察结论（已验证）
- 会话文件：`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`，JSONL 每行一条记录。
- 行类型：`session_meta` / `response_item` / `event_msg` / `turn_context` / `world_state` / `compacted`。
- `session_meta.payload`：`id`、`forked_from_id`、`parent_thread_id`、`cwd`、`originator`、
  `agent_nickname`、`agent_path`、`source.subagent.thread_spawn{parent_thread_id, depth, agent_path, agent_nickname}`。
  → 父子关系可建厨师层级；同 `cwd` 或同根线程归为一间厨房。
- 关键 `event_msg.payload.type`：`task_started`、`task_complete`、`turn_aborted`、`agent_reasoning`、
  `agent_message`、`user_message`、`patch_apply_end`、`exec_command_begin/end`、`mcp_tool_call_end`、
  `web_search_end`、`sub_agent_activity`、`token_count`。
- `response_item.payload.type`：`function_call`（name: `exec_command`、`apply_patch`、…）、
  `function_call_output`、`custom_tool_call`、`message`、`reasoning`。
- 本机 Node v24，无需任何外部依赖（纯 Node 实现，保证一行安装）。

## 动作 → 厨房语义映射
| codex 事件 | 厨师动作 | 工位 |
|---|---|---|
| read/view 类工具调用、file 读取 | 看菜谱 📖 | 案板 |
| `apply_patch` / `patch_apply_end` / 编辑 | 切菜炒菜 🔪 | 炒锅 |
| `exec_command*` / shell | 开火上灶 🔥 | 灶台 |
| `web_search_end` | 打电话订食材 📞 | 电话台 |
| `mcp_tool_call*` / custom_tool | 高压锅 ⚡ | 特殊厨具 |
| `agent_reasoning` | 想菜单 💭 | 原地思考 |
| `agent_message` / `user_message` | 喊话 🔔 | 出餐口 |
| `task_complete` | 出餐 ✅ | 出餐口 +1 道菜 |
| `turn_aborted` / error | 糊了 💥 | 烟雾特效 |
| `sub_agent_activity` / 新 session_meta(subagent) | 新厨师入职 👨‍🍳 | — |

## 项目结构
```
codex-overcooked-by-kimi/
├── package.json            # name: codex-kitchen, bin: { "codex-kitchen": "bin/codex-kitchen.js" }
├── bin/codex-kitchen.js    # CLI：解析参数→启动 server→自动开浏览器
├── server/
│   ├── index.js            # 纯 Node http：静态服务 web/ + GET /api/events (SSE) + GET /api/snapshot
│   ├── parser.js           # JSONL → 标准事件（增量解析，记录每文件 offset）
│   ├── watcher.js          # 扫描+监听 ~/.codex/sessions（fs.watch + 轮询兜底）
│   └── demo.js             # --demo 模式：模拟器产出同构事件流
├── web/
│   ├── index.html
│   ├── css/style.css
│   └── js/                 # 游戏前端（canvas 像素风，无构建步骤、无外部依赖）
└── README.md               # 一行安装：npx codex-kitchen / 本地 node bin/codex-kitchen.js
```

## SSE / API 契约（前后端唯一接口，双方严格遵守）
`GET /api/snapshot` → `{ "kitchens": Kitchen[] }`
`GET /api/events` (SSE) → 每条消息 `data: <json>\n\n`，json 形如：
```json
{ "type": "snapshot",      "kitchens": [Kitchen] }
{ "type": "chef_added",    "kitchen": Kitchen, "chef": Chef }
{ "type": "chef_action",   "kitchenId": "k1", "chefId": "c1",
  "action": { "kind": "read|edit|exec|search|tool|think|speak|serve|burn|join|idle",
              "label": "短中文标签", "detail": "文件名或命令(截断80字)", "ts": 1721850000000 } }
{ "type": "chef_status",   "kitchenId": "k1", "chefId": "c1", "status": "cooking|idle|done" }
{ "type": "dish_served",   "kitchenId": "k1", "dish": { "name": "...", "by": "chefName", "ts": 0 } }
```
```ts
Kitchen = { id: string, name: string /* cwd basename */, cwd: string, chefs: Chef[],
            servedCount: number, active: boolean, lastTs: number }
Chef    = { id: string, name: string /* agent_nickname 或短id */, role: string|null,
            depth: number, status: "cooking"|"idle"|"done", color: string /* hex，后端分配 */,
            lastAction: Action|null }
```
- 厨房归并规则：按「根线程 id」归并；无父子信息时按 `cwd` 归并。厨房 id 稳定。
- 启动时解析最近 48h 内（或最近 30 个）会话文件重建快照；活跃文件实时 tail。
- 5 秒无新事件的厨师置 `idle`（发 `chef_status`）；文件 10 分钟无写入置厨房 `active:false`。
- CLI：`--port <n>`（默认 4848，占用则自增）、`--demo`、`--no-open`、`--sessions-dir <path>`。

## 阶段
- Stage 1（并行）：
  - Backend_Engineer（coder）：server/ + bin/ + package.json，含 --demo 模拟器；自测 SSE 与快照。
  - Game_Frontend（coder）：web/ 全部游戏前端；内置 mock 模式（?mock=1 用内置假数据，便于独立开发）。
- Stage 2（串行）：
  - Integrator（coder）：联调真实数据→游戏呈现；写 README（npx 一行安装 + curl 脚本备选）；
    用本机真实 ~/.codex/sessions 与 --demo 双模式冒烟测试；修复问题。
- Stage 3：最终验收（端口、页面渲染、事件流、README 命令可用）。

## 视觉基调
像素风、暖色调、低饱和（奶油/木色/番茄红点缀），无蓝紫渐变；厨师=像素小人+厨师帽，
围裙颜色区分；动作时厨师跑向对应工位并播放小动画；右侧「订单流水」展示最近事件；
顶部标题「Codex Overcooked」。界面语言：中文。

---

# 第二阶段：3D 化改造（2026-07-26 晚）

## 需求
1. 以真实 Overcooked 游戏画面为美术基准（已调研：docs/art-direction.md + references/ref-01~06.jpg）
2. 前端从 2D Canvas 重做为 3D（Three.js，本地 vendor，保持零 npm 依赖）
3. 厨房不再平铺：按 lastTs 倒序展示，一次一间，可任意切换（列表点选/←→键/数字键/跟随最新）

## 3D 渲染器 API 契约（web/js3d/kitchen3d.js，ES module）
```js
import { KitchenRenderer } from '../js3d/kitchen3d.js';  // 内部相对导入 ../vendor/three.module.min.js
const r = new KitchenRenderer(containerEl);
r.setKitchen(kitchen, chefs);   // 切换厨房：清场重建，厨师从门口入场
r.addChef(chef);                // 新厨师入职
r.chefAction(chefId, action);   // action={kind,label,detail,ts}，跑位+工位动画
r.chefStatus(chefId, status);   // cooking|idle|done
r.dishServed(dish);             // 出餐口飞菜+「+1」
r.resize();  r.dispose();
```
action.kind → 工位映射不变：read→案板 edit→炒锅 exec→灶台 search→电话台 tool→高压锅 speak/serve→出餐口 think→原地 burn→冒烟。
UI 壳对 js3d 的引用必须带降级：动态 import 失败时回退到自己的 stub，保证两个 worker 可独立开发。

## 分工（文件所有权互不重叠）
- Engine3D（coder）：web/vendor/three.module.min.js（curl 下载 r160）+ web/js3d/**（含自测页 web/js3d/test.html）。禁碰 index.html / css / web/js 既有文件。
- UIShell（coder）：重写 web/index.html、web/css/style.css、web/js/main.js，新增 web/js/kitchens-ui.js 与自测用 web/js/renderer-stub.js，可改 web/js/{store,net,mock}.js。禁碰 web/js3d/** 与 web/vendor/**。
- 后端 server/ 不动。
- Stage 3：集成验收（Orchestrator 本人）：真实+demo 双模式截图、切换逻辑、README 更新。
