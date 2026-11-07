/** 扩展入口：默认导出 WorldDefinition，框架按 `cortico.kind: world` / api 6 装载。 */
import { RSM_DEFAULTS, RSM_ID } from './config.mjs';
import { TOOL_DECLS } from './tools.mjs';
import { StudioWorld } from './world.mjs';

/**
 * 自描述里的工具清单与 tools() 同源。
 * 刻意不用框架的 describeTools()：扩展在运行期不 import 任何框架模块，
 * 少一层 `cortico/...` 解析就少一种装不上的可能（现成的 streamvoice 扩展也是这么做的）。
 */
export const RSM = {
  id: RSM_ID,
  label: '动画工作台',
  defaults: () => ({ ...RSM_DEFAULTS }),
  create: (ctx) => new StudioWorld(ctx),
  describe: {
    tools: TOOL_DECLS.map(({ name, description, parameters, tags, summary }) => ({
      name, description, parameters, tags, summary,
    })),
    events: [],
  },
};

export { RSM_DEFAULTS, RSM_ID, TOOL_DECLS, StudioWorld };
export default RSM;
