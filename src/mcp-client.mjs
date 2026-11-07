/**
 * remotion-studio-mcp 的 `/mcp` 端点客户端。
 *
 * 该端点实现极简 JSON-RPC over HTTP：POST 一个 JSON 对象，仅支持 initialize / tools/list /
 * tools/call / ping，无会话、无 SSE、无鉴权（server/index.ts:762 起）。
 * 因此使用内置 fetch 即可完整覆盖，无需 @modelcontextprotocol/sdk，也不必处理 stdio 帧。
 *
 * 安全约束：端点强制限定本机回环地址。server/security.ts 的 checkRequest 放行「不带 Origin 的本机进程」，
 * Node fetch 默认不携带 Origin、Host 为 127.0.0.1:<port>，符合该规则；配置为外部地址时将在此处被拒绝。
 */
import { readFileSync } from 'node:fs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0', '[::]']);

let rpcId = 0;
let cachedVersion;

/** 扩展自身版本，取自 package.json，避免与发布版本脱钩；读取失败时退化为通用标识，不阻断调用。 */
export function clientVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (typeof pkg?.version === 'string' && pkg.version.trim()) cachedVersion = pkg.version.trim();
  } catch {
    // 打包或裁剪后取不到 package.json 时保持未设值
  }
  return cachedVersion ?? '0.0.0-unknown';
}

export function assertLoopback(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint));
  } catch {
    throw new Error(`MCP 端点不是合法 URL：${endpoint}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`MCP 端点只支持 http/https：${endpoint}`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`MCP 端点只允许本机回环（127.0.0.1 / localhost / ::1），已拒绝 ${url.hostname}`);
  }
  return url;
}

export function originOf(endpoint) {
  return assertLoopback(endpoint).origin;
}

function requestSignal(outer, timeoutMs) {
  const signals = [AbortSignal.timeout(Math.max(1000, timeoutMs))];
  if (outer) signals.push(outer);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const s of signals) s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  return controller.signal;
}

/** 发送一条 JSON-RPC 请求；返回 result，error 统一转换为带上下文的异常。 */
export async function rpc(endpoint, method, params = {}, { signal, timeoutMs = 30000 } = {}) {
  assertLoopback(endpoint);
  const id = ++rpcId;
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: requestSignal(signal, timeoutMs),
    });
  } catch (error) {
    const name = error && typeof error === 'object' ? String(error.name ?? '') : '';
    const reason = error instanceof Error ? error.message : String(error);
    if (signal?.aborted) {
      throw new Error(`已取消对 ${endpoint} 的 ${method} 请求（调用方中止）`);
    }
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`请求 ${endpoint} 超时（${method}，上限 ${Math.max(1000, timeoutMs)}ms）。服务可能正在构建或负载过高，可执行 studio_service({action:'status'}) 查看状态与日志，必要时调高配置项 timeoutMs`);
    }
    throw new Error(`无法连接至 ${endpoint}（${reason}）。请先执行 studio_service({action:'status'}) 查询服务状态，必要时执行 studio_service({action:'start'})`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    throw new Error(`/mcp HTTP ${res.status}：${detail}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`/mcp ${method} 返回的不是 JSON`);
  }
  if (body?.error) throw new Error(`/mcp ${method}：${body.error.message ?? JSON.stringify(body.error)}`);
  if (!Object.prototype.hasOwnProperty.call(body ?? {}, 'result')) {
    throw new Error(`/mcp ${method} 缺少 result 字段（通知类方法不应经由 rpc 调用）`);
  }
  return body.result;
}

export async function initialize(endpoint, opts) {
  return rpc(endpoint, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cortico-world-rsm', version: clientVersion() },
  }, opts);
}

export async function ping(endpoint, opts) {
  return rpc(endpoint, 'ping', {}, opts);
}

/** 默认门面模式下恰好 4 个工具；MCP_EXPOSE=all 时数量更多，客户端不预设数量。 */
export async function listTools(endpoint, opts) {
  const result = await rpc(endpoint, 'tools/list', {}, opts);
  return Array.isArray(result?.tools) ? result.tools : [];
}

export const CORE_TOOL_NAMES = Object.freeze([
  'start_guide', 'get_guide', 'tool_search', 'tool_call',
]);

/**
 * 调用工具。isError=true 映射为 ToolOutcome.failed=true，使 Core 将本次调用标记为失败，
 * 而不会把失败文本当作正常结果继续提供给模型。
 */
export async function callTool(endpoint, name, args, opts) {
  const result = await rpc(endpoint, 'tools/call', { name, arguments: args ?? {} }, opts);
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
  return {
    text: text || (result?.isError ? '工具返回失败，但未提供文本说明' : JSON.stringify(result ?? {})),
    failed: result?.isError === true,
  };
}
