# 动画工作台 · cortico-world-rsm

[![npm](https://img.shields.io/npm/v/cortico-world-rsm.svg)](https://www.npmjs.com/package/cortico-world-rsm)
[![license](https://img.shields.io/npm/l/cortico-world-rsm.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-3c873a.svg)](https://nodejs.org)

为 [Coopanion](https://github.com/Pal-AI-Lab) 桌面伙伴 Coo 提供 [Remotion Studio](https://www.npmjs.com/package/remotion-studio-mcp) 集成能力的 World 扩展（`cortico.kind: world`，契约版本 6）。

装上之后，Coo 可以自行下载并安装动画工程、启停本机服务、查看运行日志、检查与更新工程版本，并通过四个门面工具驱动 Remotion Studio 的上百个创作工具。整个扩展**零运行时依赖**，只使用 Node 内置模块。

---

## 功能

- **工程生命周期管理**：从 npm 下载工程、按合并规则落地、安装依赖；支持原地更新与版本检查，不会覆盖工程数据或用户自建插件。
- **本机服务管理**：启动、停止、状态查询、日志读取、打开编辑器。端口可配置，服务地址、健康检查、编辑器链接与 MCP 端点始终跟随同一端口。
- **自动构建**：启动前执行 `prebuild` 与 `build`，构建失败即中止启动，避免打开缺少前端资源的编辑器。
- **门面式工具桥**：仅向对话上下文暴露 4 个门面工具，其余工具按需检索与调用，不占用上下文预算。
- **控制台面板**：WebUI 提供状态卡、常用配置、分组操作与增量日志；另由框架按配置组生成「配置」页签。
- **进程归属可追溯**：服务启动后写入归属记录，Coopanion 重启后仍可识别并停止该服务；Coopanion 正常退出时服务随之终止，不留孤儿进程。

## 环境要求

| 项 | 要求 |
| --- | --- |
| Coopanion | 0.2.17 及以上（World 契约 `api: 6`） |
| Node | 22 及以上（宿主 Core 运行时） |
| 网络 | 首次安装工程与依赖需要联网；渲染视频时 Remotion 会按需下载 Chrome Headless Shell |
| 平台 | 已在 Windows 11 完整验证；macOS 与 Linux 使用同一套 POSIX 实现，尚无实测 |

## 安装

### 通过扩展页（推荐）

1. 打开 Coopanion 的扩展页，从 npm 安装 `cortico-world-rsm`，或选择「从本地目录安装」指向本包目录。
2. **重启 Coopanion**（扩展为 ESM，不会热替换）。
3. 在 World 页打开「动画工作台」开关（新装 World 默认关闭）。

### 通过命令行

```bash
# 进入 Coopanion 的扩展目录
cd <Coopanion 数据目录>/extensions
pnpm add cortico-world-rsm
```

随后重启 Coopanion，并在 World 页启用。

## 快速开始

1. **安装工程**：在「控制台」面板点击「安装工程」，或让 Coo 调用 `studio_project({ action: "install" })`。工程默认落在 `~/.coopanion/remotion-studio`，依赖由随包 pnpm 安装。
   写入类动作须两次调用：先不带 `confirm` 取得预检（目标目录、目标版本、影响范围、耗时），用户确认后带 `confirm: true` 执行。未带 `confirm` 的调用不写入任何文件。
2. **启动服务**：点击「启动服务」或调用 `studio_service({ action: "start" })`。默认先构建再启动，首次可能需要数分钟。
3. **开始创作**：让 Coo 调用 `studio_start_guide` 获取开工指引，再按指引检索与调用具体工具。

## 工具

| 工具 | 用途 | 主要参数 |
| --- | --- | --- |
| `studio_service` | 服务状态、启动、停止、日志、打开编辑器 | `action`、`build`、`stream`、`since`、`limit` |
| `studio_project` | 工程状态、安装、指向已有目录、更新、版本检查、变更说明 | `action`、`dir`、`registry`、`version`、`confirm` |
| `studio_start_guide` | 获取开工指引（推荐的第一步） | `projectId` |
| `studio_get_guide` | 读取指定技能文档 | `name`、`section` |
| `studio_tool_search` | 在上百个底层工具中检索 | `query`、`all`、`names` |
| `studio_tool_call` | 调用检索到的底层工具 | `name`、`args` |

`studio_service` 与 `studio_project` 为管理工具；后四个为门面工具，用于按需加载创作能力。渲染类调用耗时较长，全部标记为可中断。

## 配置

配置位于「配置」页签，共 3 组 8 项；修改后立即生效。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| 服务端口 | `4380` | 服务监听、健康检查、编辑器地址与 MCP 端点同步更新；端口被占用时立即终止启动，不执行构建 |
| 工具调用时自动启动服务 | 关闭 | 开启后，服务未运行时工具调用会在后台启动服务；关闭时仅返回手动启动指引 |
| 启动前自动构建前端 | 开启 | 跳过构建会导致编辑器资源缺失；仅重启服务且源码未变更时可用 `build: false` 跳过当次构建 |
| 工程目录 | 空（`~/.coopanion/remotion-studio`） | 也可指向本地已有的工程副本；环境变量 `REMOTION_STUDIO_ROOT` 优先级更高 |
| npm 下载源 | `https://registry.npmmirror.com` | 工程下载、依赖安装、版本检查与变更说明读取均只使用该源 |
| 工程包名 | `remotion-studio-mcp` | npm 上的工程包名 |
| 调用超时 | `120000` | 单次 MCP 调用、构建或安装操作的上限（毫秒） |
| MCP 端点 | 空（由端口推导） | 自定义地址同时决定端口；仅接受 `127.0.0.1` / `localhost` / `::1` |

## 工作原理

```
Coo ──► 4 个门面工具 ──► POST http://127.0.0.1:<port>/mcp ──► remotion-studio 服务
                              （JSON-RPC，仅 initialize / tools/list / tools/call / ping）
```

- **工程安装**：使用 Node 内置 `fetch` 读取 registry 元数据，`zlib` 解压、内置解析器展开 tarball（正确处理 PAX 扩展头与中文文件名），随后按合并规则落地，最后由随包 pnpm 安装依赖。整个过程不依赖系统 `npm` 或 `tar`。
- **合并规则**：`data/`、`node_modules/`、`dist/`、`.git` 等本机状态完全不触碰；`plugins/`、`docs/` 按同名覆盖；`.other_modules/` 只补缺失项。
- **构建**：解析 `package.json` 中的脚本，直接以 Node 执行工程内的 `tsx` / `vite` 入口，不经 shell，因此 Windows 上不会弹出控制台窗口。
- **进程归属**：启动成功后写入 `<工程>/data/rsm-server.json`；新实例按「记录匹配 + 进程存活 + 健康检查端口一致」认领，全部通过才允许停止，用户在端口上自行启动的服务不会被误停。

## 文件与数据位置

| 内容 | 位置 |
| --- | --- |
| 工程与依赖 | `~/.coopanion/remotion-studio`（可配置） |
| 工程数据、用户插件 | `<工程>/data`、`<工程>/plugins`（合并时保留） |
| 服务归属记录 | `<工程>/data/rsm-server.json` |
| 服务进程 | 由本扩展拉起，随 Coopanion 退出而终止 |

## 常见问题

**启动失败，提示端口被占用？** 在「配置」页签更换端口，或先停止占用该端口的程序。端口检查发生在构建之前，不会浪费一次完整构建。

**首次安装很慢？** 依赖约 400 个包，耗时取决于网络与下载源。日志会分阶段显示查询、下载、解包、合并、安装依赖与运行时自检。若使用 pnpm 且缓存为空，首装可能是冷启动。

**渲染视频时提示下载浏览器？** 这是 Remotion 的正常行为：`@remotion/renderer` 在首次渲染时下载 Chrome Headless Shell（约百 MB），与依赖安装无关。

**服务显示「外部已有服务」且无法停止？** 该进程不是本扩展启动的，扩展不会终止它。若它确为上一次 Coopanion 留下的实例，归属记录会使其被识别为「已接管」并允许停止。

**改动扩展源码后不生效？** 扩展以 ESM 加载，需重启 Coopanion。

## 开发

```bash
npm run smoke        # 离线自检：契约、合并规则、协议、面板结构等
npm run smoke:live   # 追加真实 registry 与本机 /mcp 的联调
npm run describe     # 重新生成 describe.json
```

自检覆盖扩展清单契约、配置组与默认值一致性、World 干装载、tarball 解析（含 PAX 与路径穿越防护）、合并保留规则、端口联动、JSON-RPC 往返与错误映射、构建命令解析、pnpm 参数、依赖脚本代跑、写入确认闸口、面板结构与交互、运行时自检等 28 项。

## 发布

打标签即发布，认证走 npm Trusted Publishing（OIDC），仓库中不需要保存任何 npm token。

```bash
# 1. 同步修改 package.json 的 version 与 CHANGELOG
# 2. 提交并打标签（标签名必须与 version 一致，工作流会校验）
git commit -am "chore: 1.0.2"
git tag v1.0.2
git push origin main --tags
```

`.github/workflows/publish.yml` 依次执行：版本一致性校验 → 离线自检 → `npm publish`，并在 npm 生成 provenance 证明。也可在 Actions 页手动触发，用于补发或指定 `next` dist-tag。

首次启用前需在 npm 包的 Settings → Trusted publishing 绑定本仓库（`laojingwei` / `cortico-world-rsm` / `publish.yml`）。

## 目录结构

```
.
├── assets/icon.svg        扩展图标（WebUI 卡片头像）
├── dist/webui.js          控制台面板（浏览器端 bundle，手写 ESM）
├── scripts/smoke.mjs      自检脚本，同时生成 describe.json
├── src/
│   ├── index.mjs          扩展入口，导出 WorldDefinition
│   ├── world.mjs          World 实现：启动、停止、认领、面板数据面
│   ├── tools.mjs          6 个工具的声明与处理
│   ├── config.mjs         配置组与默认值
│   ├── project.mjs        工程安装、更新、版本检查、运行时自检
│   ├── process.mjs        进程管理、构建、日志环
│   ├── mcp-client.mjs     JSON-RPC 客户端
│   ├── tarball.mjs        零依赖 tarball 解析
│   ├── ownership.mjs      服务归属记录
│   └── ENV_PROMPT.md      注入模型的环境提示词
├── describe.json          工具自描述
├── CHANGELOG.md
└── LICENSE
```

## 许可

[MIT](./LICENSE)

---

## English

`cortico-world-rsm` is a Coopanion World extension (`cortico.kind: world`, API 6) that connects [remotion-studio-mcp](https://www.npmjs.com/package/remotion-studio-mcp) to the Coo desktop companion.

It downloads and installs the Remotion Studio project from npm, manages the local service (start / stop / logs / version check / in-place update), builds the frontend before launching, and bridges the studio's entire tool surface through four facade tools so that hundreds of tool definitions never enter the conversation context. The extension has **zero runtime dependencies**.

Install it from the Coopanion extensions page (or `pnpm add cortico-world-rsm` inside the extensions directory), restart Coopanion, then enable **Animation Studio** on the Worlds page.

Requires Coopanion 0.2.17+ and Node 22+. Verified on Windows 11; macOS and Linux share the same POSIX code paths but are untested.

Licensed under the [MIT License](./LICENSE).
