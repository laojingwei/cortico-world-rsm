/**
 * World 实例。持有活配置引用（WebUI 修改配置后，下一次工具调用即读取新值）、本实例启动的进程与日志环形缓冲。
 *
 * 挂载约束：start() 仅执行一次只读探活与只读认领，不启动服务、不执行构建、不下载工程。
 * 服务默认不自动启动（autoStart 默认关闭），须由用户在配置页启用或显式调用 studio_service({action:"start"})；
 * 工程下载与更新一律要求模型显式调用 studio_project。
 * 启动约束：所有启动路径（手动 start 与门面工具触发的自动启动）统一经过 launch()，
 *   默认依次执行 prebuild 与 build，构建失败即中止启动；端口上已有外部服务时直接复用，不重写构建产物。
 * 归属约束：服务启动后写入 <工程>/data/rsm-server.json；下一个 Core 实例挂载时按
 *   「归属记录 + 进程存活 + health 端口一致」认领，认领后方可从面板或工具终止。
 *   killTree 同步等待，Core 正常退出（框架 await stop()）时服务必定被终止；
 *   另有 process.on('exit') 同步兜底。由用户或其他程序启动的外部服务不受影响。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REGISTRY, RSM_ID, configGroups, effectivePort, resolveEndpoint, resolveRoot,
} from './config.mjs';
import {
  assertLoopback, callTool, originOf,
} from './mcp-client.mjs';
import {
  LogRing, isPortFree, killTree, openBrowser, probeHealth, runBuild, startServer,
} from './process.mjs';
import {
  checkUpdates, installProject, projectStatus, readChangelog, updateProject, useProject,
} from './project.mjs';
import { claimOwned, clearOwner, writeOwner } from './ownership.mjs';
import { createTools } from './tools.mjs';

export const ENV_PROMPT_PATH = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const WEB_TEXT = {
  zh: {
    label: '动画工作台',
    lampService: '本机服务',
    lampProject: '工程',
    lampBridge: 'MCP 桥',
    off: '扩展未启用',
    online: '在线',
    offline: '未启动',
    error: '异常',
    loading: '启动中',
    openEditor: '打开编辑器',
    panelTitle: '控制台',
    panelDesc: '安装与更新工程、启动或停止服务、调整常用配置、查看运行日志，无需经由模型执行。完整配置项位于「配置」页签。',
    promptTitle: '动画工作台环境提示词',
    promptDesc: '说明工程安装与服务启动的触发条件，以及四个门面工具的使用顺序。',
  },
  en: {
    label: 'Animation Studio',
    lampService: 'Local service',
    lampProject: 'Project',
    lampBridge: 'MCP bridge',
    off: 'World is disabled',
    online: 'Online',
    offline: 'Not running',
    error: 'Error',
    loading: 'Starting',
    openEditor: 'Open editor',
    panelTitle: 'Control panel',
    panelDesc: 'Install or update the project, start or stop the service, adjust common settings and review logs without going through the model. The full set of settings is on the Config tab.',
    promptTitle: 'Animation Studio environment prompt',
    promptDesc: 'States when to install the project and start the service, and the order in which the four facade tools are used.',
  },
};

export class StudioWorld {
  constructor(ctx) {
    this.ctx = ctx;
    this.cfg = ctx.cfg;               // 共享活引用，不拷贝
    this.dataDir = ctx.dataDir;
    this.logs = new LogRing();
    this.owned = null;                // ChildProcess，或跨实例认领来的纯 { pid, adopted }
    this.ownedSource = null;          // 'this-core' | 'adopted'
    this.mode = 'stopped';
    this.lastHealthy = false;
    this.lastError = null;
    this.host = null;
    this.starting = null;            // 并发启动合并成一次，避免两个 vite build 同时写 dist/web
    this.onLog = (stream, chunk) => this.logs.push(stream, chunk);
    /** 可替换的外部副作用集合：自检用 stub 断言「所有启动路径都经过构建」，无需真的起进程。 */
    this.hooks = { probeHealth, isPortFree, runBuild, startServer, killTree };
    /**
     * Core 进程退出兜底。`exit` 事件里只能做同步操作，killTree 已是 spawnSync。
     * 正常关机时框架先 await stop()，那时 owned 已清空，这里自然跳过。
     */
    this.onCoreExit = () => {
      if (!this.owned) return;
      try { this.hooks.killTree(this.owned); } catch { /* 退出路径不许抛 */ }
      try { clearOwner(resolveRoot(this.cfg), this.owned.pid); } catch { /* ignore */ }
      this.owned = null;
    };
  }

  get id() { return RSM_ID; }

  get endpoint() { return resolveEndpoint(this.cfg); }
  get origin() { return originOf(this.endpoint); }
  get port() { return effectivePort(this.cfg); }
  get timeoutMs() { return Number(this.cfg.timeoutMs) || 120000; }
  get registry() { return this.cfg.registry || DEFAULT_REGISTRY; }

  /** 挂载：只读探活 + 只读认领，不启动/不杀任何进程。整个方法不许抛错。 */
  async start(host) {
    this.host = host;
    try {
      assertLoopback(this.endpoint);
      this.lastHealthy = await this.hooks.probeHealth(this.origin, 1200);
      if (this.lastHealthy) await this.adoptIfOwned();
    } catch (error) {
      this.lastHealthy = false;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    process.once('exit', this.onCoreExit);
    this.logs.sys('动画工作台已挂载；未自动启动服务，也未自动下载工程');
  }

  /** 优先使用本实例的进程句柄，否则按归属记录认领上一次 Core 遗留的服务。 */
  async adoptIfOwned() {
    if (this.owned) return this.owned;
    const claimed = await claimOwned(resolveRoot(this.cfg), { port: this.port, origin: this.origin });
    if (claimed) {
      this.owned = claimed;
      this.mode = 'running';
      this.ownedSource = 'adopted';
      this.logs.sys(`已接管上一次 Core 启动的服务（pid ${claimed.pid}），现可终止`);
    } else {
      this.mode = 'external';
    }
    return claimed;
  }

  async stop() {
    if (this.owned) {
      const pid = this.owned.pid;
      this.hooks.killTree(this.owned);
      clearOwner(resolveRoot(this.cfg), pid);
      this.logs.sys(`已终止本扩展管理的服务（pid ${pid ?? '?'}）`);
      this.owned = null;
    }
    process.removeListener('exit', this.onCoreExit);
    this.mode = 'stopped';
    this.lastHealthy = false;
    this.ownedSource = null;
  }

  tools() { return createTools(this); }

  /** 每次前缀重建时调用：仅拼接字符串，不发起网络请求、不读取大文件。 */
  envPromptVars() {
    let status;
    try { status = projectStatus(this.cfg); } catch { status = { root: resolveRoot(this.cfg), valid: false }; }
    const serviceState = !this.lastHealthy
      ? '状态未确认（请先执行 studio_service({action:"status"}) 查询）'
      : `${this.mode === 'external' ? '外部服务' : '由本扩展启动的服务'}在线`;
    return {
      'rsm.service': `服务：${serviceState}；端点 ${this.endpoint}；端口 ${this.port}。`,
      'rsm.project': status.valid
        ? `工程：${status.root}；版本 ${status.version ?? '未知'}；依赖${status.deps ? '已安装' : '未安装'}。`
        : `工程：${status.root} 尚未安装。用户提出动画创作需求时，先调用 studio_project({action:"install"}) 取得预检，经用户确认后再带 confirm:true 执行下载与依赖安装。`,
      'rsm.bridge': '四个门面工具按序使用：studio_start_guide 获取流程 → studio_get_guide 读取指南 → studio_tool_search 检索工具 → studio_tool_call 执行。其余工具不直接暴露，一律经 studio_tool_call 调用。',
      'rsm.config': `端口 ${this.port}；下载源 ${this.registry}；启动前自动构建：${this.cfg.autoBuild ? '启用' : '关闭'}；工具调用自动启动服务：${this.cfg.autoStart ? '启用' : '关闭'}。`,
    };
  }

  webUi(language = 'zh') {
    const t = WEB_TEXT[language === 'zh' ? 'zh' : 'en'];
    const on = this.cfg.enabled !== false;
    let status;
    try { status = projectStatus(this.cfg); } catch { status = { valid: false, root: resolveRoot(this.cfg) }; }
    const serviceState = !on ? 'offline' : this.lastError ? 'error'
      : this.lastHealthy ? 'online' : 'offline';
    return {
      label: t.label,
      lamps: [
        {
          label: t.lampService,
          state: serviceState,
          hint: !on ? t.off : this.lastError || (this.lastHealthy ? `${t.online} · ${this.endpoint}` : `${t.offline} · ${this.port}`),
        },
        {
          label: t.lampProject,
          state: status.valid ? (status.deps ? 'online' : 'loading') : 'offline',
          hint: status.valid
            ? `${status.root} · ${status.version ?? '版本未知'} · 依赖${status.deps ? '已安装' : '未安装'}`
            : `工程未安装：${status.root}`,
        },
        {
          label: t.lampBridge,
          state: this.lastHealthy ? 'online' : 'offline',
          hint: this.lastHealthy ? '四个门面工具可用' : '服务未就绪，门面工具暂不可用',
        },
      ],
      links: [{ label: t.openEditor, href: `http://127.0.0.1:${this.port}/` }],
      /**
       * 自定义控制台面板。框架会另行渲染「配置」页签（读取下方的 config 组），
       * 但配置页签仅提供表单；工程安装、服务启停与日志查看须由用户直接操作，无需经由模型调用工具。
       */
      panels: [{ id: 'control', title: t.panelTitle, description: t.panelDesc }],
      invoke: (panel, method, args) => this.panelInvoke(panel, method, args),
      config: configGroups(language),
      promptDocs: [{
        key: `worlds.${RSM_ID}.env`,
        title: t.promptTitle,
        description: t.promptDesc,
        path: ENV_PROMPT_PATH,
        role: 'envPrompt',
        vars: [
          { name: 'rsm.service', description: '本机服务状态与地址' },
          { name: 'rsm.project', description: '工程目录、版本、依赖是否齐全' },
          { name: 'rsm.bridge', description: '4 个门面工具的使用顺序' },
          { name: 'rsm.config', description: '端口、下载源、自动构建与自动启动开关' },
        ],
      }],
    };
  }

  /** 控制台面板的数据面：全部复用工具的实现，不在面板里写第二套服务/工程逻辑。 */
  async panelInvoke(panel, method, requestArgs) {
    if (panel !== 'control') throw new Error(`未知面板：${panel}`);
    const args = Array.isArray(requestArgs) ? requestArgs : [];
    const ctx = { signal: undefined };
    const extra = (v) => (isPlainObject(v) ? v : {});
    switch (method) {
      case 'state': return this.panelState();
      case 'config': return { ...this.cfg };
      // 面板要的是结构化版本信息（local / latest / hasNewer），不是工具那段拼好的文本
      case 'checkUpdates': return checkUpdates({ cfg: this.cfg, registry: args[0]?.registry });
      case 'saveConfig': return this.panelSaveConfig(args[0]);
      // 统一包成对象：面板 RPC 走 JSON，返回裸字符串会被当成文本响应处理
      case 'service': return { text: await this.serviceAction({ action: String(args[0] ?? ''), ...extra(args[1]) }, ctx) };
      case 'project': return { text: await this.projectAction({ action: String(args[0] ?? ''), ...extra(args[1]) }, ctx) };
      case 'logs': return this.logs.since(Number(args[0]) || 0, {
        limit: Number(args[1]) || 80, stream: args[2],
      });
      default: throw new Error(`未知面板方法：${method}`);
    }
  }

  async panelState() {
    let healthy = false;
    try { healthy = await this.hooks.probeHealth(this.origin, 1200); } catch { healthy = false; }
    this.lastHealthy = healthy;
    if (healthy && !this.owned) await this.adoptIfOwned();
    let status;
    try {
      status = projectStatus(this.cfg);
    } catch {
      status = {
        root: resolveRoot(this.cfg), valid: false, deps: false, version: null,
        registry: this.registry, package: this.cfg.projectPackage,
      };
    }
    return {
      online: healthy,
      mode: this.mode,
      ownedSource: this.ownedSource ?? null,
      endpoint: this.endpoint,
      port: this.port,
      editor: `http://127.0.0.1:${this.port}/`,
      root: status.root,
      valid: status.valid,
      version: status.version,
      deps: status.deps,
      registry: status.registry,
      packageName: status.package,
      enabled: this.cfg.enabled !== false,
      autoBuild: this.cfg.autoBuild !== false,
      building: this.mode === 'building',
      envOverride: Boolean(process.env.REMOTION_STUDIO_ROOT),
    };
  }

  /** 面板保存配置：白名单 + 校验后走 WorldContext.persist（活引用与 config.json 同步）。 */
  panelSaveConfig(patch) {
    if (!isPlainObject(patch)) throw new Error('saveConfig 需要一个配置对象');
    const allowed = ['port', 'registry', 'projectPackage', 'installDir', 'autoBuild', 'autoStart', 'timeoutMs', 'endpoint'];
    const clean = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
    }
    if (!Object.keys(clean).length) throw new Error('没有可保存的字段');
    if (clean.port !== undefined) {
      const port = Number(clean.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口必须是 1–65535 的整数：${clean.port}`);
      clean.port = port;
    }
    if (clean.timeoutMs !== undefined) {
      const ms = Number(clean.timeoutMs);
      if (!Number.isInteger(ms) || ms < 5000 || ms > 900000) throw new Error('超时必须在 5000–900000 毫秒之间');
      clean.timeoutMs = ms;
    }
    for (const key of ['registry', 'endpoint']) {
      if (clean[key] === undefined) continue;
      if (typeof clean[key] !== 'string') throw new Error(`${key} 必须是字符串`);
      clean[key] = clean[key].trim();
      if (clean[key] && !/^https?:\/\//i.test(clean[key])) throw new Error(`${key} 必须是 http(s) 地址`);
    }
    if (clean.endpoint) assertLoopback(clean.endpoint);
    if (clean.installDir !== undefined && typeof clean.installDir !== 'string') throw new Error('installDir 必须是字符串');
    if (clean.projectPackage !== undefined && typeof clean.projectPackage !== 'string') throw new Error('projectPackage 必须是字符串');
    if (clean.autoBuild !== undefined) clean.autoBuild = Boolean(clean.autoBuild);
    if (clean.autoStart !== undefined) clean.autoStart = Boolean(clean.autoStart);
    this.ctx.persist(clean);
    this.logs.sys(`配置已更新：${Object.keys(clean).join('、')}`);
    return { ok: true, saved: Object.keys(clean), port: this.port, endpoint: this.endpoint };
  }

  /**
   * 所有启动路径的唯一入口。`studio_service({action:'start'})` 与门面工具的 ensureService()
   * 都经过这里 —— 否则「自动构建」只覆盖手动启动，而模型平时调工具走的是自动拉起，
   * 结果服务起来了、前端却是坏的（prebuild 生成的插件入口不随 npm 包分发）。
   *
   * 顺序与 launcher 的 startService 一致：探活 → 端口检查 → 构建（失败不启动）→ startServer。
   * 外部服务已在跑时直接复用：不能在它正读 dist/web 的时候重写这个目录。
   * 并发调用合并为一次：两个 vite build 同时写 dist/web 会互相破坏。
   */
  launch(ctx, buildOverride, opts = {}) {
    if (this.starting) return this.starting;
    const origin = this.origin;
    let task;
    task = (async () => {
      if (await this.hooks.probeHealth(origin, 1200)) {
        this.lastHealthy = true;
        this.lastError = null;
        // 端口上可能正是上一次 Core 遗留的服务：先尝试认领，不得一律判定为外部服务
        if (!this.owned) await this.adoptIfOwned();
        return { mode: this.mode, reused: true, built: false };
      }
      if (opts.requireAutoStart && this.cfg.autoStart === false) {
        const msg = `服务未启动（${origin}），配置项 autoStart 已关闭。请执行 studio_service({action:"start"})，或在工程目录手动运行 pnpm dev:server。`;
        this.lastError = msg;
        throw new Error(msg);
      }
      const doBuild = buildOverride !== undefined
        ? Boolean(buildOverride)
        : this.cfg.autoBuild !== false;
      return this.doLaunch(ctx, doBuild, origin);
    })().finally(() => { if (this.starting === task) this.starting = null; });
    this.starting = task;
    return task;
  }

  /** 执行一次启动流程。构建与启动分离，构建失败时不得进入 startServer。 */
  async doLaunch(ctx, doBuild, origin) {
    if (!(await this.hooks.isPortFree(this.port))) {
      const msg = `端口 ${this.port} 已被其他程序占用，启动流程终止，未执行构建。请在配置中更换端口后重试。`;
      this.lastError = msg;
      throw new Error(msg);
    }
    const root = resolveRoot(this.cfg);
    if (!projectStatus(this.cfg).valid) {
      const msg = `工程目录 ${root} 不是有效的 Remotion Studio 工程。请先执行 studio_project({action:"install"}) 下载工程并安装依赖，或使用 action=use 指向本地已有的工程目录。`;
      this.lastError = msg;
      throw new Error(msg);
    }
    if (doBuild) {
      this.mode = 'building';
      this.logs.sys('启动前自动构建：将依次执行 prebuild 与 build，构建成功后启动服务（可能耗时数分钟）');
      const built = await this.hooks.runBuild(root, {
        onLog: this.onLog,
        signal: ctx?.signal,
        // vite build 耗时显著高于单次 MCP 调用，单独提供更宽的上限，避免被 timeoutMs 截断
        timeoutMs: Math.max(this.timeoutMs, 300000),
      });
      if (!built.ok) {
        const msg = `${built.error}。可通过 studio_service({action:"logs",stream:"build"}) 查看构建日志。`;
        this.lastError = msg;
        this.mode = 'stopped';
        this.logs.sys('构建失败，启动流程已终止');
        throw new Error(msg);
      }
      this.logs.sys('构建成功，开始启动服务');
    }
    this.mode = 'starting';
    const result = await this.hooks.startServer({
      root,
      port: this.port,
      origin,
      onLog: this.onLog,
      signal: ctx?.signal,
      waitMs: Math.max(30000, Math.min(this.timeoutMs, 120000)),
    });
    this.lastHealthy = true;
    this.lastError = null;
    if (result.mode === 'owned') {
      this.owned = result.proc;
      this.mode = 'running';
      this.ownedSource = 'this-core';
      // startServer 内部也会写一份；这里兜住 hooks.startServer 被替换的场景
      writeOwner(root, { pid: result.proc?.pid, port: this.port, corePid: process.pid });
    } else {
      this.mode = 'external';
      this.ownedSource = null;
    }
    return { mode: this.mode, reused: false, built: doBuild };
  }

  /** 工具调用前确保服务可用；默认 autoStart=false 时仅返回手动启动指引，不在后台启动服务。 */
  ensureService(ctx) {
    return this.launch(ctx, undefined, { requireAutoStart: true });
  }

  /** 四个门面工具的统一出口。isError 由 mcp-client 映射为 failed 回执。 */
  async callFacade(name, args, ctx) {
    await this.ensureService(ctx);
    return callTool(this.endpoint, name, args, {
      signal: ctx?.signal,
      timeoutMs: this.timeoutMs,
    });
  }

  statusText(healthy) {
    const status = projectStatus(this.cfg);
    return [
      `服务：${healthy ? '在线' : '未启动'}（端点 ${this.endpoint}；端口 ${this.port}）`,
      `来源：${this.mode === 'external' ? '外部服务（本扩展不会终止）' : this.mode === 'running' ? '本扩展启动' : '无'}`,
      `工程目录：${status.root}`,
      `工程有效：${status.valid ? '是' : '否'}`,
      `工程版本：${status.version ?? '未知'}`,
      `依赖状态：${status.deps ? '已安装' : '未安装（请执行 studio_project({action:"install"})）'}`,
      `下载源：${status.registry}`,
      status.fromEnv ? '提示：REMOTION_STUDIO_ROOT 环境变量优先于配置项 installDir。' : '',
      this.lastError ? `最近一次错误：${this.lastError}` : '',
    ].filter(Boolean).join('\n');
  }

  async serviceAction(args, ctx) {
    const action = String(args.action ?? '').toLowerCase();
    const log = this.onLog;
    switch (action) {
      case 'status': {
        const healthy = await this.hooks.probeHealth(this.origin, 1500);
        this.lastHealthy = healthy;
        if (healthy && !this.owned) this.mode = 'external';
        return this.statusText(healthy);
      }
      case 'start': {
        const result = await this.launch(ctx, args.build);
        if (result.reused) {
          log('sys', `端口 ${this.port} 上已有服务，未重复启动；该服务正在读取构建产物，故不重写 dist 目录`);
          return `服务已在运行（外部服务，本扩展不会终止）：${this.endpoint}\n${this.statusText(true)}`;
        }
        return [
          `服务已就绪：${this.endpoint}${result.built ? '（启动前已完成 prebuild + build）' : '（本次跳过构建）'}`,
          this.statusText(true),
        ].join('\n');
      }
      case 'stop': {
        const owned = await this.adoptIfOwned();
        if (!owned) {
          return '当前没有可停止的服务。端口上由用户或其他程序启动的外部服务不受本扩展管理，请在其启动位置执行停止操作。';
        }
        const pid = owned.pid;
        this.hooks.killTree(owned);
        clearOwner(resolveRoot(this.cfg), pid);
        this.owned = null;
        this.ownedSource = null;
        this.mode = 'stopped';
        this.lastHealthy = false;
        log('sys', `服务已终止（pid ${pid ?? '?'}）`);
        return `服务已终止（pid ${pid ?? '?'}）。${owned.adopted ? '该服务由上一次 Core 启动，本实例已接管。' : ''}外部服务不受影响。`;
      }
      case 'logs': {
        const { entries, lastSeq } = this.logs.since(Number(args.since) || 0, {
          limit: Number(args.limit) || 80,
          stream: args.stream,
        });
        if (!entries.length) return `暂无新增日志（当前序号 ${lastSeq}）。`;
        const body = entries.map((e) => `#${e.seq} [${e.stream}] ${e.text}`).join('\n');
        return `${body}\n\n最后序号：${lastSeq}；下次可传入 since:${lastSeq} 仅获取增量。`;
      }
      case 'open': {
        const url = `http://127.0.0.1:${this.port}/`;
        const opened = openBrowser(url);
        return `编辑器地址：${url}${opened ? '（已请求打开浏览器）' : '（未能自动打开，请手动访问该地址）'}`;
      }
      default:
        throw new Error(`未知操作「${args.action}」。可用取值：status / start / stop / logs / open。`);
    }
  }

  /**
   * 安装与更新的失败必须写入日志流：面板仅轮询日志，若错误只出现在回执中，
   * 界面将停留在「下载」阶段，用户无法区分操作失败与仍在执行。完整错误仍由回执原样抛出。
   */
  async runProjectTask(action, task) {
    try {
      return await task();
    } catch (error) {
      this.onLog('install', `[失败] ${action}：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * 写入类动作（install / update）的确认闸口：未携带 confirm:true 时只做只读预检，不写任何文件。
   * 安装类操作会下载、合并并安装依赖，属于不可撤销的落盘动作，不能由模型凭一次调用直接触发；
   * 控制台面板自带确认对话框，走 panelInvoke → projectAction，不受此处限制。
   */
  projectPrecheck(action, args) {
    const status = projectStatus(this.cfg);
    const wantedDir = typeof args.dir === 'string' ? args.dir.trim() : '';
    const dir = action === 'install' && wantedDir ? wantedDir : status.root;
    const exists = existsSync(dir);
    const local = dir === status.root
      ? (status.valid ? `已安装 ${status.version ?? '版本未知'}，依赖${status.deps ? '已安装' : '未安装'}` : '未安装')
      : (exists ? '目标目录已存在，将按合并规则写入' : '目标目录不存在，将新建');
    const lines = [
      `需要用户确认，未执行任何写入（当前状态：${local}）。`,
      '',
      `动作：${action}`,
      `目标目录：${dir}`,
      `工程包名：${status.package}（下载源 ${args.registry ? String(args.registry) : status.registry}）`,
      `目标版本：${typeof args.version === 'string' && args.version.trim() ? args.version.trim() : 'latest'}`,
    ];
    if (action === 'install') {
      lines.push('影响：下载工程包、按合并规则落地、安装依赖并做运行时自检；已有工程数据与用户自建插件保留。');
      lines.push('耗时：通常数分钟，期间可用 studio_service({action:"logs",stream:"install"}) 查看进度。');
    } else {
      lines.push('影响：覆盖 server/、src/、web/、shared/、scripts/ 等工程源码；保留 data/、public/、out/、node_modules/、dist/、memory/ 与用户自建插件。');
      lines.push('完成后须重启服务方能生效。');
    }
    lines.push('');
    lines.push(`先向用户说明以上内容并取得同意，再调用 studio_project({action:"${action}",confirm:true})。`);
    return lines.join('\n');
  }

  async projectAction(args, ctx) {
    const action = String(args.action ?? '').toLowerCase();
    const common = { cfg: this.cfg, onLog: this.onLog, signal: ctx?.signal };
    const persist = (patch) => this.ctx.persist(patch);
    switch (action) {
      case 'status': {
        const s = projectStatus(this.cfg);
        return [
          `工程目录：${s.root}`,
          `工程有效：${s.valid ? '是' : '否'}${s.valid ? '' : '；请执行 studio_project({action:"install"}) 下载工程并安装依赖'}`,
          `工程版本：${s.version ?? '未知'}`,
          `依赖状态：${s.deps ? '已安装' : '未安装'}`,
          `工程包名：${s.package}`,
          `下载源：${s.registry}`,
          s.fromEnv ? '提示：REMOTION_STUDIO_ROOT 环境变量优先于配置项 installDir。' : '',
        ].filter(Boolean).join('\n');
      }
      case 'install':
        return this.runProjectTask('install', () => installProject({
          ...common, dir: args.dir, registry: args.registry, version: args.version, persist,
        }));
      case 'use':
        if (!args.dir) throw new Error('action=use 须提供 dir 参数：本地已有工程目录的绝对路径。');
        return useProject({ cfg: this.cfg, dir: args.dir, persist });
      case 'update':
        return this.runProjectTask('update', () => updateProject({
          ...common, registry: args.registry, version: args.version,
        }));
      case 'check': {
        const result = await checkUpdates({ cfg: this.cfg, registry: args.registry, signal: ctx?.signal });
        return [
          `工程包名：${result.package}`,
          `本地版本：${result.local ?? '未安装'}（${result.root}）`,
          `最新版本：${result.latest}（下载源：${result.registry}）`,
          result.hasNewer
            ? '检测到新版本。请执行 studio_project({action:"update"}) 原地更新，更新完成后须重启服务。'
            : result.local ? '当前已是最新版本。' : '工程尚未安装，请执行 studio_project({action:"install"})。',
        ].join('\n');
      }
      case 'changelog': {
        const result = await readChangelog({
          cfg: this.cfg, version: args.version, cacheDir: this.dataDir, signal: ctx?.signal,
        });
        return `【${this.cfg.projectPackage} ${result.version} 变更说明】\n来源：${result.source}\n\n${result.text}`;
      }
      default:
        throw new Error(`未知操作「${args.action}」。可用取值：status / install / use / update / check / changelog。`);
    }
  }
}
