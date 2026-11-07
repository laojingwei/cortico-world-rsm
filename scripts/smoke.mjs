/**
 * 可重跑的自检脚本。默认全离线，不写任何工程目录：
 *   node scripts/smoke.mjs                 离线断言 + 校验 describe.json
 *   node scripts/smoke.mjs --write-describe  先按框架 describe-export.ts 的规则生成 describe.json
 *   node scripts/smoke.mjs --live          额外打真实 npm registry 与本机服务（端口取 RSM_LIVE_PORT 或配置的 port）
 *
 * 覆盖：manifest 契约、config 路径与 defaults 对应、World 干装载等价断言、
 * describe.json 一致性、tar 解析/防穿越、合并保留规则、版本比较、loopback 校验、
 * JSON-RPC roundtrip 与 isError 映射、pnpm spawn 参数、prebuild 不绕过、
 * 启动自动构建（两条启动路径 / 失败不启动 / 并发去重 / 单次跳过）、
 * 中文文件名 PAX 头按字节解析、安装失败落进日志流、
 * pnpm 放行 esbuild postinstall、安装后运行时自检（真实调用 esbuild 二进制）、
 * 控制台面板布局结构（常用配置排在操作前 / 按钮分组收敛 / 辅助动作归位）、
 * 构建不经 pnpm / Windows 无 detached / 用户可见文案的规范性。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';

import RSM, { RSM_DEFAULTS, RSM_ID, TOOL_DECLS } from '../src/index.mjs';
import { configGroups, effectivePort, resolveEndpoint } from '../src/config.mjs';
import {
  assertLoopback, callTool, initialize, listTools, ping, CORE_TOOL_NAMES,
} from '../src/mcp-client.mjs';
import {
  LogRing, killTree, resolveBuildCommands, runBuild, runPnpm, serverEnvironment,
} from '../src/process.mjs';
import {
  claimOwned, clearOwner, ownerPath, pidAlive, readOwner, writeOwner,
} from '../src/ownership.mjs';
import {
  collectInstallScripts, describeMerge, installProject, mergeProjectDir, needsScriptRunner,
  parseChangelog, projectStatus, runInstallScripts, UPDATE_KEEP, verifyRuntime,
} from '../src/project.mjs';
import {
  extractTarball, fetchPackageMeta, isNewerVersion, normalizeRegistry, readTarMember, safeJoin, tarEntries,
} from '../src/tarball.mjs';

const PACKAGE_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ARGS = new Set(process.argv.slice(2));
const results = [];
let scratch = null;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, ok: true }); console.log(`  ✓ ${name}`); })
    .catch((error) => {
      results.push({ name, ok: false, error });
      console.log(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
    });
}

function makeScratch() {
  if (!scratch) scratch = mkdtempSync(join(tmpdir(), 'cortico-rsm-smoke-'));
  return scratch;
}

function writeUnder(root, relative, content) {
  const target = join(root, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
}

/** 复刻 cortico/src/extensions/dry-mount.ts 的 fakeWorldContext。 */
function fakeContext() {
  const cfg = RSM.defaults();
  const root = join(makeScratch(), 'deployment');
  mkdirSync(join(root, 'data'), { recursive: true });
  return {
    id: RSM_ID,
    cfg,
    timezone: 'Asia/Shanghai',
    botName: 'Coo',
    botDir: root,
    packageDir: PACKAGE_DIR,
    dataDir: join(root, 'data'),
    repoRoot: root,
    secret: () => '',
    storeSecret: () => {},
    persist: (patch) => Object.assign(cfg, patch),
    restart: async () => {},
  };
}

/**
 * 极简 DOM 桩：让 dist/webui.js 能在 Node 里真 mount 一次。
 * 只实现面板用到的那几个 ui 原语，用来验证卡片顺序、按钮禁用态与安装/更新切换，
 * 不替代浏览器里的真实渲染（那部分只能重启 Coopanion 目测）。
 */
function panelHarness(state, opts = {}) {
  const node = (tag) => ({
    tag, children: [], textContent: '', value: '', disabled: false, title: '',
    /** 面板里用 ui.h + style 做少量局部排版，桩要能接住 inline style。 */
    style: {}, className: '',
    classList: { add() {}, remove() {} },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...kids) { this.children = kids.filter(Boolean); },
  });
  const buttons = [];
  const sections = [];
  const checkboxes = [];
  const calls = [];
  const kvRows = [];
  let refreshTick = null;
  let checkResult = opts.checkResult ?? { local: '1.2.0', latest: '1.3.0', hasNewer: true };
  let checkError = opts.checkError ?? null;
  const ui = {
    h: (tag, cls, text) => {
      const el = node(tag);
      el.className = cls ?? '';
      el.textContent = text ?? '';
      return el;
    },
    sheet: (opts) => {
      const el = node(`sheet:${opts.title}`);
      const body = node('body');
      el.appendChild(body);
      return { el, body, note: node('note'), desc: node('desc') };
    },
    actions: () => node('actions'),
    rowbar: () => node('rowbar'),
    section: (title) => { sections.push(title); return node(`section:${title}`); },
    button: (label, opts = {}) => {
      const el = node(`button:${label}`);
      el.label = label;
      el.onClick = opts.onClick;
      buttons.push(el);
      return el;
    },
    checkbox: (label, opts = {}) => {
      const cb = {
        el: node(`checkbox:${label}`),
        input: node('input'),
        checked: opts.checked ?? false,
        setChecked(v) { this.checked = v; },
      };
      cb.label = label;
      checkboxes.push(cb);
      return cb;
    },
    input: (opts = {}) => Object.assign(node('input'), { value: opts.value ?? '' }),
    field: (label, control) => {
      const el = node(`field:${label}`);
      el.appendChild(control);
      return el;
    },
    msgline: () => node('msgline'),
    kv: (rows) => {
      kvRows.length = 0;
      kvRows.push(...(rows ?? []));
      return node('kv');
    },
    pill: (text) => node(`pill:${text}`),
    log: () => ({ el: node('log'), append() {}, clear() {}, count: 0, stuck: true, scrollToEnd() {} }),
    drawer: () => ({ dispose() {} }),
    toast: () => ({ dispose() {} }),
    confirm: async () => true,
  };
  const ctx = {
    language: 'zh',
    root: node('root'),
    ui,
    invoke: async (method, args) => {
      calls.push({ method, args });
      if (method === 'state') return { ...state };
      if (method === 'config') {
        return {
          port: 4380, registry: 'https://registry.npmmirror.com',
          installDir: '', autoBuild: true, autoStart: false,
        };
      }
      if (method === 'logs') return { entries: [], lastSeq: 0 };
      if (method === 'checkUpdates') {
        if (checkError) throw checkError;
        return { ...checkResult };
      }
      return { text: 'ok' };
    },
    interval: (fn, ms) => {
      if (ms === 6000) refreshTick = fn;
      return { dispose() {} };
    },
  };
  return {
    ctx, buttons, sections, checkboxes, calls, kvRows,
    setCheckResult(value) { checkResult = value; checkError = null; },
    setCheckError(error) { checkError = error; },
    get refreshTick() { return refreshTick; },
  };
}

const flush = () => new Promise((done) => setTimeout(done, 0));

/** 复刻 cortico/src/extensions/describe-export.ts 的 promptsOf + exportFrom(world)。 */
function generateDescribe() {
  const def = RSM;
  const world = def.create(fakeContext());
  const docs = (world.webUi?.('zh')?.promptDocs ?? []).filter((doc) => doc.role === 'envPrompt');
  const seen = new Set();
  const prompts = [];
  for (const doc of docs) {
    if (seen.has(doc.key) || !existsSync(doc.path)) continue;
    seen.add(doc.key);
    prompts.push({
      key: doc.key,
      title: doc.title,
      ...(doc.role ? { role: doc.role } : {}),
      content: readFileSync(doc.path, 'utf8'),
    });
  }
  const file = { tools: [...def.describe.tools], events: [...def.describe.events] };
  if (prompts.length) file.prompts = prompts;
  return JSON.parse(JSON.stringify(file));
}

/** 手搓一个最小 ustar，用来验证 tar 解析不依赖系统 tar。 */
function makeTar(files) {
  const chunks = [];
  for (const file of files) {
    const data = Buffer.from(file.content ?? '', 'utf8');
    const header = Buffer.alloc(512);
    header.write(file.name, 0, 100, 'utf8');
    if (file.prefix) header.write(file.prefix, 345, 155, 'utf8');
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header[156] = file.type === 'dir' ? '5'.charCodeAt(0)
      : file.type === 'pax' ? 'x'.charCodeAt(0)
        : '0'.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    chunks.push(header);
    if (file.type !== 'dir') {
      if (data.length) chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

async function main() {
  console.log(`cortico-world-rsm 自检（${ARGS.has('--live') ? '含 live' : '全离线'}）\n`);

  if (ARGS.has('--write-describe')) {
    const target = join(PACKAGE_DIR, 'describe.json');
    writeFileSync(target, `${JSON.stringify(generateDescribe(), null, 2)}\n`, 'utf8');
    console.log(`  ✓ 已生成 describe.json\n`);
  }

  await test('manifest: type=module / kind=world / api=6 / 入口与 describe 路径', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
    assert.equal(pkg.type, 'module');
    assert.ok(pkg.keywords.includes('cortico-world'));
    assert.equal(pkg.cortico.kind, 'world');
    assert.equal(pkg.cortico.api, 6);
    assert.ok(existsSync(join(PACKAGE_DIR, pkg.main)));
    assert.ok(existsSync(join(PACKAGE_DIR, pkg.cortico.describe)));
    assert.match(pkg.cortico.describe, /^[a-z0-9._/-]+\.json$/);
  });

  await test('defaults(): enabled=false，且每个配置旋钮都有对应默认值', () => {
    const defaults = RSM.defaults();
    assert.equal(defaults.enabled, false, '新装 World 必须默认关');
    assert.equal(defaults.autoStart, false, 'autoStart 必须默认关：不能在用户没操作时偷偷起服务');
    assert.equal(RSM_DEFAULTS.autoStart, false);
    assert.equal(defaults.autoBuild, true, '启动自动构建仍必须默认开');
    assert.notStrictEqual(defaults, RSM.defaults(), 'defaults() 每次要返回新对象');
    for (const language of ['zh', 'en']) {
      for (const group of configGroups(language)) {
        assert.equal(group.owner, `world:${RSM_ID}`);
        assert.ok(group.schema?.properties);
        for (const path of Object.keys(group.schema.properties)) {
          assert.ok(path.startsWith(`worlds.${RSM_ID}.`), `${path} 写到了别人的配置段`);
          const key = path.slice(`worlds.${RSM_ID}.`.length);
          assert.notEqual(defaults[key], undefined, `${path} 在 defaults() 里没有对应项`);
        }
      }
    }
    assert.deepEqual(Object.keys(RSM_DEFAULTS).filter((k) => !configGroups('zh').some((g) => g.schema.properties[`worlds.rsm.${k}`])), ['enabled']);
  });

  await test('World 干装载：create / tools / envPromptVars / webUi 均不抛错且合规', async () => {
    const def = RSM;
    const world = def.create(fakeContext());
    assert.equal(world.id, def.id);
    const tools = world.tools();
    assert.equal(tools.length, 6);
    assert.equal(new Set(tools.map((t) => t.name)).size, tools.length);
    for (const tool of tools) {
      assert.match(tool.name, /^[a-z0-9]+_/);
      assert.equal(typeof tool.parameters, 'object');
      assert.equal(typeof tool.handler, 'function');
      assert.ok(Array.isArray(tool.tags) && tool.tags.length > 0);
      assert.equal(tool.interruptible, true, `${tool.name} 是长调用，必须可中断`);
    }
    const vars = await world.envPromptVars();
    assert.equal(typeof vars, 'object');
    const template = readFileSync(join(PACKAGE_DIR, 'src', 'ENV_PROMPT.md'), 'utf8');
    const names = [...template.matchAll(/\{\{\s*([\w.]+)\s*(?:\|[^}]*)?\}\}/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(names)].sort(), Object.keys(vars).sort(), '模板占位符与 envPromptVars() 必须一一对应');
    for (const language of ['zh', 'en']) {
      const decl = world.webUi(language);
      assert.ok((decl.lamps?.length ?? 0) <= 7, '状态灯超过 MODULE_LAMP_MAX');
      assert.equal(new Set((decl.promptDocs ?? []).map((d) => d.key)).size, (decl.promptDocs ?? []).length);
      for (const doc of decl.promptDocs ?? []) {
        if (doc.role === 'envPrompt') assert.ok(existsSync(doc.path), `${doc.path} 不存在，环境段会是空的`);
      }
      for (const group of decl.config ?? []) assert.equal(group.owner, `world:${RSM_ID}`);
    }
    await world.start({});
    assert.equal(typeof world.mode, 'string');
  });

  await test('写入闸口：install / update 未带 confirm 只回预检，不落盘', async () => {
    const ctx = fakeContext();
    const target = join(makeScratch(), 'gate-target', 'project');
    ctx.cfg.installDir = target;
    const world = RSM.create(ctx);
    const tool = world.tools().find((t) => t.name === 'studio_project');
    assert.ok(tool, 'studio_project 必须存在');
    assert.ok(tool.parameters.properties.confirm, 'confirm 必须出现在参数定义里');

    const pre = await tool.handler({ action: 'install' }, {});
    assert.equal(pre.failed, true, '未确认的写入不得计为成功');
    assert.match(pre.text, /需要用户确认，未执行任何写入/);
    assert.match(pre.text, /confirm:true/);
    assert.ok(pre.text.includes(target), '预检必须给出目标目录');
    assert.match(pre.text, /目标版本：latest/);
    assert.match(pre.text, /数分钟/, '预检必须说明耗时');
    assert.equal(existsSync(target), false, '预检不得创建目标目录');
    assert.equal(ctx.cfg.installDir, target, '预检不得改动配置');

    const denied = await tool.handler({ action: 'install', confirm: false }, {});
    assert.equal(denied.failed, true, 'confirm:false 同样视为未确认');
    assert.equal(existsSync(target), false);

    const upd = await tool.handler({ action: 'update' }, {});
    assert.equal(upd.failed, true, 'update 同样受闸口约束（会覆盖工程源码）');
    assert.match(upd.text, /保留 data\//);
    assert.match(upd.text, /重启服务/);

    // 只读动作不受闸口影响
    const status = await tool.handler({ action: 'status' }, {});
    assert.equal(typeof status, 'string');
    assert.match(status, /工程目录/);

    // 控制台面板自带确认对话框，走 panelInvoke，不经过该闸口
    const panel = await world.panelInvoke('control', 'project', ['status']);
    assert.match(panel.text, /工程目录/);

    // confirm:true 必须放行到真正的执行路径
    const passed = [];
    world.projectAction = async (args) => { passed.push(args); return '已执行'; };
    const run = await world.tools().find((t) => t.name === 'studio_project')
      .handler({ action: 'install', confirm: true }, {});
    assert.equal(run, '已执行');
    assert.equal(passed[0]?.confirm, true);
  });

  await test('describe.json 与代码里的 describe / 模板一致', () => {
    const written = JSON.parse(readFileSync(join(PACKAGE_DIR, 'describe.json'), 'utf8'));
    const expected = generateDescribe();
    assert.ok(isDeepStrictEqual(written, expected), 'describe.json 与框架 describe-export.ts 的生成结果不一致');
    assert.equal(written.tools.length, 6);
    assert.equal(written.events.length, 0);
    assert.ok(written.prompts?.some((p) => p.role === 'envPrompt' && p.content.includes('rsm.bridge')));
    const declared = new Set(written.tools.map((t) => t.name));
    const live = RSM.create(fakeContext()).tools().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    for (const tool of live) {
      assert.ok(declared.has(tool.name), `${tool.name} 没在 describe.tools 里声明`);
      const decl = written.tools.find((t) => t.name === tool.name);
      assert.equal(decl.description, tool.description);
      assert.ok(isDeepStrictEqual(decl.parameters, tool.parameters));
      assert.deepEqual(decl.tags, TOOL_DECLS.find((d) => d.name === tool.name).tags);
    }
  });

  await test('tar: ustar/prefix 解析、strip-components、CHANGELOG 成员读取、路径穿越防护', () => {
    const tgz = gzipSync(makeTar([
      { name: 'package/', type: 'dir' },
      { name: 'package/server/index.ts', content: 'export const ok = 1;' },
      { name: 'long.txt', prefix: 'package', content: 'prefix + name 拼接' },
      { name: 'package/CHANGELOG.md', content: '## [1.2.0] - 2026-11-07\n- 新增 A\n\n## [1.1.0]\n- 旧条目' },
      { name: 'package/../evil.txt', content: 'evil' },
    ]));
    const entries = [...tarEntries(gunzipSync(tgz))];
    assert.ok(entries.some((e) => e.name === 'package/long.txt'), 'prefix 字段未生效');
    const dest = join(makeScratch(), 'unpack');
    const report = extractTarball(tgz, dest, { stripComponents: 1 });
    assert.equal(readFileSync(join(dest, 'server', 'index.ts'), 'utf8'), 'export const ok = 1;');
    assert.equal(readFileSync(join(dest, 'long.txt'), 'utf8'), 'prefix + name 拼接');
    assert.ok(report.skipped.some((s) => s.includes('evil')), '恶意路径没被拦下');
    assert.ok(!existsSync(join(makeScratch(), 'evil.txt')));
    const changelog = readTarMember(tgz, 'CHANGELOG.md');
    assert.ok(changelog.includes('## [1.2.0]'));
    assert.match(parseChangelog(changelog, '1.2.0'), /新增 A/);
    assert.ok(!parseChangelog(changelog, '1.2.0').includes('旧条目'));
    assert.equal(safeJoin(dest, '../evil.txt'), null);
    assert.equal(safeJoin(dest, '/etc/passwd'), null);
    assert.equal(safeJoin(dest, 'C:\\Windows\\x'), null);
    assert.ok(safeJoin(dest, 'a/b.txt').startsWith(resolve(dest) + sep));
  });

  await test('真实 npm tarball：中文文件名的 PAX 头按字节解析，非法路径只跳过不中断', () => {
    /** 构造自洽的 PAX 记录：'<len> <keyword>=<value>\n'，len 是整条记录的**字节数**。 */
    const paxRecord = (keyword, value) => {
      const body = Buffer.from(`${keyword}=${value}\n`, 'utf8');
      let len = body.length + 2;
      for (let i = 0; i < 8; i += 1) {
        const total = body.length + String(len).length + 1;
        if (total === len) break;
        len = total;
      }
      return Buffer.concat([Buffer.from(`${len} `, 'ascii'), body]);
    };
    const name = '启动编辑器.bat';
    const full = `package/${name}`;
    // npm 给非 ASCII 路径写 PAX 头，后面还跟着 mtime 记录；旧实现按字符下标切，
    // 会把 "19 mtime=..." 混进文件名，解包直接 ENOENT。
    const paxData = Buffer.concat([paxRecord('path', full), paxRecord('mtime', '1700000000')]);
    const tgz = gzipSync(makeTar([
      { name: 'package/', type: 'dir' },
      { name: 'PaxHeaders/0', type: 'pax', content: paxData },
      { name: 'package/XXXXXXXX', content: '@echo off\r\nstart editor\r\n' },
    ]));
    const entries = [...tarEntries(gunzipSync(tgz))];
    assert.ok(entries.some((e) => e.name === full),
      `PAX path 没生效：${entries.map((e) => JSON.stringify(e.name)).join(', ')}`);
    const dest = join(makeScratch(), 'unpack-pax');
    const report = extractTarball(tgz, dest, { stripComponents: 1 });
    assert.ok(report.written.includes(name), '中文文件名没落地');
    assert.equal(readFileSync(join(dest, name), 'utf8'), '@echo off\r\nstart editor\r\n');
    assert.equal(report.skipped.length, 0);

    const bad = gzipSync(makeTar([
      { name: 'PaxHeaders/0', type: 'pax', content: paxRecord('path', 'package/bad\nname.txt') },
      { name: 'package/x', content: 'x' },
    ]));
    const badReport = extractTarball(bad, join(makeScratch(), 'unpack-bad'), { stripComponents: 1 });
    assert.ok(badReport.skipped.length >= 1, '带换行的路径必须被跳过而不是抛 ENOENT');
  });

  await test('安装失败会写进日志流（面板不再停在「下载 xxx」）', async () => {
    const world = RSM.create(fakeContext());
    await assert.rejects(
      () => world.runProjectTask('install', async () => { throw new Error('模拟解包失败：ENOENT'); }),
      /模拟解包失败/,
    );
    const lines = world.logs.since(0, { stream: 'install' }).entries.map((e) => e.text);
    assert.ok(lines.some((l) => l.includes('[失败] install') && l.includes('模拟解包失败')), lines.join('\n'));
  });

  await test('registry 请求：传了外部 signal 也保留超时，不会被无限挂住', async () => {
    const server = createHttpServer(() => { /* 故意永不响应 */ });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${server.address().port}`;
    const controller = new AbortController();
    try {
      // 旧实现是 `signal ?? AbortSignal.timeout(...)`：传了 signal 就完全失去超时保护
      await assert.rejects(
        () => fetchPackageMeta(base, 'x', 'latest', { signal: controller.signal, timeoutMs: 150 }),
      );
    } finally {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    }
  });

  await test('合并规则：data/node_modules/dist 不碰，用户插件保留，内置插件与 docs 同名覆盖', () => {
    const root = join(makeScratch(), 'merge');
    const src = join(root, 'src');
    const dest = join(root, 'dest');
    writeUnder(dest, 'data/keep.json', 'USER DATA');
    writeUnder(dest, 'node_modules/tsx/dist/cli.mjs', 'USER DEPS');
    writeUnder(dest, 'dist/web/index.html', 'USER BUILD');
    writeUnder(dest, 'plugins/my-plugin/index.js', 'MY PLUGIN');
    writeUnder(dest, 'plugins/_example-tool/plugin.ts.example', 'OLD BUILTIN');
    writeUnder(dest, 'docs/PLUGIN-GUIDE.md', 'OLD DOC');
    writeUnder(dest, '.other_modules/tool/README.md', 'MY REGISTRY');
    writeUnder(dest, 'app.log', 'MY LOG');
    writeUnder(dest, 'src/index.ts', 'OLD CODE');
    writeUnder(src, 'data/keep.json', 'PACKAGE DATA');
    writeUnder(src, 'plugins/_example-tool/plugin.ts.example', 'NEW BUILTIN');
    writeUnder(src, 'docs/PLUGIN-GUIDE.md', 'NEW DOC');
    writeUnder(src, '.other_modules/tool/README.md', 'PACKAGE REGISTRY');
    writeUnder(src, '.other_modules/new-tool/README.md', 'NEW TOOL');
    writeUnder(src, 'app.log', 'PACKAGE LOG');
    writeUnder(src, 'src/index.ts', 'NEW CODE');
    writeUnder(src, 'server/new.ts', 'NEW FILE');
    const report = mergeProjectDir(src, dest);
    assert.equal(readFileSync(join(dest, 'data/keep.json'), 'utf8'), 'USER DATA');
    assert.equal(readFileSync(join(dest, 'node_modules/tsx/dist/cli.mjs'), 'utf8'), 'USER DEPS');
    assert.equal(readFileSync(join(dest, 'dist/web/index.html'), 'utf8'), 'USER BUILD');
    assert.equal(readFileSync(join(dest, 'plugins/my-plugin/index.js'), 'utf8'), 'MY PLUGIN');
    assert.equal(readFileSync(join(dest, '.other_modules/tool/README.md'), 'utf8'), 'MY REGISTRY');
    assert.equal(readFileSync(join(dest, 'app.log'), 'utf8'), 'MY LOG');
    assert.equal(readFileSync(join(dest, 'plugins/_example-tool/plugin.ts.example'), 'utf8'), 'NEW BUILTIN');
    assert.equal(readFileSync(join(dest, 'docs/PLUGIN-GUIDE.md'), 'utf8'), 'NEW DOC');
    assert.equal(readFileSync(join(dest, 'src/index.ts'), 'utf8'), 'NEW CODE');
    // FILL_MISSING 是顶层粒度：目录已存在就整目录跳过，包里新增的子项也不补（launcher 原语义）
    assert.ok(!existsSync(join(dest, '.other_modules/new-tool/README.md')));
    assert.ok(report.skippedExisting.includes('.other_modules'));
    assert.ok(existsSync(join(dest, 'server/new.ts')));
    // keptTop 只记录「包里带了的」受保护项；真实 npm 包不会带 node_modules/dist
    assert.ok(report.keptTop.includes('data'));
    assert.ok(!report.keptTop.includes('node_modules') && !report.keptTop.includes('dist'));
    assert.ok(report.keptUser.includes('plugins/my-plugin'));
    assert.match(describeMerge(report), /保留用户内容/);
    assert.ok(UPDATE_KEEP.has('.workbuddy'));
  });

  await test('版本比较与 registry 归一化', () => {
    assert.equal(isNewerVersion('1.2.1', '1.2.0'), true);
    assert.equal(isNewerVersion('1.2.0', '1.2.0'), false);
    assert.equal(isNewerVersion('2.0.0', '1.9.9'), true);
    assert.equal(isNewerVersion('1.2.0', '1.2.0-beta.1'), true, '正式版比预发布新');
    assert.equal(isNewerVersion('1.2.0-beta.2', '1.2.0-beta.1'), true);
    assert.equal(normalizeRegistry('https://registry.npmmirror.com/'), 'https://registry.npmmirror.com');
    assert.throws(() => normalizeRegistry('ftp://x'), /http\(s\)/);
  });

  await test('MCP endpoint 强制 loopback', () => {
    assert.equal(assertLoopback('http://127.0.0.1:4380/mcp').hostname, '127.0.0.1');
    assert.equal(assertLoopback('http://localhost:5599/mcp').hostname, 'localhost');
    assert.equal(assertLoopback('http://[::1]:4380/mcp').hostname, '[::1]');
    assert.throws(() => assertLoopback('https://evil.example.com/mcp'), /只允许本机回环/);
    assert.throws(() => assertLoopback('ftp://127.0.0.1/mcp'), /http\/https/);
  });

  await test('端口可配：改 port / 自定义 endpoint 后启动、探活、编辑器链接、SERVER_URL 全链路一致', async () => {
    const cfg = RSM.defaults();
    cfg.port = 5599;
    assert.equal(effectivePort(cfg), 5599);
    assert.equal(resolveEndpoint(cfg), 'http://127.0.0.1:5599/mcp');
    const ctx = fakeContext();
    ctx.cfg = cfg;
    const world = RSM.create(ctx);
    assert.equal(world.port, 5599);
    assert.equal(world.endpoint, 'http://127.0.0.1:5599/mcp');
    assert.equal(world.origin, 'http://127.0.0.1:5599');
    assert.equal(world.webUi('zh').links[0].href, 'http://127.0.0.1:5599/');
    assert.match((await world.envPromptVars())['rsm.config'], /端口 5599/);
    assert.equal(serverEnvironment(5599).PORT, '5599');
    assert.equal(serverEnvironment(5599).SERVER_URL, 'http://127.0.0.1:5599', '服务端内部工具必须打到同一个端口');
    cfg.endpoint = 'http://127.0.0.1:6123/mcp';
    assert.equal(effectivePort(cfg), 6123, '自定义 endpoint 里的端口优先于 port 字段');
    assert.equal(RSM.create({ ...ctx, cfg }).port, 6123);
  });

  await test('JSON-RPC roundtrip：initialize / tools/list / tools/call，isError → failed', async () => {
    const seen = [];
    const server = createHttpServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const msg = JSON.parse(raw);
        seen.push(msg);
        const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
        let body;
        if (msg.method === 'initialize') body = reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'remotion-studio', version: 'test' } });
        else if (msg.method === 'ping') body = reply({});
        else if (msg.method === 'tools/list') body = reply({ tools: CORE_TOOL_NAMES.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) });
        else if (msg.method === 'tools/call') {
          const bad = msg.params.name === 'bad';
          body = reply({ content: [{ type: 'text', text: bad ? '失败：没有这个工具' : '# 创作流程' }], isError: bad });
        } else body = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: '未知方法' } };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
      const init = await initialize(endpoint);
      assert.equal(init.protocolVersion, '2024-11-05');
      assert.deepEqual(await ping(endpoint), {});
      const tools = await listTools(endpoint);
      assert.deepEqual(tools.map((t) => t.name), [...CORE_TOOL_NAMES]);
      assert.equal(tools.length, 4, '默认门面模式 tools/list 应恰好 4 个');
      const ok = await callTool(endpoint, 'start_guide', { projectId: 'p_1' });
      assert.equal(ok.text, '# 创作流程');
      assert.notEqual(ok.failed, true);
      const bad = await callTool(endpoint, 'bad', {});
      assert.equal(bad.failed, true, 'isError:true 必须映射成 failed 回执');
      assert.match(bad.text, /失败/);
      assert.ok(seen.every((m) => m.jsonrpc === '2.0' && typeof m.id === 'number'));
      assert.equal(seen.find((m) => m.method === 'tools/call').params.arguments.projectId, 'p_1');
      const pkgVersion = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).version;
      const initMsg = seen.find((m) => m.method === 'initialize');
      assert.equal(initMsg.params.clientInfo.version, pkgVersion, 'clientInfo.version 必须取自 package.json');
      assert.equal(initMsg.params.clientInfo.name, 'cortico-world-rsm');
    } finally {
      server.close();
    }
  });

  await test('请求超时、连接失败、调用方中止分开报错', async () => {
    const hanging = createHttpServer(() => { /* 接受连接但永不响应 */ });
    await new Promise((r) => hanging.listen(0, '127.0.0.1', r));
    const hangEndpoint = `http://127.0.0.1:${hanging.address().port}/mcp`;
    try {
      await assert.rejects(() => ping(hangEndpoint, { timeoutMs: 200 }),
        /超时（ping，上限 1000ms）/, '超时必须给出时长与排查建议，而非笼统的连接失败');
      const own = new AbortController();
      const pending = ping(hangEndpoint, { timeoutMs: 20000, signal: own.signal });
      setTimeout(() => own.abort(), 50);
      await assert.rejects(() => pending, /已取消对 \S+ 的 ping 请求/, '调用方中止不得误报为超时');
    } finally {
      hanging.closeAllConnections?.();
      hanging.close();
    }

    const dead = createHttpServer(() => {});
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = dead.address().port;
    await new Promise((r) => dead.close(r));
    await assert.rejects(() => ping(`http://127.0.0.1:${deadPort}/mcp`), (error) => {
      assert.match(error.message, /无法连接至/);
      assert.doesNotMatch(error.message, /超时/, '连接被拒不得报成超时');
      return true;
    });
  });

  await test('构建由 Node 直接执行（不经 pnpm / cmd.exe），依赖安装仍走随包 pnpm', async () => {
    const root = join(makeScratch(), 'pnpm-root');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      scripts: { prebuild: 'tsx scripts/gen-plugin-entry.mts', build: 'vite build' },
    }), 'utf8');
    const commands = resolveBuildCommands(root);
    assert.equal(commands.length, 2, 'prebuild 必须作为独立一步，pnpm 默认不执行 pre/post 脚本');
    assert.equal(commands[0].label, 'prebuild');
    assert.equal(commands[0].pnpmArgs, undefined, '构建不得回退至 pnpm run（会在 Windows 弹出 cmd 窗口）');
    assert.ok(commands[0].script.endsWith(join('node_modules', 'tsx', 'dist', 'cli.mjs')));
    assert.deepEqual(commands[0].args, ['scripts/gen-plugin-entry.mts']);
    assert.equal(commands[1].label, 'build');
    assert.equal(commands[1].pnpmArgs, undefined);
    assert.ok(commands[1].script.endsWith(join('node_modules', 'vite', 'bin', 'vite.js')));
    assert.deepEqual(commands[1].args, ['build']);

    const previous = process.env.CORTICO_PNPM_CJS;
    process.env.CORTICO_PNPM_CJS = 'C:\\fake\\pnpm.cjs';
    const recorded = [];
    const mockSpawn = (exe, args, opts) => {
      recorded.push({ exe, args, opts });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 4242;
      child.killed = false;
      process.nextTick(() => { child.stdout.end(); child.stderr.end(); child.emit('exit', 0); });
      return child;
    };
    try {
      const result = await runPnpm(
        ['install', '--registry', 'https://registry.npmmirror.com', '--no-frozen-lockfile'],
        root,
        { spawnImpl: mockSpawn, timeoutMs: 5000 },
      );
      assert.equal(result.code, 0);
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].args[0], 'C:\\fake\\pnpm.cjs', '必须用随包 pnpm 而不是系统 npm');
      assert.ok(recorded[0].args.includes('--registry'));
      assert.ok(recorded[0].args.includes('--no-frozen-lockfile'));
      assert.equal(recorded[0].opts.env.CI, 'true', '非交互下必须带 CI=true，否则 pnpm 会弹确认卡住');
      assert.equal(recorded[0].exe, process.execPath);
    } finally {
      if (previous === undefined) delete process.env.CORTICO_PNPM_CJS;
      else process.env.CORTICO_PNPM_CJS = previous;
    }
    const ring = new LogRing(3);
    ring.push('server', 'a\nb');
    ring.push('build', 'c');
    ring.push('sys', 'd');
    assert.equal(ring.entries.length, 3);
    assert.equal(ring.since(2, { stream: 'sys' }).entries[0].text, 'd');

    // 构建实际执行时不得经过 pnpm：pnpm 在 Windows 会 spawn 不带 windowsHide 的 cmd.exe
    const buildCalls = [];
    const buildSpawn = (exe, args, opts) => {
      buildCalls.push({ exe, args, opts });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 5252;
      child.killed = false;
      process.nextTick(() => { child.stdout.end(); child.stderr.end(); child.emit('exit', 0); });
      return child;
    };
    const built = await runBuild(root, { spawnImpl: buildSpawn, timeoutMs: 5000 });
    assert.equal(built.ok, true);
    assert.equal(buildCalls.length, 2, 'prebuild 与 build 各执行一次');
    assert.ok(buildCalls.every((c) => c.exe === process.execPath), '构建必须由 process.execPath 直接执行');
    assert.ok(buildCalls.every((c) => !c.args.some((a) => String(a).includes('pnpm.cjs'))), '构建不得调用 pnpm');
    assert.ok(buildCalls.every((c) => c.opts.windowsHide === true), '构建子进程必须隐藏控制台窗口');
  });

  await test('运行时自检：真实调用 esbuild 二进制，失败/异常都收束并给可执行的补救文案', async () => {
    const root = makeScratch();
    mkdirSync(join(root, 'node_modules/.pnpm/@remotion+compositor-win32-x64-msvc@4.0.538'), { recursive: true });
    const ok = await verifyRuntime(root, {
      probeImpl: async (cwd, script) => {
        assert.match(script, /require\('esbuild'\)/, '探针必须真实加载 esbuild');
        assert.match(script, /transform/, '只 require 不够，要真的驱动一次二进制');
        return { code: 0, out: '0.28.2\n', err: '' };
      },
    });
    assert.equal(ok.esbuildOk, true);
    assert.equal(ok.version, '0.28.2');
    assert.match(ok.compositor, /compositor-win32/);
    assert.match(ok.text, /二进制可用/);
    assert.match(ok.text, /Chrome Headless Shell/);

    const bad = await verifyRuntime(root, {
      probeImpl: async () => ({ code: 1, out: '', err: 'Cannot find module esbuild' }),
    });
    assert.equal(bad.esbuildOk, false);
    assert.match(bad.text, /运行时自检未通过/);
    assert.match(bad.text, /pnpm rebuild esbuild/);
    assert.match(bad.text, /Cannot find module esbuild/);

    const threw = await verifyRuntime(root, {
      probeImpl: async () => { throw new Error('spawn boom'); },
    });
    assert.equal(threw.esbuildOk, false);
    assert.match(threw.text, /spawn boom/);

    // 默认探针在缺依赖的目录里也必须收束，不能挂住面板
    const real = await verifyRuntime(root);
    assert.equal(real.esbuildOk, false);
    assert.match(real.text, /运行时自检未通过/);
  });

  await test('启动自动构建：默认开，手动 start 与自动拉起（开关打开时）都构建，失败不启动，可单次跳过', async () => {
    assert.equal(RSM_DEFAULTS.autoBuild, true, 'autoBuild 必须默认开：不构建就起服务会白屏');
    assert.equal(RSM.defaults().autoBuild, true);
    const root = join(makeScratch(), 'fake-project');
    mkdirSync(join(root, 'server'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'remotion-studio-mcp', version: '1.2.0',
      scripts: { prebuild: 'gen', build: 'vite build' },
    }), 'utf8');

    const previousEnv = process.env.REMOTION_STUDIO_ROOT;
    delete process.env.REMOTION_STUDIO_ROOT;
    const calls = [];
    const makeWorld = (patch = {}, overrides = {}) => {
      const ctx = fakeContext();
      ctx.cfg.installDir = root;
      Object.assign(ctx.cfg, patch);
      const world = RSM.create(ctx);
      world.hooks = {
        killTree: () => ({ ok: true }),
        probeHealth: async () => overrides.healthy ?? false,
        isPortFree: async () => overrides.portFree ?? true,
        runBuild: async (dir, opts) => {
          calls.push({ kind: 'build', dir, timeoutMs: opts?.timeoutMs });
          return overrides.buildOk === false
            ? { ok: false, error: 'prebuild 失败（exit 1）' }
            : { ok: true, results: [] };
        },
        startServer: async (opts) => {
          calls.push({ kind: 'start', port: opts.port, origin: opts.origin });
          return { mode: 'owned', proc: { pid: 9999, killed: false } };
        },
      };
      return world;
    };
    const builds = () => calls.filter((c) => c.kind === 'build').length;
    const starts = () => calls.filter((c) => c.kind === 'start').length;

    try {
      // A 手动 start：默认构建，且构建用独立更宽的超时
      const a = makeWorld();
      const textA = await a.serviceAction({ action: 'start' }, {});
      assert.equal(builds(), 1, '手动 start 默认必须构建');
      assert.equal(starts(), 1);
      assert.ok(textA.includes('已完成 prebuild + build'));
      assert.ok(calls.find((c) => c.kind === 'build').timeoutMs >= 300000, '构建不能被单次调用超时砍断');

      // B 门面工具的自动拉起路径 —— 旧实现直接 startServer，漏掉了构建
      calls.length = 0;
      const b = makeWorld({ autoStart: true });
      const rB = await b.ensureService({});
      assert.equal(rB.reused, false);
      assert.equal(builds(), 1, 'ensureService 也必须构建，否则模型调工具时起来的是白屏服务');
      assert.equal(starts(), 1);

      // C 单次跳过 / 配置关闭
      calls.length = 0;
      await makeWorld().serviceAction({ action: 'start', build: false }, {});
      assert.equal(builds(), 0, 'build:false 应跳过当次构建');
      assert.equal(starts(), 1);
      await makeWorld({ autoBuild: false, autoStart: true }).ensureService({});
      assert.equal(builds(), 0, '配置关闭后自动拉起不构建');
      assert.equal(starts(), 2);

      // D 构建失败绝不启动
      calls.length = 0;
      const d = makeWorld({}, { buildOk: false });
      await assert.rejects(() => d.serviceAction({ action: 'start' }, {}), /prebuild 失败/);
      assert.equal(starts(), 0, '构建失败后不能启动服务');
      assert.match(d.lastError, /prebuild 失败/);

      // E 外部服务已在跑：直接复用，不构建也不重写它正在读的 dist
      calls.length = 0;
      const e = makeWorld({}, { healthy: true });
      const rE = await e.launch({}, undefined);
      assert.equal(rE.reused, true);
      assert.equal(builds(), 0);
      assert.equal(starts(), 0);

      // F 并发启动合并成一次：两个 vite build 同时写 dist 会互相破坏
      calls.length = 0;
      const f = makeWorld({ autoStart: true });
      const [f1, f2] = await Promise.all([f.ensureService({}), f.ensureService({})]);
      assert.equal(builds(), 1, '并发不能跑两次构建');
      assert.equal(starts(), 1);
      assert.equal(f1.built, true);
      assert.equal(f2.built, true);

      // G 端口占用：先报端口，别白跑一次构建
      calls.length = 0;
      const g = makeWorld({}, { portFree: false });
      await assert.rejects(() => g.serviceAction({ action: 'start' }, {}), /被其他程序占用/);
      assert.equal(builds(), 0);
      assert.equal(starts(), 0);

      // H autoStart 关闭只挡自动拉起，不该挡用户手动启动
      calls.length = 0;
      const h = makeWorld({ autoStart: false });
      await assert.rejects(() => h.ensureService({}), /autoStart 已关闭/);
      assert.equal(starts(), 0);
      await h.serviceAction({ action: 'start' }, {});
      assert.equal(starts(), 1);
    } finally {
      if (previousEnv === undefined) delete process.env.REMOTION_STUDIO_ROOT;
      else process.env.REMOTION_STUDIO_ROOT = previousEnv;
    }
  });

  await test('服务默认不自动拉起：门面工具只给提示，用户显式 start 仍可启动', async () => {
    const root = join(makeScratch(), 'fake-project-autostart');
    mkdirSync(join(root, 'server'), { recursive: true });
    writeFileSync(join(root, 'server', 'index.ts'), '', 'utf8');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'remotion-studio-mcp', version: '1.2.0',
      scripts: { prebuild: 'gen', build: 'vite build' },
    }), 'utf8');
    const previousEnv = process.env.REMOTION_STUDIO_ROOT;
    delete process.env.REMOTION_STUDIO_ROOT;
    const starts = [];
    try {
      const ctx = fakeContext();
      ctx.cfg.installDir = root;
      assert.equal(ctx.cfg.autoStart, false, '默认配置必须是关');
      const world = RSM.create(ctx);
      world.hooks = {
        killTree: () => ({ ok: true }),
        probeHealth: async () => false,
        isPortFree: async () => true,
        runBuild: async () => ({ ok: true, results: [] }),
        startServer: async (opts) => {
          starts.push(opts.port);
          return { mode: 'owned', proc: { pid: 12345 } };
        },
      };
      await assert.rejects(() => world.ensureService({}), /autoStart 已关闭/);
      assert.equal(starts.length, 0, '默认配置下工具调用绝不能拉起服务');
      await world.serviceAction({ action: 'start' }, {});
      assert.equal(starts.length, 1, '用户显式 start 仍然必须能启动');
    } finally {
      if (previousEnv === undefined) delete process.env.REMOTION_STUDIO_ROOT;
      else process.env.REMOTION_STUDIO_ROOT = previousEnv;
    }
  });

  await test('配置页面：自动配置页签 + 控制台面板 bundle + invoke 数据面', async () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
    assert.equal(pkg.cortico.webUiClient, 'dist/webui.js');
    assert.ok((pkg.files ?? []).includes('dist'), '发布包必须带上 WebUI bundle');
    const bundlePath = join(PACKAGE_DIR, pkg.cortico.webUiClient);
    assert.ok(existsSync(bundlePath));
    const bundle = (await import(pathToFileURL(bundlePath).href)).default;
    assert.equal(typeof bundle?.panels?.control?.mount, 'function');

    const ctx = fakeContext();
    const world = RSM.create(ctx);
    const decl = world.webUi('zh');
    assert.ok(decl.config?.length >= 1, 'config 组让框架自动画出「配置」页签');
    assert.ok(decl.config.every((g) => g.owner === `world:${RSM_ID}`));
    assert.deepEqual((decl.panels ?? []).map((p) => p.id), ['control']);
    assert.equal(typeof decl.invoke, 'function');
    assert.ok(Object.keys(bundle.panels).includes('control'), 'bundle 必须提供声明过的每个面板');

    const cfg = await world.panelInvoke('control', 'config', []);
    assert.equal(cfg.port, 4380);
    assert.equal(cfg.autoBuild, true, '配置页读到的默认必须是「自动构建开」');
    const saved = await world.panelInvoke('control', 'saveConfig', [
      { port: 5599, registry: 'https://registry.npmmirror.com' },
    ]);
    assert.ok(saved.ok);
    assert.equal(saved.port, 5599);
    assert.equal(ctx.cfg.port, 5599, '保存必须写回活配置引用');
    assert.equal(world.port, 5599);
    await assert.rejects(() => world.panelInvoke('control', 'saveConfig', [{ port: 99999 }]), /1–65535/);
    await assert.rejects(() => world.panelInvoke('control', 'saveConfig', [
      { endpoint: 'https://evil.example.com/mcp' },
    ]), /回环/);
    await assert.rejects(() => world.panelInvoke('control', 'saveConfig', [{ registry: 'ftp://x' }]), /http\(s\)/);
    const state = await world.panelInvoke('control', 'state', []);
    assert.equal(state.port, 5599);
    for (const key of ['online', 'root', 'valid', 'version', 'deps', 'registry', 'endpoint', 'autoBuild', 'building']) {
      assert.ok(key in state, `state 缺 ${key}`);
    }
    const logs = await world.panelInvoke('control', 'logs', [0, 10]);
    assert.ok(Array.isArray(logs.entries) && typeof logs.lastSeq === 'number');
    await assert.rejects(() => world.panelInvoke('other', 'state', []), /未知面板/);
  });

  await test('用户可见文案：书面语体、术语统一、无装饰符号、构建不经 pnpm', () => {
    const files = [
      'src/config.mjs', 'src/tools.mjs', 'src/world.mjs', 'src/project.mjs',
      'src/process.mjs', 'src/mcp-client.mjs', 'dist/webui.js',
      'src/ENV_PROMPT.md', 'package.json',
    ];
    const all = files.map((f) => readFileSync(join(PACKAGE_DIR, f), 'utf8')).join('\n');

    // 发布前点名要求整改的口语化表述，不得回潮
    for (const phrase of [
      '全部 8 个可配项在', '工程目录（留空用默认）', '灰色按钮表示', '才会亮',
      'installDir 可以指向', '已有的 clone', '一起变', '偷偷', '白跑', '别猜',
      '撑爆', '别踩的坑', '不用等模型',
    ]) {
      assert.ok(!all.includes(phrase), `用户可见文案仍含口语化表述：${phrase}`);
    }
    // 日志与回执统一使用 [阶段] 前缀，不再混用装饰符号
    for (const bad of ['▸ ', '✗ ', '✓ ', '⚠️ ', '  ├ ', '  └ ']) {
      assert.ok(!all.includes(bad), `仍使用装饰符号：${JSON.stringify(bad)}`);
    }
    for (const tag of ['[查询]', '[下载]', '[解包]', '[合并]', '[依赖]', '[自检]', '[构建]', '[失败]']) {
      assert.ok(all.includes(tag), `缺少统一阶段前缀 ${tag}`);
    }
    const proc = readFileSync(join(PACKAGE_DIR, 'src/process.mjs'), 'utf8');
    assert.ok(!proc.includes("args: ['run', 'build']"), '构建不得再经由 pnpm run');
    assert.ok(proc.includes("detached: process.platform !== 'win32'"),
      'Windows 下服务进程不得使用 detached（会新建控制台窗口）');
    const ui = readFileSync(join(PACKAGE_DIR, 'dist/webui.js'), 'utf8');
    assert.equal((ui.match(/configDesc:/g) ?? []).length, 2, '中英文案必须同步维护');
  });

  await test('控制台面板布局：常用配置在操作之前，按钮分组且数量收敛', () => {
    const src = readFileSync(join(PACKAGE_DIR, 'dist/webui.js'), 'utf8');
    const configAt = src.indexOf('ctx.root.appendChild(configSheet.el)');
    const actionAt = src.indexOf('ctx.root.appendChild(actionSheet.el)');
    assert.ok(configAt >= 0 && actionAt >= 0, '两张卡都必须挂到 root');
    assert.ok(configAt < actionAt, '常用配置卡必须排在操作卡前面');

    assert.ok((src.match(/ui\.section\(/g) ?? []).length >= 2, '操作区要有「服务」「工程」两个分组标题');
    const buttons = (src.match(/\bbtn\(/g) ?? []).length;
    assert.ok(buttons <= 8, `按钮太多（${buttons} 个），操作区只保留必要动作`);
    for (const gone of ['btn(t.refresh', 'btn(t.startOnly']) {
      assert.ok(!src.includes(gone), `${gone} 不该再占一个按钮`);
    }
    assert.ok(src.includes('btn(t.check'), '工程组要有「检查更新」按钮');
    assert.ok(src.includes("ctx.invoke('checkUpdates'"), '检查更新必须走结构化数据面');
    assert.ok(src.includes('projectBtn.disabled = !updateAvailable'), '查到新版前更新按钮必须禁用');
    assert.ok(src.includes('ui.checkbox(t.skipBuild'), '「仅启动」要改成跳过构建勾选项');
    assert.ok(src.includes('projectBtn.textContent'), '安装/更新必须合成一个动态按钮');
    assert.ok(src.includes('syncButtons(s)'), '按钮禁用态要跟着状态刷新');
    assert.ok(src.includes('resultBar.appendChild(resultBtn)'), '「完整输出」要跟回执放在一起');
    assert.ok(src.includes('logBar.appendChild(clearLogBtn)'), '「清空显示」要归到日志卡');
  });

  await test('控制台面板行为：mount 后卡片顺序、按钮禁用态、安装/更新切换与跳过构建', async () => {
    const state = {
      online: false, building: false, mode: 'none', port: 4380,
      endpoint: 'http://127.0.0.1:4380/mcp', root: 'D:/demo',
      valid: false, deps: false, version: null,
      registry: 'https://registry.npmmirror.com', autoBuild: true, envOverride: false,
    };
    const h = panelHarness(state);
    const bundle = (await import(pathToFileURL(join(PACKAGE_DIR, 'dist/webui.js')).href)).default;
    await bundle.panels.control.mount(h.ctx);
    await flush();

    assert.deepEqual(
      h.ctx.root.children.map((n) => n.tag),
      ['sheet:运行状态', 'sheet:常用配置', 'sheet:操作', 'sheet:运行日志'],
      '卡片顺序必须是 状态 → 常用配置 → 操作 → 日志',
    );
    assert.deepEqual(h.sections, ['服务', '工程'], '操作区只分两组');
    assert.equal(h.buttons.length, 8, '全页 8 个按钮（含新增的「检查更新」）');

    const byLabel = (label) => h.buttons.find((b) => b.label === label);
    assert.equal(byLabel('启动服务').disabled, false, '离线时启动应可点');
    assert.equal(byLabel('停止服务').disabled, true, '没由本插件启动时不应能停');
    assert.equal(byLabel('打开编辑器').disabled, true, '离线时编辑器不该能打开');
    assert.equal(byLabel('安装工程').textContent, '安装工程', '工程未装好时只显示安装');
    assert.ok(byLabel('停止服务').title.length > 0, '禁用按钮要给出原因');
    const autoStartCb = h.checkboxes.find((c) => c.label.includes('自动启动'));
    assert.ok(autoStartCb, '常用配置里要有 autoStart 开关');
    assert.equal(autoStartCb.checked, false, 'autoStart 默认关，面板不该预勾选');

    // label.check 是 inline-flex 且无外边距：两个开关必须同处一个纵向容器，
    // 否则会并排贴在一行（真实浏览器复现过）。这里锁住结构，避免回潮。
    const cfgBody = h.ctx.root.children[1].children[0];
    assert.ok(
      !cfgBody.children.some((c) => String(c.tag).startsWith('checkbox:')),
      '复选框不得直挂 sheetbody，否则两个开关会挤在同一行',
    );
    const stack = cfgBody.children.find((c) => c.tag === 'div' && c.style.display === 'flex');
    assert.ok(stack, '两个复选框应包在一个 flex 容器里');
    assert.equal(stack.style.flexDirection, 'column', '容器必须是纵向排列');
    assert.equal(stack.children.length, 2, '两个开关都放进该容器');

    state.online = true;
    state.mode = 'running';
    state.valid = true;
    state.deps = true;
    state.version = '1.2.0';
    h.refreshTick();
    await flush();
    assert.equal(byLabel('启动服务').disabled, true, '在线时不应重复启动');
    assert.equal(byLabel('停止服务').disabled, false, '本插件启动的服务应能停');
    assert.equal(byLabel('打开编辑器').disabled, false, '在线时编辑器可打开');
    assert.equal(byLabel('安装工程').textContent, '更新工程', '工程齐备后自动切成更新');

    state.online = false;
    state.mode = 'none';
    h.refreshTick();
    await flush();
    const skip = h.checkboxes.find((c) => c.label.includes('跳过构建'));
    assert.ok(skip, '跳过构建必须是勾选项而不是独立按钮');
    skip.checked = true;
    byLabel('启动服务').onClick();
    await flush();
    assert.ok(
      h.calls.some((c) => c.method === 'service' && c.args?.[0] === 'start' && c.args?.[1]?.build === false),
      '勾选跳过后点启动必须传 build:false',
    );

    // 版本门槛：没检查过就禁用更新；查到新版才解锁；无新版或检查失败都保持锁定
    state.valid = true;
    state.deps = true;
    state.version = '1.2.0';
    h.refreshTick();
    await flush();
    assert.equal(byLabel('安装工程').textContent, '更新工程', '工程齐备后显示更新');
    assert.equal(byLabel('安装工程').disabled, true, '没检查过版本时更新必须禁用');
    assert.ok(byLabel('安装工程').title.includes('检查更新'), '禁用原因要点名「检查更新」');
    assert.ok(h.kvRows.some((r) => r.k === '当前版本' && r.v === '1.2.0'), '版本行要显示当前版本');

    byLabel('检查更新').onClick();
    await flush();
    assert.equal(byLabel('安装工程').disabled, false, '查到新版后更新必须解锁');
    assert.ok(h.kvRows.some((r) => r.k === '最新版本' && r.v === '1.3.0'), '版本行要显示最新版本');
    assert.ok(h.calls.some((c) => c.method === 'checkUpdates'), '检查更新要走结构化 invoke');

    h.setCheckResult({ local: '1.2.0', latest: '1.2.0', hasNewer: false });
    byLabel('检查更新').onClick();
    await flush();
    assert.equal(byLabel('安装工程').disabled, true, '已是最新时更新必须保持禁用');

    h.setCheckError(new Error('registry timeout'));
    byLabel('检查更新').onClick();
    await flush();
    assert.equal(byLabel('安装工程').disabled, true, '检查失败时更新必须保持禁用');
  });

  await test('服务归属记录：写入/校验/清理，端口或路径不符、进程已死都不认领', async () => {
    const root = join(makeScratch(), 'owner-project');
    mkdirSync(root, { recursive: true });
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port: 5599 }));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      assert.equal(readOwner(root), null);
      const rec = writeOwner(root, { pid: dummy.pid, port: 5599 });
      assert.ok(rec && rec.pid === dummy.pid, '启动成功后必须写下归属记录');
      assert.ok(existsSync(ownerPath(root)), '记录落在 <工程>/data/rsm-server.json');
      assert.equal(pidAlive(dummy.pid), true);

      const claimed = await claimOwned(root, { port: 5599, origin });
      assert.equal(claimed?.pid, dummy.pid, '本插件写下的记录应能认领');
      assert.equal(claimed?.adopted, true);

      assert.equal(await claimOwned(root, { port: 4380, origin }), null, '端口不符不能认领');
      assert.equal(await claimOwned(join(root, '..'), { port: 5599, origin }), null, '工程路径不符不能认领');
      assert.equal(clearOwner(root, dummy.pid + 1), false, 'pid 不符不能删掉新服务的记录');
      assert.equal(clearOwner(root, dummy.pid), true);
      assert.equal(readOwner(root), null);

      writeOwner(root, { pid: 999999, port: 5599 });
      assert.equal(await claimOwned(root, { port: 5599, origin }), null, '进程已死不能认领');
      assert.equal(readOwner(root), null, '死进程的记录应被清掉');
    } finally {
      try { dummy.kill(); } catch { /* ignore */ }
      await new Promise((done) => server.close(done));
    }
  });

  await test('killTree：同步等待完成、接受纯 pid 句柄、无效句柄不抛错', () => {
    const recorded = [];
    const result = killTree({ pid: 424242 }, {
      spawnImpl: (exe, args, opts) => {
        recorded.push({ exe, args, opts });
        return { status: 0 };
      },
    });
    assert.equal(result.ok, true);
    if (process.platform === 'win32') {
      assert.equal(recorded.length, 1, 'Windows 必须走 taskkill /T /F');
      assert.ok(recorded[0].args.includes('/T') && recorded[0].args.includes('/F'));
      assert.equal(recorded[0].opts.timeout, 8000, 'stop() 必须同步等 kill 完成，不能异步 fire-and-forget');
    }
    assert.equal(killTree(null).ok, false);
    assert.equal(killTree({ pid: 0 }).ok, false);
    assert.equal(killTree({ pid: 1, killed: true }).ok, true);
  });

  await test('跨实例认领：挂载后来源为已接管，stop 能停且清记录', async () => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port: server.address().port }));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const port = server.address().port;
    const root = join(makeScratch(), 'adopt-project');
    mkdirSync(join(root, 'server'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'remotion-studio-mcp', version: '1.2.0', scripts: {},
    }), 'utf8');
    const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeOwner(root, { pid: dummy.pid, port });
    try {
      const ctx = fakeContext();
      ctx.cfg.installDir = root;
      ctx.cfg.port = port;
      const world = RSM.create(ctx);
      let killed = null;
      world.hooks = {
        probeHealth: async () => true,
        isPortFree: async () => false,
        runBuild: async () => ({ ok: true, results: [] }),
        startServer: async () => ({ mode: 'owned', proc: { pid: dummy.pid } }),
        killTree: (child) => { killed = child.pid; return { ok: true }; },
      };
      await world.start(null);
      assert.equal(world.mode, 'running', '认领后状态应是 running，停止按钮才会亮');
      assert.equal(world.ownedSource, 'adopted');
      const state = await world.panelState();
      assert.equal(state.ownedSource, 'adopted', '面板要能显示「已接管」');

      const out = await world.serviceAction({ action: 'stop' }, {});
      assert.equal(killed, dummy.pid, 'stop 必须真的调用同步 kill');
      assert.equal(world.owned, null);
      assert.equal(readOwner(root), null, '停止后归属记录必须清掉');
      assert.match(out, /服务已终止/);
      await world.stop();
    } finally {
      try { dummy.kill(); } catch { /* ignore */ }
      await new Promise((done) => server.close(done));
    }
  });

  await test('依赖脚本由扩展代跑：仅 Windows 生效，隐藏窗口、不经 pnpm、单项失败不中断', async () => {
    // 该绕行只为消除 Windows 的 cmd 弹窗；macOS / Linux 继续交由 pnpm 执行脚本
    assert.equal(needsScriptRunner('win32'), true);
    assert.equal(needsScriptRunner('darwin'), false);
    assert.equal(needsScriptRunner('linux'), false);

    const root = join(makeScratch(), 'script-proj');
    const writePkg = (dir, data) => {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify(data), 'utf8');
    };
    writePkg('.', { name: 'proj-root', scripts: { postinstall: 'node root.js' } });
    writePkg('node_modules/dep-a', { name: 'dep-a', scripts: { postinstall: 'node a.js' } });
    writePkg('node_modules/@scope/dep-b', { name: '@scope/dep-b', scripts: { install: 'node b.js', postinstall: 'node fail.js' } });
    writePkg('node_modules/no-scripts', { name: 'no-scripts', scripts: { build: 'vite build' } });

    const targets = collectInstallScripts(root);
    assert.deepEqual(targets.map((t) => t.name).sort(), ['@scope/dep-b', 'dep-a', 'proj-root'],
      '只收集声明了 preinstall / install / postinstall 的包（含 scope 与根工程）');
    assert.equal(targets.find((t) => t.name === '@scope/dep-b').stages.length, 2);

    const calls = [];
    const spawnImpl = (file, args, opts) => {
      calls.push({ file, args, opts });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('exit', String(args[args.length - 1]).includes('fail.js') ? 1 : 0);
      });
      return child;
    };
    const logs = [];
    const result = await runInstallScripts(root, { spawnImpl, onLog: (s, c) => logs.push(`${s}:${c}`) });

    assert.equal(result.ran, 4, '三项声明里共 4 个脚本阶段');
    assert.deepEqual(result.failed, ['@scope/dep-b postinstall'], '失败项要记录但不抛出');
    for (const call of calls) {
      assert.equal(call.opts.windowsHide, true, '代跑脚本必须隐藏窗口（pnpm 自跑时缺这个标志才会弹 cmd）');
      if (process.platform === 'win32') {
        assert.match(call.file, /cmd(\.exe)?$/i);
        assert.deepEqual(call.args.slice(0, 3), ['/d', '/s', '/c'], '必须走 cmd /d /s /c，与 pnpm 生成的命令行一致');
      }
      assert.ok(call.opts.cwd.startsWith(root), '脚本必须在所属包目录内执行');
      assert.match(String(call.opts.env.PATH), /node_modules[\\/]\.bin/, 'PATH 需包含工程 .bin');
      assert.equal(call.opts.env.INIT_CWD, root);
    }
    const depA = calls.find((c) => c.opts.cwd.endsWith('dep-a'));
    assert.equal(depA.opts.env.npm_lifecycle_event, 'postinstall');
    assert.ok(logs.some((l) => l.includes('依赖脚本') || l.includes('[脚本]')), '每一项都要落日志');
    assert.ok(logs.some((l) => l.includes('退出码 1')), '失败项要在日志里说明');
  });

  await test('首次安装全链路：本地 registry → tgz → 合并 → pnpm → 落配置，且不碰用户数据', async () => {
    const tgz = gzipSync(makeTar([
      { name: 'package/', type: 'dir' },
      { name: 'package/package.json', content: JSON.stringify({ name: 'remotion-studio-mcp', version: '1.2.0', scripts: { prebuild: 'gen', build: 'vite build' } }) },
      { name: 'package/server/index.ts', content: 'export const ok = 1;' },
      { name: 'package/data/keep.json', content: 'PACKAGE DATA' },
      { name: 'package/plugins/_example-tool/a.txt', content: 'BUILTIN' },
      { name: 'package/CHANGELOG.md', content: '## [1.2.0]\n- 新增' },
    ]));
    let server;
    const base = await new Promise((done) => {
      server = createHttpServer((req, res) => {
        if (req.url === '/remotion-studio-mcp/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ version: '1.2.0', dist: { tarball: `http://127.0.0.1:${server.address().port}/pkg.tgz` } }));
        } else if (req.url === '/pkg.tgz') {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(tgz);
        } else { res.writeHead(404); res.end(); }
      });
      server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`));
    });
    const previous = process.env.CORTICO_PNPM_CJS;
    process.env.CORTICO_PNPM_CJS = 'C:\\fake\\pnpm.cjs';
    const recorded = [];
    const mockSpawn = (exe, args, opts) => {
      recorded.push({ exe, args, opts });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 4343;
      child.killed = false;
      process.nextTick(() => { child.stdout.end(); child.stderr.end(); child.emit('exit', 0); });
      return child;
    };
    try {
      const cfg = RSM.defaults();
      cfg.installDir = '';                     // 模拟「别人机器上第一次装」
      const dest = join(makeScratch(), 'install-e2e');
      writeUnder(dest, 'data/keep.json', 'USER DATA');
      writeUnder(dest, 'plugins/my-plugin/index.js', 'MY PLUGIN');
      // 模拟 pnpm 的虚拟存储布局，让合并规则与运行时自检都能被覆盖到
      mkdirSync(join(dest, 'node_modules/.pnpm/@remotion+compositor-win32-x64-msvc@4.0.538'), { recursive: true });
      const persisted = [];
      const persist = (patch) => { persisted.push(patch); Object.assign(cfg, patch); };
      const logs = [];
      let probed = false;
      const out = await installProject({
        cfg, dir: dest, registry: base, persist,
        onLog: (stream, chunk) => logs.push(`${stream}:${chunk}`),
        spawnImpl: mockSpawn,
        probeImpl: () => { probed = true; return Promise.resolve({ code: 0, out: '0.28.2\n', err: '' }); },
      });
      assert.match(out, /工程已就绪/);
      assert.match(out, /版本 1\.2\.0/);
      if (process.platform === 'win32') {
        assert.ok(recorded.some((r) => r.args.includes('--ignore-scripts')),
          'pnpm 不得自行执行依赖脚本：它 spawn 的 cmd.exe 不带 windowsHide，Windows 下会弹控制台窗口');
      } else {
        assert.ok(recorded.every((r) => !r.args.includes('--ignore-scripts')),
          '非 Windows 无需绕行，依赖脚本仍由 pnpm 执行');
      }
      assert.equal(readFileSync(join(dest, 'server', 'index.ts'), 'utf8'), 'export const ok = 1;');
      assert.equal(readFileSync(join(dest, 'data', 'keep.json'), 'utf8'), 'USER DATA');
      assert.equal(readFileSync(join(dest, 'plugins', 'my-plugin', 'index.js'), 'utf8'), 'MY PLUGIN');
      assert.ok(existsSync(join(dest, 'plugins', '_example-tool', 'a.txt')));
      assert.ok(persisted.some((p) => p.installDir === dest), '显式传 dir 后必须同步 installDir');
      assert.equal(projectStatus(cfg).root, dest);
      assert.equal(projectStatus(cfg).version, '1.2.0');
      assert.ok(recorded.some((r) => r.args.includes('--registry') && r.args.includes(base)));
      const installRun = recorded.find((r) => r.args.includes('install'));
      assert.ok(installRun, '应调用 pnpm install');
      assert.equal(installRun.opts.env.CI, 'true');
      assert.equal(installRun.opts.env.pnpm_config_dangerously_allow_all_builds, 'true',
        '仍保留放行配置，避免 pnpm 把被跳过的构建脚本判成错误退出');
      assert.equal(installRun.opts.env.pnpm_config_strict_dep_builds, 'false',
        '旧版 pnpm 不认 allow-all-builds 时，仍要把硬失败降级为警告');
      assert.ok(probed, '装完依赖必须做一次运行时自检，而不是只看目录在不在');
      assert.match(out, /运行时自检：esbuild 0\.28\.2 二进制可用/);
      assert.match(out, /Remotion 原生组件 .* 已落地/);
      assert.match(out, /Chrome Headless Shell/);
      assert.doesNotMatch(out, /approve-builds/, '回执不该再让用户去做非交互下做不到的操作');
      // 每一步都要有阶段日志，面板才不会看起来「停在下载」
      for (const phase of ['查询', '下载', '已下载', '解出', '合并', '安装依赖', '运行时自检']) {
        assert.ok(logs.some((l) => l.includes(phase)), `日志流缺少阶段「${phase}」`);
      }
    } finally {
      server.close();
      if (previous === undefined) delete process.env.CORTICO_PNPM_CJS;
      else process.env.CORTICO_PNPM_CJS = previous;
    }
  });

  if (ARGS.has('--live')) {
    await test('live: registry latest 与真实 /mcp 协议', async () => {
      const meta = await fetchPackageMeta('https://registry.npmmirror.com', 'remotion-studio-mcp', 'latest');
      assert.ok(meta.version && meta.tarball);
      console.log(`      registry latest = ${meta.version}`);
      const livePort = Number(process.env.RSM_LIVE_PORT) || RSM_DEFAULTS.port;
      const endpoint = `http://127.0.0.1:${livePort}/mcp`;
      let healthy = false;
      try {
        const res = await fetch(`http://127.0.0.1:${livePort}/api/health`, { signal: AbortSignal.timeout(1500) });
        healthy = res.ok;
      } catch { healthy = false; }
      if (!healthy) {
        console.log(`      端口 ${livePort} 上没有服务，跳过 /mcp 实测（可用 RSM_LIVE_PORT 指定别的端口）`);
        return;
      }
      const init = await initialize(endpoint);
      assert.ok(init.serverInfo?.name);
      const tools = await listTools(endpoint);
      assert.deepEqual(tools.map((t) => t.name).sort(), [...CORE_TOOL_NAMES].sort(), '默认门面模式应恰好 4 个工具');
      const guide = await callTool(endpoint, 'start_guide', {}, { timeoutMs: 30000 });
      assert.ok(guide.text.length > 100);
      console.log(`      /mcp 实测通过：${tools.length} 个门面工具，start_guide 返回 ${guide.text.length} 字`);
    });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过${ARGS.has('--live') ? '（含 live）' : ''}`);
  if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ } }
  if (failed.length) {
    for (const item of failed) console.error(`  ✗ ${item.name}: ${item.error?.stack ?? item.error}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
