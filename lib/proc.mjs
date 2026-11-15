import fs from 'node:fs';

// Where /proc is read. Tests point it at a fake tree.
let procRoot = '/proc';

export function setProcRoot(root) {
  procRoot = root || '/proc';
}

// zombie: /proc says the PID has exited and waits only to be reaped (Z), or is
// being torn down (X). A process whose parent ended is adopted by PID 1, and in
// a container without an init (magpie itself as PID 1) nothing may ever reap
// it, while kill(pid, 0) still succeeds on it. Off Linux there is no /proc and
// an unreadable entry is not evidence of exit: both answer false.
export function zombie(pid) {
  let stat;
  try { stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8'); } catch { return false; }
  // The command name, in parentheses, can hold spaces and ')'; the state follows the last ')'.
  const state = stat.slice(stat.lastIndexOf(')') + 1).trim()[0];
  return state === 'Z' || state === 'X';
}

// processAlive: a PID that can still run. EPERM means it exists under another
// user; a zombie has exited.
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (err) { if (err.code !== 'EPERM') return false; }
  return !zombie(pid);
}

// processExists: as processAlive, but a failed probe other than ESRCH counts as
// alive, for callers that must not reclaim what they cannot inspect.
export function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') return false; }
  return !zombie(pid);
}

/**
 * Returns whether the current process appears to be running inside a container.
 */
export function isContainerEnv({
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
} = {}) {
  const override = String(env?.DOCKER_CONTAINER || '').trim().toLowerCase();
  if (override === '1' || override === 'true') return true;
  if (override === '0' || override === 'false') return false;
  if (String(env?.container || '').trim()) return true;
  if (String(env?.KUBERNETES_SERVICE_HOST || '').trim()) return true;
  if (platform !== 'linux') return false;
  try {
    if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) return true;
  } catch {}
  try {
    const cgroup = readFileSync('/proc/1/cgroup', 'utf8');
    if (/(?:docker|containerd|kubepods|podman|lxc)/i.test(cgroup)) return true;
  } catch {}
  return false;
}

/**
 * Returns whether a proxy URL points to loopback (127.0.0.1, localhost, or ::1).
 */
export function isLoopbackProxy(proxy) {
  const raw = String(proxy || '').trim();
  if (!raw) return false;
  try {
    const { hostname } = new URL(raw);
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Returns a Docker-specific hint when a loopback proxy URL is used inside a container.
 */
export function dockerProxyHint(proxy, opts = {}) {
  const inContainer = opts.container ?? isContainerEnv(opts);
  if (!inContainer || !isLoopbackProxy(proxy)) return '';
  return '检测到当前运行在容器环境中，容器内的 127.0.0.1/localhost 指向容器自身而非宿主机代理；若代理在宿主机上，请改用 http://host.docker.internal:<端口>（Linux Docker 需添加 --add-host=host.docker.internal:host-gateway）、宿主机局域网 IP，或使用 --network host。';
}
