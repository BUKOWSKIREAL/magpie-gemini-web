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
