/**
 * 本机服务与子进程管理：健康检查、端口检测、构建、子进程创建与终止、日志环形缓冲。
 * 移植自 dsh-remotion-launcher/index.js，并针对 Coopanion 的运行环境做了两处必要调整：
 *
 *   1. 依赖安装使用随包 pnpm（process.execPath + CORTICO_PNPM_CJS），不依赖系统 npm/npx。
 *   2. 构建显式先执行 prebuild。pnpm 自 v6 起默认 enable-pre-post-scripts=false，
 *      `pnpm run build` 不会自动执行 prebuild；而工程的 prebuild 负责生成
 *      src/_plugins.generated.ts，跳过将导致编辑器页面资源缺失。
 *
 * 控制台窗口约束（Windows）：
 *   pnpm 在 Windows 上通过 `cmd.exe /d /s /c` 执行 npm scripts，且 npm-lifecycle 的
 *   spawn 配置不含 windowsHide、还带 detached；父进程设置的 windowsHide 不会传递给孙进程。
 *   因此构建链路不使用 `pnpm run`，改为由 process.execPath 直接执行工程内的 Node CLI 入口，
 *   全程由本模块控制窗口标志。服务进程在 Windows 上也不使用 detached，避免新建控制台。
 *
 * 仅管理由本扩展启动或已接管的进程：探活发现端口上已有服务时标记为 external，
 * 不重复启动、也不终止该服务。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { clearOwner, writeOwner } from './ownership.mjs';

const MAX_LOGS = 600;

/** 按来源分流的环形缓冲，供 studio_service({action:'logs'}) 读取。 */
export class LogRing {
  constructor(max = MAX_LOGS) {
    this.max = max;
    this.seq = 0;
    this.entries = [];
  }

  push(stream, chunk) {
    const text = String(chunk).replace(/\u001b\[[0-9;]*m/g, '');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.entries.push({ seq: ++this.seq, at: Date.now(), stream, text: line.slice(0, 2000) });
    }
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
  }

  sys(message) { this.push('sys', message); }

  since(seq = 0, { limit = 80, stream } = {}) {
    const picked = this.entries.filter((e) => e.seq > seq && (!stream || e.stream === stream));
    return { entries: picked.slice(-Math.max(1, Math.min(limit, 300))), lastSeq: this.seq };
  }
}

const healthUrl = (origin) => `${String(origin).replace(/\/+$/, '')}/api/health`;

/** /api/health 探活；超时视为不通，不抛错。 */
export async function probeHealth(origin, timeoutMs = 1200) {
  try {
    const res = await fetch(healthUrl(origin), { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 端口是否空闲：临时监听后立即关闭，比解析 netstat 稳定，且不引入第三方依赖。 */
export function isPortFree(port) {
  return new Promise((done) => {
    const probe = createNetServer();
    probe.unref();
    probe.once('error', () => done(false));
    probe.once('listening', () => probe.close(() => done(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/** 随包 pnpm 的入口。Core 进程带 ELECTRON_RUN_AS_NODE=1，process.execPath 可直接作为 Node 使用。 */
export function pnpmCommand() {
  return (process.env.CORTICO_PNPM_CJS ?? '').trim();
}

export function manualInstallCommand(root, registry) {
  const entry = pnpmCommand() || '<CORTICO_PNPM_CJS>';
  return `node "${entry}" install --registry ${registry} --no-frozen-lockfile（工作目录：${root}）`;
}

/** 所有子进程共用的窗口标志：Windows 下隐藏控制台窗口。 */
const SPAWN_BASE = Object.freeze({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * 执行一条 pnpm 子命令。spawnImpl 可注入，便于离线自检断言参数而不真的安装依赖。
 * CI=true 为必需项：pnpm 遇到「node_modules 由其它包管理器创建」时会弹出交互确认，
 * 非交互环境下将阻塞（studio_project({action:'use'}) 指向已有工程时最易触发）。
 */
export function runPnpm(args, cwd, opts = {}) {
  const { onLog, spawnImpl = spawn, timeoutMs = 600000, signal, extraEnv } = opts;
  const cjs = pnpmCommand();
  if (!cjs) {
    return Promise.reject(new Error(
      'CORTICO_PNPM_CJS 未设置：当前进程不是 Coopanion 的 Core。请在 Core 环境中运行，或手动在工程目录执行 pnpm install。',
    ));
  }
  return runChild(
    spawnImpl,
    [cjs, ...args],
    cwd,
    { onLog, stream: 'install', label: 'pnpm', timeoutMs, signal,
      env: { ...process.env, CI: 'true', ...(extraEnv ?? {}) } },
  );
}

/**
 * 由 process.execPath 直接执行一个 Node 脚本，绕开 pnpm 与 cmd.exe。
 * 构建链路专用：不产生控制台窗口，也不依赖 PATH 中的 npx / tsx / vite。
 */
export function runNode(script, args, cwd, opts = {}) {
  const { onLog, spawnImpl = spawn, timeoutMs = 300000, signal, extraEnv } = opts;
  return runChild(
    spawnImpl,
    [script, ...args],
    cwd,
    { onLog, stream: 'build', label: '构建进程', timeoutMs, signal,
      env: { ...process.env, ...(extraEnv ?? {}) } },
  );
}

/**
 * 带有隐藏窗口地执行一条 shell 命令（Windows 走 cmd.exe /d /s /c，POSIX 走 /bin/sh -c）。
 *
 * 目前仅 Windows 的依赖脚本代跑会用到（判定见 project.mjs 的 needsScriptRunner）：
 * pnpm 的 npm-lifecycle 在 Windows 上调用 child_process.spawn 时未传 windowsHide，
 * 而 pnpm 自身运行在无控制台可继承的 GUI 进程里，于是它的子 cmd.exe 会新建可见控制台窗口。
 * 本项目发出的 spawn 一律带 windowsHide，因此由我们代为执行即可彻底消除该窗口。
 * POSIX 分支保留作通用实现，非 Windows 平台仍由 pnpm 执行依赖脚本。
 */
export function runShell(script, cwd, opts = {}) {
  const { onLog, spawnImpl = spawn, timeoutMs = 300000, signal, extraEnv } = opts;
  const win = process.platform === 'win32';
  const file = win ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  const argv = win ? ['/d', '/s', '/c', script] : ['-c', script];
  return runChild(
    spawnImpl,
    argv,
    cwd,
    { onLog, stream: 'install', label: '依赖脚本', timeoutMs, signal,
      env: { ...process.env, ...(extraEnv ?? {}) }, file },
  );
}

/** runPnpm / runNode 共用的子进程生命周期管理。默认以 process.execPath 作为可执行文件。 */
function runChild(spawnImpl, argv, cwd, { onLog, stream, label, timeoutMs, signal, env, file = process.execPath }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(file, argv, { cwd, env, ...SPAWN_BASE });
    } catch (error) {
      reject(new Error(`${label}启动失败：${error.message}`));
      return;
    }
    const tail = [];
    const collect = (chunk) => {
      const text = String(chunk);
      onLog?.(stream, text);
      tail.push(text);
      if (tail.length > 40) tail.shift();
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => {
      try { killTree(child); } catch { /* 忽略清理异常 */ }
      finish(reject, new Error(`${label}超时（${timeoutMs}ms）`));
    }, timeoutMs);
    signal?.addEventListener('abort', () => {
      try { killTree(child); } catch { /* 忽略清理异常 */ }
      finish(reject, new Error('已取消（宿主放弃本次调用）'));
    }, { once: true });
    child.on('error', (error) => finish(reject, new Error(`${label}启动失败：${error.message}`)));
    child.on('exit', (code) => finish(resolve, { code: code ?? 1, tail: tail.join('').slice(-4000) }));
  });
}

/** 常见 CLI 的兜底路径：包尚未安装时也能给出确定的 Node 入口，便于自检与错误定位。 */
const BIN_FALLBACK = Object.freeze({
  tsx: 'node_modules/tsx/dist/cli.mjs',
  vite: 'node_modules/vite/bin/vite.js',
});

/**
 * 将 npm script 的首个命令解析为可由 process.execPath 直接执行的文件。
 * 优先读取包自身 package.json 的 bin 字段，读取失败时使用内置兜底路径；
 * 两者都不适用时返回 null，由调用方回退至 pnpm（并在日志中说明原因）。
 */
function resolveNodeBin(root, bin) {
  if (bin === 'node' || bin === 'node.exe') return { passthrough: true };
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'node_modules', bin, 'package.json'), 'utf8'));
    const declared = pkg?.bin;
    const rel = typeof declared === 'string'
      ? declared
      : declared?.[bin] ?? Object.values(declared ?? {})[0];
    if (typeof rel === 'string' && rel) {
      return { script: join(root, 'node_modules', bin, rel) };
    }
  } catch { /* 包不存在时使用内置兜底路径 */ }
  const fallback = BIN_FALLBACK[bin];
  return fallback ? { script: join(root, fallback) } : null;
}

/**
 * 构建命令决策：把 package.json 的 prebuild / build 脚本解析为可直接执行的 Node 命令，
 * 不经过 pnpm 与 cmd.exe。prebuild 必须作为独立一步执行（pnpm 默认不运行 pre/post 脚本）。
 * 无法解析的脚本回退至 `pnpm run`，保证兼容性。
 */
export function resolveBuildCommands(root) {
  let scripts = {};
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  } catch {
    scripts = {};
  }
  const toCommand = (label, text, why) => {
    const tokens = String(text).trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    const resolved = resolveNodeBin(root, tokens[0]);
    if (resolved?.passthrough) {
      return { label, script: join(root, tokens[1] ?? ''), args: tokens.slice(2), why };
    }
    if (resolved?.script) {
      return { label, script: resolved.script, args: tokens.slice(1), why };
    }
    return {
      label, pnpmArgs: ['run', label], args: [],
      why: `${why}；该命令无法解析为 Node 入口，已回退至 pnpm`,
    };
  };
  const commands = [];
  const pre = typeof scripts.prebuild === 'string' ? scripts.prebuild.trim() : '';
  const build = typeof scripts.build === 'string' ? scripts.build.trim() : '';
  if (pre) {
    commands.push(toCommand('prebuild', pre,
      '工程声明了 prebuild，须显式执行以生成未随 npm 包分发的插件入口'));
  }
  if (build) {
    commands.push(toCommand('build', build, '工程声明了 build 脚本'));
  }
  if (!commands.length) {
    commands.push({
      label: 'vite build', script: join(root, BIN_FALLBACK.vite), args: ['build'],
      why: '工程未声明 build 脚本，直接调用 vite',
    });
  }
  return commands.filter(Boolean);
}

/** 顺序执行构建命令，任一步非零退出即失败（调用方据此中止启动服务）。 */
export async function runBuild(root, opts = {}) {
  const { onLog, signal, timeoutMs = 300000, spawnImpl } = opts;
  const commands = resolveBuildCommands(root);
  const results = [];
  for (const cmd of commands) {
    onLog?.('build', `[构建] ${cmd.label}：${cmd.why}`);
    const result = cmd.pnpmArgs
      ? await runPnpm(cmd.pnpmArgs, root, { onLog: (s, c) => onLog?.('build', c), signal, timeoutMs, spawnImpl })
      : await runNode(cmd.script, cmd.args, root, { onLog, signal, timeoutMs, spawnImpl });
    results.push({ label: cmd.label, code: result.code });
    if (result.code !== 0) {
      return { ok: false, results, error: `${cmd.label} 执行失败（exit ${result.code}），未启动服务` };
    }
  }
  return { ok: true, results };
}

/**
 * 子进程环境：端口与 SERVER_URL 必须由同一个值推导。
 * 服务端读取 `SERVER_URL ?? http://127.0.0.1:${PORT}`（server/tools/_shared.ts:50），
 * 显式固定 SERVER_URL 可避免环境变量中残留的旧值把内部工具转发至其它实例。
 * 独立成函数，便于自检断言端口变更时两者一致。
 */
export function serverEnvironment(port, extra = {}) {
  return {
    ...process.env,
    PORT: String(port),
    SERVER_URL: `http://127.0.0.1:${port}`,
    ...extra,
    CODEBUDDY_SAFE_DELETE_ENABLED: '0',
  };
}

/**
 * 终止服务进程树，且同步等待完成：框架关机执行 `await mod.stop()`（20s 预算），
 * 旧实现使用异步 spawn 不等待，stop() 立即返回、Core 随即退出，taskkill 可能尚未完成，
 * 服务因而成为孤儿进程。此处使用 spawnSync（8s 上限）确保 stop() 返回时进程确已终止。
 *
 * child 可以是 ChildProcess，也可以是跨实例认领得到的纯 `{ pid }` 句柄，故不依赖 child.kill()。
 * spawnImpl 可注入，自检不会真的终止进程。
 */
export function killTree(child, opts = {}) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'no-pid' };
  if (child?.killed) return { ok: true, reason: 'already-killed' };
  const run = opts.spawnImpl ?? spawnSync;
  try {
    if (process.platform === 'win32') {
      const result = run('taskkill', ['/pid', String(pid), '/T', '/F'], {
        timeout: 8000, windowsHide: true, stdio: 'ignore',
      });
      return { ok: result?.status === 0, code: result?.status ?? null };
    }
    try { process.kill(-pid, 'SIGTERM'); } catch { /* 进程组不存在，回退至单进程 */ }
    try { process.kill(pid, 'SIGTERM'); } catch { /* 进程已退出 */ }
    return { ok: true };
  } catch (error) {
    // 终止失败不应使 stop() 抛错：状态仍需回到 stopped
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 启动服务。使用工程内的 tsx 与 process.execPath，与 remotion-studio-mcp 的
 * server/tools/_shared.ts:ensureServer 保持一致，不依赖 PATH 中的 npx / tsx。
 * Windows 下不使用 detached：该标志会使子进程脱离父控制台并新建控制台窗口。
 * POSIX 保留 detached，以便按进程组终止整棵进程树。
 * 返回 { mode, proc, pid }；mode='external' 表示端口上已有其它服务。
 */
export async function startServer({ root, port, origin, env, onLog, signal, spawnImpl = spawn, waitMs = 90000 }) {
  if (await probeHealth(origin)) {
    onLog?.('sys', `端口 ${port} 上已有服务在运行，未重复启动（external）`);
    return { mode: 'external', proc: null, pid: null };
  }
  if (!(await isPortFree(port))) {
    throw new Error(`端口 ${port} 已被其他程序占用，未执行构建；请在配置中更换端口后重试`);
  }
  const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const entry = join(root, 'server', 'index.ts');
  if (!existsSync(tsxCli) || !existsSync(entry)) {
    throw new Error(`工程依赖或源码不完整（缺少 ${tsxCli} 或 ${entry}）。请先执行 studio_project({action:'install'})`);
  }
  onLog?.('sys', `启动服务：tsx server/index.ts（PORT=${port}）`);
  const child = spawnImpl(process.execPath, [tsxCli, entry], {
    cwd: root,
    detached: process.platform !== 'win32',
    ...SPAWN_BASE,
    env: serverEnvironment(port, env),
  });
  child.stdout?.on('data', (chunk) => onLog?.('server', chunk));
  child.stderr?.on('data', (chunk) => onLog?.('server', chunk));
  child.on('error', (error) => onLog?.('server', `服务进程启动失败：${error.message}`));
  child.on('exit', (code) => {
    onLog?.('sys', `服务进程退出（exit ${code}）`);
    // 服务自行退出或被本扩展终止时清除归属记录，避免下次挂载认领已失效的 PID
    clearOwner(root, child.pid);
  });

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      killTree(child);
      clearOwner(root, child.pid);
      throw new Error('已取消（宿主放弃本次调用）');
    }
    if (await probeHealth(origin)) {
      onLog?.('sys', `服务已就绪：${origin}`);
      // 归属记录：Core 退出后，下一次挂载据此认领并允许终止服务
      writeOwner(root, { pid: child.pid, port, corePid: process.pid });
      return { mode: 'owned', proc: child, pid: child.pid ?? null };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  killTree(child);
  clearOwner(root, child.pid);
  throw new Error(`启动超时（${waitMs / 1000}s 内 /api/health 未就绪）；可通过 studio_service({action:'logs'}) 查看日志`);
}

/** 打开本机编辑器；失败不影响回执，访问地址始终返回给用户。 */
export function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    // 不使用 detached：Windows 下该标志会为 cmd.exe 新建控制台窗口
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
