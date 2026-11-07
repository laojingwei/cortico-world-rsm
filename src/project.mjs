/**
 * 工程的下载、安装、指向本地已有目录、原地更新、版本检查与变更说明读取。
 *
 * 这是扩展对外发布后的核心路径：目标机器上可能没有工程源码、没有 npm，也没有系统 tar。
 * 全流程仅使用 Node 内置 fetch、zlib 与 fs；最后的依赖安装交由随包 pnpm 完成。
 * 安装与更新共用同一套合并语义（移植自 dsh-remotion-launcher/index.js:612），
 * 用户工程数据、依赖与自行安装的插件均保持不变。
 */
import { spawn } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import {
  extractTarball, fetchPackageMeta, fetchTarball, isNewerVersion, normalizeRegistry, readTarMember,
} from './tarball.mjs';
import { manualInstallCommand, runPnpm, runShell } from './process.mjs';
import { DEFAULT_PROJECT_PACKAGE, DEFAULT_REGISTRY, resolveRoot } from './config.mjs';

/** 安装与更新过程中不予触碰的本机状态（顶层名称）。 */
export const UPDATE_KEEP = new Set([
  'data', 'public', 'out',
  'node_modules', 'dist', '.remotion-bundle', '.browser',
  '.git', '.github',
  'workspace.json', 'memory', '.workbuddy',
]);
export const UPDATE_KEEP_PATTERN = [/\.log$/i, /^\.tmp/i];

/** 「包里也有同名项」时才覆盖：内置插件/文档跟着新版走，用户自己的留在原地。 */
export const MERGE_BY_NAME = new Set(['plugins', 'docs']);

/**
 * 只补缺失、绝不覆盖同名项：用户或 agent 自己下载的第三方工具。
 * 注意是**顶层目录粒度**（与 launcher 一致）：目录已存在就整目录跳过，
 * 连包里新增的子项也不补。保守换来的好处是用户改过的登记表绝不会被覆盖。
 */
export const FILL_MISSING = new Set(['.other_modules']);

function isKeptName(name) {
  return UPDATE_KEEP.has(name) || UPDATE_KEEP_PATTERN.some((re) => re.test(name));
}

function isSymlink(target) {
  try { return lstatSync(target).isSymbolicLink(); } catch { return false; }
}

/**
 * 把解包出来的新版本合并进工程目录（不做整目录替换，否则 data/ 会被抹掉）。
 * 返回计数，回执里会写清「保留了你自己的 N 项」。
 */
export function mergeProjectDir(srcDir, destDir) {
  const report = { copied: 0, overwritten: [], added: [], keptUser: [], keptTop: [], skippedExisting: [] };
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const name = entry.name;
    const from = join(srcDir, name);
    const to = join(destDir, name);

    if (isKeptName(name)) { report.keptTop.push(name); continue; }

    if (MERGE_BY_NAME.has(name) && entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      const incoming = new Set(readdirSync(from));
      for (const child of readdirSync(from, { withFileTypes: true })) {
        const childFrom = join(from, child.name);
        const childTo = join(to, child.name);
        // 先删后拷：不这么做，上一版删掉的文件会留在原地继续被加载。
        // 只处理包内同名的内置项，用户自建插件不在 incoming 里，完全不碰。
        if (existsSync(childTo) || isSymlink(childTo)) {
          rmSync(childTo, { recursive: true, force: true });
          report.overwritten.push(`${name}/${child.name}`);
        } else {
          report.added.push(`${name}/${child.name}`);
        }
        cpSync(childFrom, childTo, { recursive: true, force: true });
      }
      for (const child of readdirSync(to)) {
        if (!incoming.has(child)) report.keptUser.push(`${name}/${child}`);
      }
      report.copied += 1;
      continue;
    }

    if (FILL_MISSING.has(name)) {
      if (existsSync(to) || isSymlink(to)) report.skippedExisting.push(name);
      else { cpSync(from, to, { recursive: true, force: true }); report.copied += 1; }
      continue;
    }

    cpSync(from, to, { recursive: true, force: true });
    report.copied += 1;
  }
  return report;
}

export function describeMerge(report) {
  const inPlugins = (list) => list.filter((item) => item.startsWith('plugins/')).length;
  const parts = [`覆盖 ${report.copied} 项代码文件`];
  const over = inPlugins(report.overwritten);
  const added = inPlugins(report.added);
  if (over > 0) parts.push(`内置插件更新 ${over} 个`);
  if (added > 0) parts.push(`新增内置插件 ${added} 个`);
  if (report.keptUser.length > 0) parts.push(`保留用户内容 ${report.keptUser.length} 项`);
  if (report.skippedExisting.length > 0) parts.push(`${report.skippedExisting.join('、')} 已有内容未覆盖`);
  return parts.join('；');
}

/** 一个目录像不像工程根：要有 package.json 和 server/。 */
export function looksLikeProject(dir) {
  try {
    return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'server'));
  } catch { return false; }
}

export function readProjectVersion(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch { return null; }
}

function hasDeps(root) {
  return existsSync(join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'));
}

export function projectStatus(cfg) {
  const root = resolveRoot(cfg);
  return {
    root,
    valid: looksLikeProject(root),
    version: readProjectVersion(root),
    deps: hasDeps(root),
    registry: normalizeRegistry(cfg.registry || DEFAULT_REGISTRY),
    package: cfg.projectPackage || DEFAULT_PROJECT_PACKAGE,
    fromEnv: Boolean((process.env.REMOTION_STUDIO_ROOT ?? '').trim()),
  };
}

/** 下载 tarball → 解至临时目录 → 按合并规则落地。返回版本与合并报告。 */
async function downloadAndMerge({ registry, pkg, version, destDir, onLog, signal }) {
  const reg = normalizeRegistry(registry);
  let tmp = null;
  try {
    onLog?.('install', `[查询] 正在查询 ${pkg}@${version || 'latest'}（下载源：${reg}）`);
    const meta = await fetchPackageMeta(reg, pkg, version || 'latest', { signal, timeoutMs: 15000 });
    onLog?.('install', `[下载] 正在下载 ${pkg}@${meta.version}：${meta.tarball}`);
    const started = Date.now();
    const tgz = await fetchTarball(meta.tarball, { signal, timeoutMs: 180000 });
    onLog?.('install', `[下载] 已下载 ${(tgz.length / 1048576).toFixed(1)} MB（耗时 ${((Date.now() - started) / 1000).toFixed(1)}s），开始解包`);
    tmp = mkdtempSync(join(tmpdir(), 'cortico-rsm-'));
    const work = join(tmp, 'package');
    mkdirSync(work, { recursive: true });
    const extracted = extractTarball(tgz, work, { stripComponents: 1 });
    if (!extracted.written.length) throw new Error('tarball 中未包含可落地的内容');
    onLog?.('install', `[解包] 解出 ${extracted.written.length} 个文件${extracted.skipped.length ? `，跳过 ${extracted.skipped.length} 个（链接或非法路径）` : ''}，开始合并`);
    const report = mergeProjectDir(work, destDir);
    onLog?.('install', `[合并] ${describeMerge(report)}`);
    return { version: meta.version, report, skipped: extracted.skipped };
  } finally {
    if (tmp) {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结果 */ }
    }
  }
}

/**
 * pnpm 11 默认 `strict-dep-builds: true` + 默认不信任任何依赖的 build script：
 * 只要有脚本被跳过，就抛 ERR_PNPM_IGNORED_BUILDS 并以**退出码 1**结束。
 * Core 是非交互进程，弹不出 `pnpm approve-builds`；硬失败会让「依赖明明装好了」
 * 却被判成安装失败，用户点「安装工程」永远走不到底。
 *
 * 首选做法是让脚本**真的跑**，而不是「跳过 + 降级警告」：
 * 实测本工程全新安装时被跳过的只有 3 个 esbuild postinstall（0.25.12 / 0.28.1 / 0.28.2），
 * 它们是校验并兜底下载平台二进制的脚本，放行后 install 输出干净、exit 0，只多约 1.6s。
 * 这与 launcher 原本用 `npm install`（默认执行 install scripts）的行为一致。
 * pnpm 11 的 `onlyBuiltDependencies` 白名单只从工程 package.json 读，CLI/env 注入实测无效，
 * 因此用 `dangerouslyAllowAllBuilds`；`strict-dep-builds=false` 保留作旧版 pnpm 的兜底。
 * 注意 pnpm 读的是 `pnpm_config_` 前缀（不是 `npm_config_`）。
 */
/**
 * pnpm install 的环境变量。脚本执行已改由 runInstallScripts 承担（见 installDeps），
 * 这两项保留是为了避免 pnpm 把被跳过的构建脚本判为错误退出。
 */
const PNPM_INSTALL_ENV = Object.freeze({
  pnpm_config_dangerously_allow_all_builds: 'true',
  pnpm_config_strict_dep_builds: 'false',
});

/** 用当前 Node 在刚装好的工程里跑一段探针；超时/中断都要收束，不能挂住面板。 */
function defaultNodeProbe(root, script, { signal } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, ['-e', script], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: 1, out: '', err: error.message });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish({ code: 125, out, err: '已取消' });
    };
    child.stdout?.on('data', (c) => { out += String(c); });
    child.stderr?.on('data', (c) => { err += String(c); });
    child.on('error', (error) => finish({ code: 1, out, err: error.message }));
    child.on('exit', (code) => finish({ code: code ?? 1, out, err }));
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish({ code: 124, out, err: `${err}\n运行时自检超时` });
    }, 15000);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Remotion 的原生 ffmpeg/compositor 是 optional 平台包，pnpm 下通常只在 .pnpm 里。 */
function findCompositor(root) {
  try {
    const hit = readdirSync(join(root, 'node_modules/.pnpm'))
      .find((name) => /^@remotion\+compositor-/i.test(name));
    if (hit) return hit.replace(/^@remotion\+/, '@remotion/');
  } catch { /* 非 pnpm 布局 */ }
  try {
    const hit = readdirSync(join(root, 'node_modules/@remotion'))
      .find((name) => /^compositor-/i.test(name));
    if (hit) return `@remotion/${hit}`;
  } catch { /* 没有这个包 */ }
  return null;
}

/**
 * 安装后自检：不推断构建脚本被跳过后的影响，直接调用一次 esbuild transform 取得实测结论。
 * esbuild 的平台二进制来自 optionalDependencies，postinstall 仅负责校验与兜底下载；
 * 目录存在并不代表二进制可用，因此回执给出实测结果而非含糊的警告。
 * Chrome Headless Shell 并非依赖安装产物：@remotion/renderer 的 ensureBrowser()
 * 会在首次渲染时按需下载，故单独说明，避免将两者错误关联。
 */
export async function verifyRuntime(root, { probeImpl, signal, onLog, registry } = {}) {
  const script = "const e=require('esbuild');e.transform('const x:number=1',{loader:'ts'}).then(()=>console.log(e.version)).catch(err=>{console.error(String(err&&err.message||err));process.exitCode=1})";
  let raw;
  try {
    raw = await (probeImpl ?? defaultNodeProbe)(root, script, { signal });
  } catch (error) {
    raw = { code: 1, out: '', err: error instanceof Error ? error.message : String(error) };
  }
  const version = /\b\d+\.\d+\.\d+\b/.exec(raw.out || '')?.[0] ?? null;
  const esbuildOk = raw.code === 0 && Boolean(version);
  const compositor = findCompositor(root);
  const reg = normalizeRegistry(registry || DEFAULT_REGISTRY);
  const text = [
    esbuildOk
      ? `运行时自检：esbuild ${version} 二进制可用；${compositor ? `Remotion 原生组件 ${compositor} 已落地` : '未发现 Remotion 原生 compositor 包'}。`
      : `运行时自检未通过：esbuild 二进制不可用（${(raw.err || '').trim().slice(0, 200) || `exit ${raw.code}`}）。请在工程目录执行 pnpm rebuild esbuild，或重新安装依赖：${manualInstallCommand(root, reg)}`,
    '首次渲染视频时，Remotion 将按需下载 Chrome Headless Shell（约百 MB，需联网），该过程与依赖安装无关。',
  ].join('\n');
  onLog?.('install', `[自检] ${esbuildOk ? `运行时自检通过：esbuild ${version} 可用` : '运行时自检未通过：esbuild 不可用'}`);
  return { esbuildOk, version, compositor, text };
}

/** 依赖包生命周期脚本中与安装相关的三个阶段，按此顺序执行。 */
const SCRIPT_STAGES = Object.freeze(['preinstall', 'install', 'postinstall']);

/**
 * 收集需要执行的依赖生命周期脚本：`node_modules` 下一层依赖（含 scope 包与 pnpm 软链）与根工程。
 *
 * pnpm 以 `--ignore-scripts` 安装，脚本改由本扩展执行 —— 原因见 process.mjs 的 runShell 注释：
 * pnpm 自己 spawn 的 cmd.exe 不带 windowsHide，会在 Windows 上弹出控制台窗口。
 */
export function collectInstallScripts(root) {
  const found = [];
  const push = (dir, fallbackName) => {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const scripts = pkg?.scripts ?? {};
      const stages = SCRIPT_STAGES
        .filter((stage) => typeof scripts[stage] === 'string' && scripts[stage].trim())
        .map((stage) => ({ stage, script: scripts[stage] }));
      if (stages.length) found.push({ name: pkg.name || fallbackName, dir, stages });
    } catch { /* 没有 package.json 或不可解析：不是可执行目标 */ }
  };

  const modules = join(root, 'node_modules');
  let entries = [];
  try { entries = readdirSync(modules, { withFileTypes: true }); } catch { /* 未安装依赖 */ }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const dir = join(modules, entry.name);
    if (entry.name.startsWith('@')) {
      let subs = [];
      try { subs = readdirSync(dir, { withFileTypes: true }); } catch { /* 空 scope 目录 */ }
      for (const sub of subs) {
        if (sub.isDirectory() || sub.isSymbolicLink()) push(join(dir, sub.name), `${entry.name}/${sub.name}`);
      }
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) push(dir, entry.name);
  }
  // 根工程最后执行：它的脚本通常假定依赖已就绪
  push(root, '(root)');
  return found;
}

/**
 * 按声明顺序执行生命周期脚本。单项失败不中断后续项，也不让安装失败：
 * 是否需要因此判定失败由 verifyRuntime 的实测结论决定，避免因可选依赖的脚本报错误伤整个安装。
 */
export async function runInstallScripts(root, { onLog, signal, spawnImpl, timeoutMs } = {}) {
  const targets = collectInstallScripts(root);
  if (!targets.length) return { ran: 0, failed: [], names: [] };
  const binDir = join(root, 'node_modules', '.bin');
  const baseEnv = {
    INIT_CWD: root,
    PATH: [binDir, process.env.PATH ?? ''].filter(Boolean).join(delimiter),
  };
  const names = [];
  const failed = [];
  let ran = 0;
  for (const target of targets) {
    names.push(target.name);
    for (const { stage, script } of target.stages) {
      onLog?.('install', `[脚本] 执行 ${target.name} ${stage}：${script}`);
      const result = await runShell(script, target.dir, {
        onLog: (stream, chunk) => onLog?.('install', chunk),
        signal,
        spawnImpl,
        timeoutMs,
        extraEnv: {
          ...baseEnv,
          npm_lifecycle_event: stage,
          npm_lifecycle_script: script,
          npm_package_name: target.name,
        },
      });
      ran += 1;
      if (result.code !== 0) {
        failed.push(`${target.name} ${stage}`);
        onLog?.('install', `[脚本] ${target.name} ${stage} 退出码 ${result.code}，继续后续项`);
      }
    }
  }
  return { ran, failed, names };
}

/**
 * 是否需要由本扩展代跑依赖脚本。
 *
 * 仅 Windows 需要：pnpm 的 npm-lifecycle 在 Windows 上 spawn cmd.exe 时未传 windowsHide，
 * 而 pnpm 自身运行在无控制台可继承的 GUI 进程里，会弹出可见的控制台窗口。
 * macOS / Linux 不存在该问题，继续交由 pnpm 执行 —— 它能正确提供 node-gyp 环境与完整的 npm_config_*。
 */
export function needsScriptRunner(platform = process.platform) {
  return platform === 'win32';
}

/** 安装依赖：仅使用随包 pnpm，不回退至系统 npm。 */
async function installDeps({ root, registry, onLog, signal, spawnImpl, probeImpl }) {
  const reg = normalizeRegistry(registry);
  const runner = needsScriptRunner();
  onLog?.('install', `[依赖] 安装依赖：pnpm install --registry ${reg}（该步骤耗时最长，可能需数分钟）`);
  const args = ['install', '--registry', reg, '--no-frozen-lockfile'];
  // Windows 下让 pnpm 不执行任何脚本（见 needsScriptRunner），改由 runInstallScripts 带隐藏窗口执行
  if (runner) args.push('--ignore-scripts');
  const result = await runPnpm(args, root, { onLog, signal, spawnImpl, extraEnv: PNPM_INSTALL_ENV });
  if (result.code !== 0) {
    throw new Error(`pnpm install 以非零状态退出，依赖可能不完整。请手动执行：${manualInstallCommand(root, reg)}\n${result.tail}`);
  }
  const scripts = runner ? await runInstallScripts(root, { onLog, signal, spawnImpl }) : null;
  const scriptText = !scripts
    ? ''
    : scripts.ran
      ? `依赖脚本：已执行 ${scripts.ran} 项${scripts.failed.length
        ? `，其中 ${scripts.failed.length} 项失败（${scripts.failed.join('、')}，详见 install 日志）`
        : `（${scripts.names.slice(0, 6).join('、')}${scripts.names.length > 6 ? ' 等' : ''}）`}。`
      : '依赖脚本：本工程未声明 install / postinstall 脚本。';
  const check = await verifyRuntime(root, { probeImpl, signal, onLog, registry: reg });
  return [scriptText, check.text].filter(Boolean).join('\n');
}

function assertProjectReady(root) {
  if (!looksLikeProject(root)) throw new Error(`目录 ${root} 不是有效的工程目录（缺少 package.json 或 server/）`);
  if (!existsSync(join(root, 'server', 'index.ts'))) throw new Error(`工程目录缺少 server/index.ts：${root}`);
}

/** 首次安装：下载至指定目录（缺省使用配置项 installDir），按合并规则落地后安装依赖。 */
export async function installProject({ cfg, dir, registry, version, persist, onLog, signal, spawnImpl, probeImpl }) {
  const destDir = resolve(dir?.trim() || resolveRoot(cfg));
  const reg = normalizeRegistry(registry || cfg.registry || DEFAULT_REGISTRY);
  const pkg = cfg.projectPackage || DEFAULT_PROJECT_PACKAGE;
  mkdirSync(destDir, { recursive: true });
  const { version: installed, report } = await downloadAndMerge({
    registry: reg, pkg, version, destDir, onLog, signal,
  });
  assertProjectReady(destDir);
  const buildHint = await installDeps({ root: destDir, registry: reg, onLog, signal, spawnImpl, probeImpl });
  // 仅在安装成功后更新配置，避免中途失败使 World 指向不完整的目录。
  // 显式传入 dir 时必须同步配置，否则会出现「安装到 A、配置仍指向 B」的难以排查状态。
  const envOverride = Boolean(process.env.REMOTION_STUDIO_ROOT);
  if (envOverride) {
    onLog?.('install', '提示：REMOTION_STUDIO_ROOT 环境变量优先于配置项，installDir 不会被改写。');
  } else if (dir?.trim() || !cfg.installDir) {
    persist?.({ installDir: destDir });
  }
  return [
    `工程已就绪：${destDir}`,
    `版本 ${installed}；${describeMerge(report)}`,
    '工程数据、node_modules、dist 与用户自行安装的插件均按合并规则保留。',
    envOverride ? '提示：REMOTION_STUDIO_ROOT 环境变量优先于配置项，当前生效目录可能不是本目录。' : '',
    buildHint,
    '后续操作：执行 studio_service({action:"start"}) 启动服务；服务就绪后可使用 studio_start_guide 开始创作。',
  ].filter(Boolean).join('\n');
}

/** 指向本地已有的工程目录：仅校验并更新配置，不下载、不安装依赖、不覆盖任何文件。 */
export function useProject({ cfg, dir, persist }) {
  const target = resolve(String(dir ?? '').trim());
  assertProjectReady(target);
  const version = readProjectVersion(target);
  const deps = hasDeps(target);
  if (process.env.REMOTION_STUDIO_ROOT) {
    return `已校验 ${target}（版本 ${version ?? '未知'}）。由于 REMOTION_STUDIO_ROOT 环境变量优先级更高，当前生效目录仍为 ${resolveRoot(cfg)}。如需切换，请修改该环境变量或在配置中清空。`;
  }
  persist?.({ installDir: target });
  return `已指向 ${target}（版本 ${version ?? '未知'}）。${deps ? '依赖已安装。' : `依赖尚未安装，请执行 studio_project({action:"install"}) 或手动执行：${manualInstallCommand(target, cfg.registry || DEFAULT_REGISTRY)}`}`;
}

/** 原地更新：下载 → 合并 → 安装依赖，不执行整目录替换。 */
export async function updateProject({ cfg, registry, version, onLog, signal, spawnImpl, probeImpl }) {
  const root = resolveRoot(cfg);
  assertProjectReady(root);
  const before = readProjectVersion(root);
  const reg = normalizeRegistry(registry || cfg.registry || DEFAULT_REGISTRY);
  const pkg = cfg.projectPackage || DEFAULT_PROJECT_PACKAGE;
  const { version: downloaded, report } = await downloadAndMerge({
    registry: reg, pkg, version, destDir: root, onLog, signal,
  });
  const buildHint = await installDeps({ root, registry: reg, onLog, signal, spawnImpl, probeImpl });
  const after = readProjectVersion(root);
  return [
    `工程已更新：${before ?? '?'} → ${after ?? downloaded}`,
    describeMerge(report),
    report.keptUser.length ? `用户内容按合并规则保留：${report.keptUser.slice(0, 10).join('、')}${report.keptUser.length > 10 ? ' 等' : ''}` : '',
    buildHint,
    '更新将在重启服务后生效：先执行 studio_service({action:"stop"})，再执行 action=start。',
  ].filter(Boolean).join('\n');
}

/** 版本检查：本地 package.json 版本 vs registry latest，纯只读联网。 */
export async function checkUpdates({ cfg, registry, signal }) {
  const status = projectStatus(cfg);
  const reg = normalizeRegistry(registry || status.registry);
  const meta = await fetchPackageMeta(reg, status.package, 'latest', { signal });
  return {
    registry: reg,
    package: status.package,
    root: status.root,
    local: status.version,
    latest: meta.version,
    hasNewer: Boolean(status.version) && isNewerVersion(meta.version, status.version),
    valid: status.valid,
    deps: status.deps,
  };
}

/** Keep a Changelog 风格：取某个 `## [x.y.z]` 段落；找不到就给全文开头。 */
export function parseChangelog(markdown, version) {
  const text = String(markdown ?? '').replace(/\r\n/g, '\n');
  if (!version) return text.slice(0, 6000);
  const lines = text.split('\n');
  const marker = /^##\s+\[?v?([0-9][^\]\s]*)\]?\s*(?:[-—]\s*(.+))?$/;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = marker.exec(lines[i]);
    if (m && (m[1] === version || `v${m[1]}` === version)) { start = i; break; }
  }
  if (start < 0) return text.slice(0, 6000);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (marker.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim().slice(0, 6000);
}

function changelogCacheFile(cacheDir, pkg, version) {
  const safe = (v) => String(v || '').replace(/[^\w.-]/g, '_');
  return join(cacheDir, `changelog-${safe(pkg)}-${safe(version)}.md`);
}

/**
 * 取工程某个版本的 CHANGELOG：当前版本先读本地，新版本从 registry tarball 里取
 * （npm registry 没有文件接口：registry.npmjs.org 404、npmmirror /files/ 403）。
 */
export async function readChangelog({ cfg, version, cacheDir, signal }) {
  const status = projectStatus(cfg);
  const wanted = String(version ?? '').trim() || status.version || 'latest';
  const local = join(status.root, 'CHANGELOG.md');
  if (existsSync(local) && (wanted === status.version || wanted === 'latest')) {
    return { text: parseChangelog(readFileSync(local, 'utf8'), status.version), source: local, version: status.version };
  }
  const cache = changelogCacheFile(cacheDir, status.package, wanted);
  let text = null;
  let source = '';
  if (existsSync(cache)) {
    text = readFileSync(cache, 'utf8');
    source = cache;
  } else {
    const meta = await fetchPackageMeta(status.registry, status.package, wanted, { signal });
    const tgz = await fetchTarball(meta.tarball, { signal });
    text = readTarMember(tgz, 'CHANGELOG.md');
    if (!text) throw new Error(`${status.package}@${meta.version} 的 tarball 中未包含 CHANGELOG.md`);
    source = `registry tarball（${meta.tarball}）`;
    mkdirSync(cacheDir, { recursive: true });
    try { writeFileSync(cache, text, 'utf8'); } catch { /* 缓存写不了不影响读取 */ }
  }
  return { text: parseChangelog(text, wanted), source, version: wanted };
}
