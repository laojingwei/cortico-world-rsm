/**
 * 零依赖的 npm tarball 读取：registry 元数据 → fetch tgz → gunzip → tar 解析。
 *
 * 为什么不复用 launcher 的 `npm pack` + 系统 `tar`：
 * Coopanion 的 Core 是 `ELECTRON_RUN_AS_NODE=1` fork 出来的子进程，随包只带 pnpm 和 shim，
 * **不附带 Node/npm**（resources/app/app/shims/node.cmd 注释直说 "The app ships no Node"）。
 * 别人的机器上既可能没有 npm，也可能没有能处理 `C://...` 的 tar。用内置 fetch/zlib/fs 就没有这些前提。
 *
 * 支持 ustar（prefix 字段）、GNU longname（typeflag L）、PAX path（typeflag x）；
 * 不落地符号链接/硬链接（npm 包里几乎不出现，落地反而有越权风险）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

const BLOCK = 512;
const DEFAULT_FALLBACK_REGISTRY = 'https://registry.npmmirror.com';

function cstr(buf) {
  return buf.toString('utf8').replace(/\0[\s\S]*$/, '');
}

function octalSize(buf) {
  const raw = buf.toString('ascii').replace(/[^0-7]/g, '');
  return raw ? Number.parseInt(raw, 8) || 0 : 0;
}

/**
 * PAX 记录形如 `"39 path=package/启动编辑器.bat\n"`。只取 path。
 *
 * 前缀数字是**整条记录的字节数**（含数字本身、空格、keyword=value 和结尾换行）。
 * 必须按 Buffer 字节偏移推进：中文路径 UTF-8 下 1 字 = 3 字节，用 JS 字符串下标切
 * 会把下一条记录（`19 mtime=...`）混进 path，写出带换行的非法文件名 —— npm 包里
 * 有中文文件名时（这个工程就有「启动编辑器.bat」）会直接让解包抛 ENOENT。
 */
function parsePaxPath(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let cursor = 0;
  let path = null;
  while (cursor < buf.length) {
    const space = buf.indexOf(0x20, cursor);
    if (space < 0) break;
    const len = Number.parseInt(buf.subarray(cursor, space).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0 || cursor + len > buf.length) break;
    const record = buf.subarray(cursor, cursor + len).toString('utf8');
    const eq = record.indexOf('path=');
    if (/^\d+ path=/.test(record) && eq >= 0) {
      path = record.slice(eq + 5).replace(/\n$/, '');
    }
    cursor += len;
  }
  return path;
}

/**
 * 外部 signal（宿主取消）与超时都要生效。原来 `signal ?? timeout` 在模型走工具调用
 * 传了 ctx.signal 时会**完全丢掉超时保护**，卡住就永远不返回。
 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  // 旧运行时没有 AbortSignal.any：手动合并，超时一样不能丢
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}

/** 迭代 tar 成员；`data` 是 payload 切片，调用方决定要不要落盘。 */
export function* tarEntries(tarBuffer) {
  let offset = 0;
  let longName = null;
  let paxPath = null;
  while (offset + BLOCK <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + BLOCK);
    let empty = true;
    for (let i = 0; i < BLOCK; i += 1) {
      if (header[i] !== 0) { empty = false; break; }
    }
    if (empty) break;

    const name = cstr(header.subarray(0, 100));
    const prefix = cstr(header.subarray(345, 500));
    const size = octalSize(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + BLOCK;
    const data = tarBuffer.subarray(dataStart, Math.min(dataStart + size, tarBuffer.length));

    let full = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    if (longName) { full = longName; longName = null; }

    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0[\s\S]*$/, '').trim();
    } else if (type === 'x') {
      // 局部 PAX 头：只覆盖紧跟的下一个成员
      paxPath = parsePaxPath(data);
    } else if (type === 'g') {
      // 全局 PAX 头对整个归档生效，npm 包里不出现；不能拿它的 path 覆盖单个文件
    } else {
      yield { name: full, type, size, data };
      paxPath = null;
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
}

/** 从 tgz 里只读一个成员（CHANGELOG.md 之类），不解整包。 */
export function readTarMember(tgzBuffer, wantedName) {
  const wanted = String(wantedName).replace(/^\.\//, '');
  for (const entry of tarEntries(gunzipSync(tgzBuffer))) {
    if (!entry.name) continue;
    const normalized = entry.name.replace(/^\.\//, '');
    if (normalized === wanted || normalized.endsWith(`/${wanted}`)) {
      return entry.data.toString('utf8');
    }
  }
  return null;
}

/**
 * 安全地把相对路径拼到 destDir 下。拒绝绝对路径、盘符、`..` 段和空段，
 * 防止恶意 tarball 写到目标目录之外。
 */
export function safeJoin(destDir, relative) {
  const cleaned = String(relative).replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = cleaned.split('/');
  if (!cleaned || /^[A-Za-z]:/.test(cleaned) || cleaned.startsWith('/')) return null;
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  const target = resolve(join(destDir, ...segments));
  const root = resolve(destDir);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/** 去掉 npm 包统一的第一层 `package/` 前缀。 */
function stripFirst(name, count) {
  if (count <= 0) return name;
  const parts = String(name).replace(/^\.\//, '').split('/').filter(Boolean);
  return parts.slice(count).join('/');
}

/**
 * 解包到目录。返回落地清单，便于日志与自检断言。
 * `stripComponents` 默认 1（npm tarball 的根是 `package/`）。
 */
export function extractTarball(tgzBuffer, destDir, { stripComponents = 1 } = {}) {
  const written = [];
  const skipped = [];
  mkdirSync(destDir, { recursive: true });
  for (const entry of tarEntries(gunzipSync(tgzBuffer))) {
    const relative = stripFirst(entry.name, stripComponents);
    if (!relative) continue;
    // PAX/GNU 头解析异常时可能混进换行等控制字符：跳过该成员，而不是让 writeFileSync
    // 抛 ENOENT 把整个安装中断（真实包里出现过「启动编辑器.bat\n19 mtime=4」）。
    if (/[\u0000-\u001f]/.test(relative)) { skipped.push(entry.name); continue; }
    const target = safeJoin(destDir, relative);
    if (!target) { skipped.push(entry.name); continue; }
    if (entry.type === '5') {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (entry.type !== '0' && entry.type !== '\0') {
      // 符号链接 / 硬链接 / 设备文件：不落地，避免跳出目标目录
      skipped.push(entry.name);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
    written.push(relative);
  }
  return { written, skipped };
}

export function normalizeRegistry(registry) {
  const raw = String(registry || DEFAULT_FALLBACK_REGISTRY).trim();
  if (!/^https?:\/\//i.test(raw)) throw new Error(`下载源必须是 http(s) 地址：${raw}`);
  return raw.replace(/\/+$/, '');
}

function scopedPath(pkg) {
  // scoped 包要保留 @scope%2fname 或 @scope/name 的形式，registry 两种都接受
  return encodeURIComponent(pkg).replace(/%40/g, '@');
}

/** 取单版本元数据；version 省略时用 latest。返回 { version, tarball }。 */
export async function fetchPackageMeta(registry, pkg, version = 'latest', { signal, timeoutMs = 10000 } = {}) {
  const base = normalizeRegistry(registry);
  const url = `${base}/${scopedPath(pkg)}/${encodeURIComponent(version || 'latest')}`;
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: withTimeout(signal, timeoutMs),
  });
  if (!res.ok) throw new Error(`registry 元数据 HTTP ${res.status}：${url}`);
  const meta = await res.json();
  const plain = pkg.includes('/') ? pkg.slice(pkg.lastIndexOf('/') + 1) : pkg;
  // fallback 路径保留 scoped 包里的 `/`：registry 认 `@scope/name/-/name-1.0.0.tgz`
  const tarball = meta?.dist?.tarball
    || `${base}/${pkg}/-/${plain}-${meta?.version ?? version}.tgz`;
  return { version: String(meta?.version ?? version), tarball: String(tarball), meta };
}

export async function fetchTarball(url, { signal, timeoutMs = 120000 } = {}) {
  const res = await fetch(url, {
    headers: { accept: 'application/octet-stream' },
    signal: withTimeout(signal, timeoutMs),
  });
  if (!res.ok) throw new Error(`下载 tarball HTTP ${res.status}：${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** `a` 是否比 `b` 新；只处理具体版本 `1.2.3` / `1.2.3-beta.1`，不处理范围。 */
export function isNewerVersion(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const parse = (value) => {
    const [core, pre] = value.trim().replace(/^v/i, '').split('-');
    const nums = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
    return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre: pre ?? '' };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] > right.nums[i];
  }
  if (left.pre === right.pre) return false;
  if (left.pre === '') return true;   // 正式版比预发布版新
  if (right.pre === '') return false;
  return left.pre > right.pre;
}
