/**
 * 配置段 `worlds.rsm`。
 *
 * 两条硬约束（来自 Cortico 的 dry-mount.ts，违反将判定扩展不合格）：
 *   1. configGroups() 中每个 property 的键必须为 `worlds.rsm.<字段>`；
 *   2. 每个字段都必须在 defaults() 中有对应默认值，否则会出现「界面可修改、代码却读取另一兜底值」。
 * 新增配置项时，RSM_DEFAULTS 与 configGroups() 必须同步修改；scripts/smoke.mjs 会断言该约束。
 *
 * 文案约定：书面产品语体；统一使用「本扩展 / 服务 / 工程 / 依赖 / 构建 / 下载源 / 端点」等术语；
 * 中英文案同步维护；不向用户暴露内部字段名，不使用口语化括号补充。
 *
 * 零依赖：本文件仅使用 Node 内置模块，扩展入口为 .mjs，不依赖宿主是否提供 tsx。
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const RSM_ID = 'rsm';
export const DEFAULT_PORT = 4380;
export const DEFAULT_REGISTRY = 'https://registry.npmmirror.com';
export const DEFAULT_PROJECT_PACKAGE = 'remotion-studio-mcp';

/** 工程默认落在用户目录，不写入任何开发机绝对路径；REMOTION_STUDIO_ROOT 可整体覆盖。 */
export function defaultInstallDir() {
  return join(homedir(), '.coopanion', 'remotion-studio');
}

export const RSM_DEFAULTS = Object.freeze({
  /** 新装 World 一律默认关闭；由部署的 declares 或 World 页开关决定，见 cortico/world.ts:88。 */
  enabled: false,
  /** 空串表示使用 defaultInstallDir()。 */
  installDir: '',
  port: DEFAULT_PORT,
  registry: DEFAULT_REGISTRY,
  projectPackage: DEFAULT_PROJECT_PACKAGE,
  /**
   * 启动前自动构建，默认启用（与 dsh-remotion-launcher 的 autoBuild=true 一致）。
   * 工程的 prebuild 生成 `src/_plugins.generated.ts`，该文件属构建产物、不随 npm 包分发；
   * 跳过构建即启动服务会导致编辑器页面资源缺失。首次安装、版本更新或修改插件源码后，
   * dist/web 必须重建。关闭方式：配置页关闭本项，或单次调用时传入 build:false。
   */
  autoBuild: true,
  /**
   * 默认关闭：不在用户未操作时于后台启动服务。
   * 历史问题：Core「重启恢复」触发模型工具调用，进而由 ensureService() 自动拉起服务；
   * 子进程以 detached 方式运行，Core 退出后服务成为孤儿进程，用户只见「在线」却无从得知来源。
   * 关闭后门面工具仅返回明确的手动启动指引；确需模型自助时由用户在配置页显式启用。
   * 无论开关状态如何，World 挂载（start()）均不启动服务。
   */
  autoStart: false,
  /** 单次 MCP 调用、构建或安装操作的超时上限（毫秒）。渲染类调用耗时较长，相关工具标记为可中断。 */
  timeoutMs: 120000,
  /** 空串表示由 port 推导 http://127.0.0.1:<port>/mcp；仅接受本机回环地址。 */
  endpoint: '',
});

export function portOf(cfg) {
  const raw = Number(cfg?.port ?? DEFAULT_PORT);
  return Number.isInteger(raw) && raw >= 1 && raw <= 65535 ? raw : DEFAULT_PORT;
}

/**
 * 实际生效端口：4380 仅为默认值，并非常量。
 * 优先级：自定义端点中注明的端口 > 配置中的 port > DEFAULT_PORT。
 * 服务监听、健康检查、编辑器地址与 MCP 端点统一使用该值，避免监听与连接使用不同端口。
 */
export function effectivePort(cfg) {
  const raw = (cfg?.endpoint ?? '').trim();
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.port) return Number(url.port);
      return url.protocol === 'https:' ? 443 : 80;
    } catch {
      return portOf(cfg); // 非法 URL 交由 assertLoopback 返回更明确的错误
    }
  }
  return portOf(cfg);
}

/** 工程根目录：环境变量 > 配置项 > 用户目录默认值。 */
export function resolveRoot(cfg) {
  const fromEnv = (process.env.REMOTION_STUDIO_ROOT ?? '').trim();
  if (fromEnv) return resolve(fromEnv);
  const fromCfg = (cfg?.installDir ?? '').trim();
  return fromCfg ? resolve(fromCfg) : defaultInstallDir();
}

export function resolveEndpoint(cfg) {
  const raw = (cfg?.endpoint ?? '').trim();
  return raw ? raw.replace(/\/+$/, '') : `http://127.0.0.1:${portOf(cfg)}/mcp`;
}

const TEXT = {
  zh: {
    groupService: '服务',
    groupServiceDesc: '本机 Remotion Studio 服务的端口与启动行为。修改后立即生效，下一次工具调用即读取新值。',
    groupProject: '工程',
    groupProjectDesc: '配置工程目录、npm 下载源与工程包名。工程目录可指向本地已有的工程副本。',
    groupAdvanced: '高级',
    groupAdvancedDesc: '配置调用超时与自定义 MCP 端点。端点仅允许本机回环地址，以避免请求发往外部主机。',
    port: '服务端口',
    portHint: '默认 4380，可指定任意空闲端口。服务监听、健康检查、编辑器地址与 MCP 端点将同步更新。端口被占用时立即终止启动流程，不执行构建。',
    autoStart: '工具调用时自动启动服务',
    autoStartHint: '默认关闭。工具调用不会在后台启动服务；服务未运行时返回明确的手动启动指引。如需自动启动，请显式启用本项。修改后立即生效。',
    autoBuild: '启动前自动构建前端',
    autoBuildHint: '默认启用。工程的 prebuild 会生成未随 npm 包分发的插件入口，跳过构建将导致编辑器页面资源缺失；构建失败时中止启动。首次安装、更新工程或修改插件源码后必须构建。仅重启服务且源码未变更时，可通过 build:false 跳过当次构建。端口上已有外部服务时，不会重写其正在读取的构建产物。',
    installDir: '工程目录',
    installDirHint: '留空时使用默认路径 ~/.coopanion/remotion-studio；亦可指定本地已有的工程目录。',
    registry: 'npm 下载源',
    registryHint: '工程下载、依赖安装、版本检查与变更说明读取均仅使用该下载源。',
    projectPackage: '工程包名',
    projectPackageHint: 'npm 上的工程包名，默认为 remotion-studio-mcp。',
    timeoutMs: '调用超时',
    timeoutMsHint: '单次 MCP 调用、构建或安装操作的超时上限（毫秒）。',
    endpoint: 'MCP 端点',
    endpointHint: '留空时由服务端口推导。指定自定义地址后，服务端口以该地址中的端口为准。仅接受 127.0.0.1 / localhost / ::1。',
  },
  en: {
    groupService: 'Service',
    groupServiceDesc: 'Port and launch behaviour of the local Remotion Studio service. Changes take effect on the next tool call.',
    groupProject: 'Project',
    groupProjectDesc: 'Project directory, npm registry and package name. The directory may point to an existing local copy.',
    groupAdvanced: 'Advanced',
    groupAdvancedDesc: 'Call timeout and custom MCP endpoint. Loopback addresses only, to prevent requests leaving the local machine.',
    port: 'Service port',
    portHint: 'Default 4380; any free port is valid. Service binding, health checks, editor address and MCP endpoint all follow this value. A busy port aborts startup before any build runs.',
    autoStart: 'Auto-start service on tool calls',
    autoStartHint: 'Off by default. Tool calls never start the service in the background; when it is not running, tools return a clear manual-start instruction. Enable explicitly if automatic startup is required. Changes take effect immediately.',
    autoBuild: 'Build frontend before start',
    autoBuildHint: 'On by default. The project prebuild generates a plugin entry that is not shipped in the npm tarball; skipping the build leaves the editor unusable. A failed build aborts startup. A build is required after a first install, a version update or a plugin source change. Use build:false only when restarting with unchanged sources. An already-running external service is never rebuilt.',
    installDir: 'Project directory',
    installDirHint: 'Leave empty to use the default path ~/.coopanion/remotion-studio, or specify an existing local project directory.',
    registry: 'npm registry',
    registryHint: 'The only source used for project downloads, dependency installation, version checks and changelog retrieval.',
    projectPackage: 'Project package',
    projectPackageHint: 'npm package name of the project; defaults to remotion-studio-mcp.',
    timeoutMs: 'Call timeout',
    timeoutMsHint: 'Upper bound in milliseconds for one MCP call, build or install operation.',
    endpoint: 'MCP endpoint',
    endpointHint: 'Leave empty to derive from the service port. A custom address also determines the port. Only 127.0.0.1, localhost and ::1 are accepted.',
  },
};

/** WebUI 配置组。owner 必须为 `world:<id>`，键必须为 `worlds.<id>.<字段>`。 */
export function configGroups(language = 'zh') {
  const t = TEXT[language === 'zh' ? 'zh' : 'en'];
  const at = (key) => `worlds.${RSM_ID}.${key}`;
  const owner = `world:${RSM_ID}`;
  return [
    {
      id: `${owner}.service`,
      owner,
      schema: {
        type: 'object',
        title: t.groupService,
        description: t.groupServiceDesc,
        properties: {
          [at('port')]: { type: 'integer', title: t.port, description: t.portHint, minimum: 1, maximum: 65535 },
          [at('autoStart')]: { type: 'boolean', title: t.autoStart, description: t.autoStartHint },
          [at('autoBuild')]: { type: 'boolean', title: t.autoBuild, description: t.autoBuildHint },
        },
      },
    },
    {
      id: `${owner}.project`,
      owner,
      schema: {
        type: 'object',
        title: t.groupProject,
        description: t.groupProjectDesc,
        properties: {
          [at('installDir')]: {
            type: 'string', title: t.installDir, description: t.installDirHint,
            'x-path': { kind: 'directory' },
          },
          [at('registry')]: { type: 'string', title: t.registry, description: t.registryHint },
          [at('projectPackage')]: { type: 'string', title: t.projectPackage, description: t.projectPackageHint },
        },
      },
    },
    {
      id: `${owner}.advanced`,
      owner,
      schema: {
        type: 'object',
        title: t.groupAdvanced,
        description: t.groupAdvancedDesc,
        properties: {
          [at('timeoutMs')]: {
            type: 'integer', title: t.timeoutMs, description: t.timeoutMsHint,
            minimum: 5000, maximum: 900000, 'x-suffix': 'ms',
          },
          [at('endpoint')]: { type: 'string', title: t.endpoint, description: t.endpointHint, 'x-warning': true },
        },
      },
    },
  ];
}
