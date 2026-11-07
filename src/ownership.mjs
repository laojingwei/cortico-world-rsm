/**
 * 服务归属记录。
 *
 * 解决两件事：
 *  1. Core 重启后，上一次由本插件拉起、父进程已退出（detached）的服务要能被新实例**认领并停止**；
 *  2. 绝不能把端口上用户自己或别的服务启动的进程误当成「本插件的」而杀掉。
 *
 * 记录落在 <工程>/data/rsm-server.json —— `data/` 在 UPDATE_KEEP 里，安装/更新工程都不会碰它。
 * 认领时做四重校验：记录是本插件写的、工程与端口与当前配置一致、PID 进程仍在、
 * /api/health 回应且回执里的 port 与记录一致。任何一条不满足都返回 null。
 *
 * 只写 PID 这类本机状态，不含任何密钥。纯 Node 内置，零依赖。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OWNER_FILE = 'data/rsm-server.json';
const OWNER_TAG = 'cortico-world-rsm';

export function ownerPath(root) {
  return join(resolve(root), OWNER_FILE);
}

/** 只在 startServer 成功返回后调用；pid 无效时不写，免得留下认领不了的脏记录。 */
export function writeOwner(root, { pid, port, corePid = process.pid, startedAt = Date.now() }) {
  const pidNum = Number(pid);
  const portNum = Number(port);
  if (!Number.isInteger(pidNum) || pidNum <= 0) return null;
  if (!Number.isInteger(portNum) || portNum <= 0) return null;
  const record = {
    tag: OWNER_TAG,
    pid: pidNum,
    port: portNum,
    root: resolve(root),
    corePid: Number(corePid),
    startedAt,
    token: randomUUID(),
  };
  try {
    mkdirSync(join(resolve(root), 'data'), { recursive: true });
    writeFileSync(ownerPath(root), JSON.stringify(record, null, 2), 'utf8');
    return record;
  } catch {
    return null;
  }
}

export function readOwner(root) {
  try {
    const path = ownerPath(root);
    if (!existsSync(path)) return null;
    const rec = JSON.parse(readFileSync(path, 'utf8'));
    if (rec?.tag !== OWNER_TAG) return null;
    if (!Number.isInteger(rec.pid) || rec.pid <= 0) return null;
    if (!Number.isInteger(rec.port) || rec.port <= 0) return null;
    if (typeof rec.root !== 'string') return null;
    return rec;
  } catch {
    return null;
  }
}

/** expectedPid 防止「旧进程退出」把刚启动的新服务记录删掉。 */
export function clearOwner(root, expectedPid) {
  const rec = readOwner(root);
  if (!rec) return false;
  if (expectedPid && rec.pid !== Number(expectedPid)) return false;
  try {
    rmSync(ownerPath(root), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** signal=0 只探测进程是否存在，不真的发信号；Node 内置，跨平台。 */
export function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 尝试认领上一次 Core 留下的服务。返回 { pid, adopted, startedAt } 或 null。
 * 只读本地文件 + 一次本机 health 请求，不启动、不停止任何进程。
 */
export async function claimOwned(root, { port, origin }) {
  const rec = readOwner(root);
  if (!rec) return null;
  if (resolve(rec.root) !== resolve(root)) return null;
  if (rec.port !== Number(port)) return null;
  if (!pidAlive(rec.pid)) {
    clearOwner(root, rec.pid);
    return null;
  }
  try {
    const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json();
    if (Number(body?.port) !== Number(port)) return null;
  } catch {
    return null;
  }
  return { pid: rec.pid, adopted: true, startedAt: rec.startedAt };
}
