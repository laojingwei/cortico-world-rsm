/**
 * 6 个工具的单一数据源：TOOL_DECLS 同时供 tools() 与 WorldDefinition.describe / describe.json 使用。
 *
 * 仅将 4 个门面工具挂载至 Coopanion，不把 remotion-studio-mcp 的 132 个工具全量注入对话上下文；
 * 桌宠每轮前缀的成本显著高于编程 agent，门面模式「先 start_guide → 再 tool_search → 最后 tool_call」
 * 使能力按需加载。
 *
 * 工具名一律带 `studio_` 前缀（Cortico 约定 `<短名>_<动词>`，且要求全局唯一）。
 * 长调用全部标记为可中断：渲染、构建、安装依赖可能耗时数分钟，宿主中断时 ctx.signal 会触发。
 *
 * 文案约定：书面产品语体，统一术语，中英一致；不向用户暴露实现细节或口语化表达。
 */
export const TOOL_DECLS = [
  {
    name: 'studio_service',
    description:
      '管理本机 Remotion Studio 服务。action 为必填项：' +
      'status 查询服务状态（端口、运行状态、工程路径、进程归属）；' +
      'start 启动服务（默认先执行 prebuild 与 build，构建失败则中止启动；仅在源码未变更的快速重启场景使用 build:false 跳过构建）；' +
      'stop 停止服务，仅终止由本扩展启动或已接管的进程，外部服务不受影响；' +
      'logs 按来源读取运行日志（支持 since / limit / stream）；' +
      'open 打开编辑器页面并返回访问地址。' +
      '服务未就绪时，须先调用 status 确认状态；MCP 工具返回连接错误时，使用 start 启动服务。' +
      '服务端口取自当前配置，并非固定 4380；回执中的端口须引用 status 返回的当前值。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string', enum: ['status', 'start', 'stop', 'logs', 'open'],
          description: '待执行的操作名称。',
        },
        build: {
          type: 'boolean',
          description: '仅 action=start 有效。缺省时按配置 autoBuild（默认启用）先执行构建；false 表示本次跳过，仅适用于源码未变更的快速重启。首次安装、更新工程或修改插件源码后不得跳过。',
        },
        since: { type: 'integer', description: '仅 action=logs：仅返回序号大于 since 的日志条目。' },
        limit: { type: 'integer', description: '仅 action=logs：返回条目数上限，默认 80，最大 300。' },
        stream: {
          type: 'string', enum: ['server', 'build', 'install', 'sys'],
          description: '仅 action=logs：按日志来源过滤。',
        },
      },
      required: ['action'],
    },
    tags: ['act', 'snapshot'],
    summary: '启动与停止服务、查询状态、读取日志、打开编辑器。',
  },
  {
    name: 'studio_project',
    description:
      '管理 Remotion Studio 工程。action 为必填项：' +
      'status 查询工程目录、版本与依赖完整性；' +
      'install 从 npm 下载工程并安装依赖（首次使用时必须执行，用户环境中不包含工程源码）；' +
      'use 指向本地已有的工程目录（仅校验并更新配置，不下载、不覆盖）；' +
      'update 原地更新至指定版本（保留 data/、node_modules/、dist/ 及用户自行安装的插件）；' +
      'check 只读对比本地版本与下载源的最新版本；' +
      'changelog 读取指定版本的变更说明（本地缺失时从 registry tarball 获取）。' +
      'install 与 update 属写入操作，必须携带 confirm:true；未携带时只返回预检信息（目标目录、目标版本、影响范围与耗时），不写入任何文件。' +
      '正确顺序为：先不带 confirm 调用取得预检，向用户说明并取得同意，再带 confirm:true 执行。更新完成后须重启服务方能生效。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string', enum: ['status', 'install', 'use', 'update', 'check', 'changelog'],
          description: '待执行的操作名称。',
        },
        dir: {
          type: 'string',
          description: 'install 的目标目录，或 use 要指向的已有工程目录（绝对路径）。留空时使用配置项 installDir。',
        },
        registry: {
          type: 'string',
          description: '本次操作临时使用的 npm 下载源；留空时使用配置项 registry。',
        },
        version: {
          type: 'string',
          description: 'install / update 指定目标版本（默认 latest）；changelog 指定要读取的版本（默认当前版本）。',
        },
        confirm: {
          type: 'boolean',
          description: 'install / update 必填。true 表示用户已确认执行本次写入；缺省或 false 时只返回预检信息，不执行任何写入。',
        },
      },
      required: ['action'],
    },
    tags: ['act', 'snapshot'],
    summary: '下载、更新与切换工程，查询版本与变更说明。',
  },
  {
    name: 'studio_start_guide',
    description:
      '动画创作任务的流程入口：返回完整创作流程（接单 → brief → 风格 → 分镜 → 搭建 → 配音 → 自检 → 渲染 → 沉淀）、' +
      '当前工程进度、建议阅读的技能指南与下一步动作。每次新任务须首先调用本工具一次，不得跳过流程环节。' +
      '本工具对应 remotion-studio-mcp 的 start_guide 门面，调用前须确保服务已启动。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', description: '提供该项目 ID 时，将一并判断该工程的创作进度。' },
      },
    },
    tags: ['read'],
    summary: '读取创作流程与当前进度，确定下一步动作。',
  },
  {
    name: 'studio_get_guide',
    description:
      '按需读取 Remotion Studio 技能指南，以节省上下文。name 须为项目 18 篇指南之一，' +
      '例如 manual（工具全表与意图速查）、director（整片流程）、script、content、subtitle、' +
      'formats、sound、narration、freeform、scene3d、external-tools、qa、delivery、craft、memory 等；' +
      '参数无效时将返回可用名称列表。section 按标题关键字仅读取其中一节（例如 "scene3d" 与 "注意事项"）。' +
      '如需完整清单，请调用 studio_tool_call({name:"list_guides"})。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '技能指南名称，例如 manual / director / scene3d / freeform / qa。' },
        section: { type: 'string', description: '仅读取某一小节（按标题关键字匹配）。' },
      },
      required: ['name'],
    },
    tags: ['read'],
    summary: '按需读取一篇技能指南，可仅取其中一节。',
  },
  {
    name: 'studio_tool_search',
    description:
      '按意图检索 Remotion Studio 的全部工具（常驻仅暴露 4 个门面工具，其余 100 余个工具均通过本工具检索）。' +
      '返回工具名称、完整说明与参数定义；确定目标后使用 studio_tool_call 执行。' +
      'all:true 返回完整工具目录（名称与参数个数），随后可用 names:[...] 一次获取多个工具的完整参数定义。' +
      '关键词支持中文意图描述，例如「字幕」「配音」「3D」「画中画」。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '意图关键词。' },
        all: { type: 'boolean', description: 'true 表示返回完整工具目录（不含参数定义）。' },
        names: { type: 'array', items: { type: 'string' }, description: '按名称精确获取指定工具的完整文档。' },
      },
    },
    tags: ['read'],
    summary: '按意图检索工具并获取完整参数定义。',
  },
  {
    name: 'studio_tool_call',
    description:
      '执行 Remotion Studio 的任意工具（配合 studio_tool_search 使用）。' +
      '参数须封装在 args 中，例如 {name:"preview_frame",args:{projectId:"p_x",frame:30}}。' +
      '工具名称与参数字段以 tool_search 返回的文档为准；执行错误将附带字段级原因，请据其修正后重试。' +
      '渲染、导出等操作耗时较长，宿主中断时将返回已完成部分。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '待执行的工具名称（来自 studio_tool_search 或 manual 指南）。' },
        args: { type: 'object', description: '该工具的参数对象，字段以 tool_search 返回的 params 为准。' },
      },
      required: ['name'],
    },
    tags: ['act'],
    summary: '执行检索到的任意动画工具。',
  },
];

const FACADE = {
  studio_start_guide: 'start_guide',
  studio_get_guide: 'get_guide',
  studio_tool_search: 'tool_search',
  studio_tool_call: 'tool_call',
};

/** 需要用户确认才可落盘的工程动作。 */
const WRITE_ACTIONS = new Set(['install', 'update']);

/** 将 handler 抛出的异常统一转换为失败回执，避免把堆栈内容提供给模型。 */
const wrap = (fn) => async (args, ctx) => {
  try {
    return await fn(args ?? {}, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `操作失败：${message}`, failed: true };
  }
};

/** 工具名到 handler 的映射；与 TOOL_DECLS 同源且顺序一致。 */
export function createTools(world) {
  const handlers = {
    studio_service: (args, ctx) => world.serviceAction(args, ctx),
    /**
     * 写入闸口：install / update 必须带 confirm:true。
     * 缺省时返回只读预检并标记为未完成，促使模型先征求用户同意再重试，
     * 而不是凭一次工具调用静默下载并覆盖工程源码。
     */
    studio_project: (args, ctx) => {
      const action = String(args?.action ?? '').toLowerCase();
      if (WRITE_ACTIONS.has(action) && args?.confirm !== true) {
        return { text: world.projectPrecheck(action, args ?? {}), failed: true };
      }
      return world.projectAction(args ?? {}, ctx);
    },
    studio_start_guide: (args, ctx) => world.callFacade(FACADE.studio_start_guide, args, ctx),
    studio_get_guide: (args, ctx) => world.callFacade(FACADE.studio_get_guide, args, ctx),
    studio_tool_search: (args, ctx) => world.callFacade(FACADE.studio_tool_search, args, ctx),
    studio_tool_call: (args, ctx) => world.callFacade(FACADE.studio_tool_call, args, ctx),
  };
  return TOOL_DECLS.map((decl) => ({
    name: decl.name,
    description: decl.description,
    parameters: decl.parameters,
    tags: decl.tags,
    interruptible: true,
    handler: wrap(handlers[decl.name]),
  }));
}
