import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setProcRoot } from '../lib/proc.mjs';
import {
  ensureStudioConfig,
  binaryPath,
  studioProcessStarted
} from '../lib/studio-native.mjs';
import { supportsOfficialStudio } from '../lib/studio-upstream.mjs';
import {
  acquireStudioUse,
  holdStudioResponse,
  updateStudioAutomatically
} from '../lib/studio-updates.mjs';
import { officialArchive } from './helpers/studio-official.mjs';

// ---------------------------------------------------------------------------
// 1. Finite-State Exhaustive BFS Model Checker (docs/models/studio-lock-protocol.tla)
// ---------------------------------------------------------------------------

function cloneState(s) {
  return {
    procState: [...s.procState],
    procGen: [...s.procGen],
    usePhase: [...s.usePhase],
    maintPhase: [...s.maintPhase],
    useClaim: s.useClaim.map(c => (c ? { ...c } : null)),
    maintClaim: s.maintClaim.map(c => (c ? { ...c } : null)),
    sharedGate: s.sharedGate ? { ...s.sharedGate } : null,
    cleaner: s.cleaner.map(c => (c ? { ...c } : null))
  };
}

function serializeState(s) {
  return JSON.stringify(s);
}

function runLockModel(config = {}) {
  const {
    uniqueFilenames = true,
    contentCheckedUnlink = true,
    usePostWriteRecheck = true,
    maintUseCheck = true,
    maintPeerRecheck = true,
    maxGen = 2,
    maxStates = 150000
  } = config;

  const Hosts = [0, 1];
  const init = {
    procState: ['alive', 'alive'],
    procGen: [1, 1],
    usePhase: ['idle', 'idle'],
    maintPhase: ['idle', 'idle'],
    useClaim: [null, null],
    maintClaim: [null, null],
    sharedGate: null,
    cleaner: [null, null]
  };

  function isLiveOwner(s, claim) {
    if (!claim) return false;
    return s.procState[claim.pid] === 'alive' && s.procGen[claim.pid] === claim.gen;
  }

  function hasLiveUse(s) {
    return Hosts.some(h => isLiveOwner(s, s.useClaim[h]));
  }

  function visibleMaintClaims(s, excludeHost = -1) {
    if (uniqueFilenames) {
      return Hosts.filter(h => h !== excludeHost && s.maintClaim[h] !== null).map(h => ({
        slot: `unique:${h}`,
        claim: s.maintClaim[h]
      }));
    }
    if (!s.sharedGate) return [];
    if (excludeHost >= 0 && s.sharedGate.pid === excludeHost && s.sharedGate.gen === s.procGen[excludeHost]) {
      return [];
    }
    return [{ slot: 'shared', claim: s.sharedGate }];
  }

  function anyLiveMaint(s, excludeHost = -1) {
    return visibleMaintClaims(s, excludeHost).some(entry => isLiveOwner(s, entry.claim));
  }

  function checkInvariants(s) {
    const useHeldHosts = Hosts.filter(h => s.usePhase[h] === 'held');
    const maintHeldHosts = Hosts.filter(h => s.maintPhase[h] === 'held');

    if (useHeldHosts.length > 0 && maintHeldHosts.length > 0) {
      return `MutualExclusion violated: useHeld=${JSON.stringify(useHeldHosts)} maintHeld=${JSON.stringify(maintHeldHosts)}`;
    }
    if (maintHeldHosts.length > 1) {
      return `SingleMaintenance violated: maintHeld=${JSON.stringify(maintHeldHosts)}`;
    }
    for (const h of useHeldHosts) {
      if (!isLiveOwner(s, s.useClaim[h])) {
        return `NoLiveOwnerUnlinked (use) violated for host ${h}`;
      }
    }
    for (const h of maintHeldHosts) {
      const claimOnDisk = uniqueFilenames ? s.maintClaim[h] : s.sharedGate;
      if (!claimOnDisk || claimOnDisk.pid !== h || claimOnDisk.gen !== s.procGen[h] || !isLiveOwner(s, claimOnDisk)) {
        return `NoLiveOwnerUnlinked (maint) violated for host ${h}`;
      }
    }
    for (const h of Hosts) {
      if (s.procState[h] !== 'alive') {
        if (isLiveOwner(s, s.useClaim[h])) {
          return `QuiescentRecoverability violated: dead/zombie host ${h} still owns live use claim`;
        }
        if (s.maintClaim[h] && isLiveOwner(s, s.maintClaim[h])) {
          return `QuiescentRecoverability violated: dead/zombie host ${h} still owns live maint claim`;
        }
      }
    }
    return null;
  }

  function transitions(s) {
    const out = [];
    const push = (label, next) => out.push({ label, state: next });

    for (const h of Hosts) {
      const alive = s.procState[h] === 'alive';

      if (alive) {
        // --- Request lease (acquireStudioUse) ---
        if (s.usePhase[h] === 'idle' && !anyLiveMaint(s)) {
          const n = cloneState(s);
          n.usePhase[h] = 'checking';
          push(`UseCheckFree(${h})`, n);
        }
        if (s.usePhase[h] === 'checking') {
          const n = cloneState(s);
          n.useClaim[h] = { pid: h, gen: s.procGen[h], token: `u-${h}-${s.procGen[h]}` };
          n.usePhase[h] = 'wrote';
          push(`UseWriteClaim(${h})`, n);
        }
        if (s.usePhase[h] === 'wrote') {
          if (!usePostWriteRecheck || !anyLiveMaint(s)) {
            const n = cloneState(s);
            n.usePhase[h] = 'held';
            push(`UseRecheckCommit(${h})`, n);
          }
          if (usePostWriteRecheck && anyLiveMaint(s)) {
            const n = cloneState(s);
            n.useClaim[h] = null;
            n.usePhase[h] = 'idle';
            push(`UseRecheckAbort(${h})`, n);
          }
        }
        if (s.usePhase[h] === 'held') {
          const n = cloneState(s);
          n.useClaim[h] = null;
          n.usePhase[h] = 'idle';
          push(`UseRelease(${h})`, n);
        }

        // --- Maintenance gate (beginMaintenance / replaceStudioPackage) ---
        if (s.maintPhase[h] === 'idle' && !anyLiveMaint(s)) {
          const n = cloneState(s);
          n.maintPhase[h] = 'checking';
          push(`MaintCheckFree(${h})`, n);
        }
        if (s.maintPhase[h] === 'checking') {
          const n = cloneState(s);
          const claim = { pid: h, gen: s.procGen[h], token: `m-${h}-${s.procGen[h]}` };
          if (uniqueFilenames) n.maintClaim[h] = claim;
          else n.sharedGate = claim;
          n.maintPhase[h] = 'wrote';
          push(`MaintWriteClaim(${h})`, n);
        }
        if (s.maintPhase[h] === 'wrote') {
          const peerBlocked = maintPeerRecheck && anyLiveMaint(s, h);
          const useBlocked = maintUseCheck && hasLiveUse(s);
          if (!peerBlocked && !useBlocked) {
            const n = cloneState(s);
            n.maintPhase[h] = 'held';
            push(`MaintRecheckCommit(${h})`, n);
          }
          if (peerBlocked || useBlocked) {
            const n = cloneState(s);
            if (uniqueFilenames) {
              n.maintClaim[h] = null;
            } else if (n.sharedGate && n.sharedGate.pid === h && n.sharedGate.gen === s.procGen[h]) {
              n.sharedGate = null;
            }
            n.maintPhase[h] = 'idle';
            push(`MaintRecheckAbort(${h})`, n);
          }
        }
        if (s.maintPhase[h] === 'held') {
          const n = cloneState(s);
          if (uniqueFilenames) {
            n.maintClaim[h] = null;
          } else if (n.sharedGate && n.sharedGate.pid === h && n.sharedGate.gen === s.procGen[h]) {
            n.sharedGate = null;
          }
          n.maintPhase[h] = 'idle';
          push(`MaintRelease(${h})`, n);
        }

        // --- Stale scanner (two-step occupied() scan -> content-checked unlink) ---
        if (!s.cleaner[h]) {
          // Scan stale use claim
          for (const target of Hosts) {
            const claim = s.useClaim[target];
            if (claim && !isLiveOwner(s, claim)) {
              const n = cloneState(s);
              n.cleaner[h] = { kind: 'use', target, token: claim.token };
              push(`ScanStaleUse(${h}->${target})`, n);
            }
          }
          // Scan stale maint claim
          for (const entry of visibleMaintClaims(s)) {
            if (!isLiveOwner(s, entry.claim)) {
              const n = cloneState(s);
              n.cleaner[h] = { kind: 'maint', slot: entry.slot, token: entry.claim.token };
              push(`ScanStaleMaint(${h}->${entry.slot})`, n);
            }
          }
        } else {
          const job = s.cleaner[h];
          const n = cloneState(s);
          n.cleaner[h] = null;
          if (job.kind === 'use') {
            const cur = n.useClaim[job.target];
            if (!contentCheckedUnlink || (cur && cur.token === job.token)) {
              n.useClaim[job.target] = null;
            }
            push(`UnlinkStaleUse(${h}->${job.target})`, n);
          } else if (job.slot === 'shared') {
            if (!contentCheckedUnlink || (n.sharedGate && n.sharedGate.token === job.token)) {
              n.sharedGate = null;
            }
            push(`UnlinkStaleMaint(${h}->shared)`, n);
          } else {
            const target = Number(job.slot.split(':')[1]);
            const cur = n.maintClaim[target];
            if (!contentCheckedUnlink || (cur && cur.token === job.token)) {
              n.maintClaim[target] = null;
            }
            push(`UnlinkStaleMaint(${h}->${target})`, n);
          }
        }

        // --- Host crash (Linux zombie or abrupt death) ---
        const z = cloneState(s);
        z.procState[h] = 'zombie';
        z.usePhase[h] = 'idle';
        z.maintPhase[h] = 'idle';
        z.cleaner[h] = null;
        push(`CrashToZombie(${h})`, z);

        const d = cloneState(s);
        d.procState[h] = 'dead';
        d.usePhase[h] = 'idle';
        d.maintPhase[h] = 'idle';
        d.cleaner[h] = null;
        push(`CrashToDead(${h})`, d);
      }

      if (s.procState[h] === 'zombie') {
        const d = cloneState(s);
        d.procState[h] = 'dead';
        push(`ReapZombie(${h})`, d);
      }

      if (s.procState[h] === 'dead' && s.procGen[h] < maxGen) {
        const r = cloneState(s);
        r.procState[h] = 'alive';
        r.procGen[h] = s.procGen[h] + 1;
        push(`RestartPidReuse(${h},gen=${r.procGen[h]})`, r);
      }
    }

    return out;
  }

  const visited = new Set([serializeState(init)]);
  const queue = [{ state: init, trace: [] }];
  let cursor = 0;

  while (cursor < queue.length) {
    if (visited.size > maxStates) {
      throw new Error(`Model BFS exceeded cap (${maxStates})`);
    }
    const { state, trace } = queue[cursor++];
    const violation = checkInvariants(state);
    if (violation) {
      return { ok: false, explored: visited.size, violation, trace };
    }
    for (const edge of transitions(state)) {
      const key = serializeState(edge.state);
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ state: edge.state, trace: [...trace, edge.label] });
      }
    }
  }

  return { ok: true, explored: visited.size, violation: null, trace: [] };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Studio cross-host lock formal model & property suite', () => {
  let root, procRoot, archive, peerMaintChild, peerMaintStart, peerUseChild, peerUseStart, deadPid;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-lock-model-'));
    procRoot = path.join(root, 'proc');
    fs.mkdirSync(procRoot, { recursive: true });
    archive = officialArchive(path.join(root, 'archive'));

    peerMaintChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true
    });
    peerUseChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true
    });
    peerMaintStart = studioProcessStarted(peerMaintChild.pid);
    peerUseStart = studioProcessStarted(peerUseChild.pid);
    assert.ok(peerMaintStart && peerUseStart, 'expected non-empty peer start timestamps');

    const deadChild = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      windowsHide: true
    });
    deadPid = deadChild.pid;
    await once(deadChild, 'exit');
  });

  afterEach(() => {
    setProcRoot();
  });

  after(async () => {
    setProcRoot();
    for (const child of [peerMaintChild, peerUseChild]) {
      if (child && child.exitCode === null) {
        const done = once(child, 'exit');
        child.kill('SIGKILL');
        await done;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exhaustively verifies TLA+ safety invariants across crashes, zombies, and PID reuse', () => {
    const res = runLockModel();
    assert.equal(res.ok, true, `${res.violation} trace=${JSON.stringify(res.trace)}`);
    assert.ok(res.explored > 500, `expected >500 reachable states, got ${res.explored}`);
  });

  it('proves each protocol fence catches a real bug via mutation counterexamples', () => {
    const m1 = runLockModel({ usePostWriteRecheck: false });
    assert.equal(m1.ok, false, 'skipUsePostWriteRecheck must violate MutualExclusion');
    assert.match(m1.violation, /MutualExclusion/);

    const m2 = runLockModel({ maintUseCheck: false });
    assert.equal(m2.ok, false, 'skipMaintUseCheck must violate MutualExclusion');
    assert.match(m2.violation, /MutualExclusion/);

    const m3 = runLockModel({ uniqueFilenames: false, contentCheckedUnlink: false });
    assert.equal(m3.ok, false, 'unconditionalSharedGateUnlink must fail safety');
    assert.match(m3.violation, /NoLiveOwnerUnlinked|SingleMaintenance/);
  });

  it('satisfies protocol invariants across seeded randomized execution against lib/studio-updates.mjs', { timeout: process.platform === 'win32' ? 120000 : 30000 }, async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rng = mulberry32(0xC0FFEE + seed * 97);
      const dataDir = fs.mkdtempSync(path.join(root, `fuzz-${seed}-`));
      const seedProc = path.join(procRoot, `seed-${seed}`);
      const peerStatDirs = {
        maint: path.join(seedProc, String(peerMaintChild.pid)),
        use: path.join(seedProc, String(peerUseChild.pid))
      };
      fs.mkdirSync(seedProc, { recursive: true });
      setProcRoot(seedProc);

      ensureStudioConfig(dataDir);
      const bin = binaryPath(dataDir);
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, 'v0.3.6-executable', { mode: 0o755 });

      const activeLeases = []; // { kind: 'direct'|'stream', release, reader?, controller?, token, name }
      let peerMaint = null;    // { name, token, state: 'live'|'zombie'|'dead'|'reused' }
      let peerUse = null;      // { name, token, state: 'live'|'zombie'|'dead'|'reused' }
      let injectRaceOnDownload = false;

      const fetchFn = async (url, init) => {
        const str = String(url);
        if (str.includes('github.com')) {
          if (str.includes('/download/') && injectRaceOnDownload) {
            injectRaceOnDownload = false;
            const release = await acquireStudioUse({ dataDir, timeoutMs: 25 });
            const entries = fs.readdirSync(dataDir).filter(n => n.startsWith('.studio-use.'));
            const matched = entries.find(n => !activeLeases.some(l => l.name === n));
            activeLeases.push({ kind: 'direct', release, token: matched, name: matched });
          }
          return archive.fetchFn(str, init);
        }
        const pathname = new URL(str).pathname;
        if (pathname === '/api/auth/login') {
          return new Response('{}', { headers: { 'Set-Cookie': 'aistudio_admin=fixture; Path=/' } });
        }
        if (pathname === '/api/status') {
          return Response.json({
            version: 'v0.3.6',
            running: true,
            ready: false,
            state: 'RUNNING',
            active_requests: 0,
            accounts: { total: 0, busy: 0 },
            camoufox: { ready: false, preparing: false }
          });
        }
        if (pathname === '/api/accounts/tasks') return Response.json({ tasks: [] });
        if (pathname === '/api/update') return Response.json({ updating: false, current: 'v0.3.6' });
        assert.fail(`Unexpected backend mutation call while deferred: ${pathname}`);
      };

      const setPeerZombie = (kind, zombieOn) => {
        const statDir = peerStatDirs[kind];
        const peerPid = kind === 'maint' ? peerMaintChild.pid : peerUseChild.pid;
        fs.rmSync(statDir, { recursive: true, force: true });
        if (zombieOn) {
          fs.mkdirSync(statDir, { recursive: true });
          fs.writeFileSync(path.join(statDir, 'stat'), `${peerPid} (studio worker) Z 1 1 1 0\n`);
        }
      };

      const makeOwnerPayload = (kind, state, token) => {
        const peerPid = kind === 'maint' ? peerMaintChild.pid : peerUseChild.pid;
        const peerStart = kind === 'maint' ? peerMaintStart : peerUseStart;
        if (state === 'dead') return { pid: deadPid, started: 'dead-start', token };
        if (state === 'reused') return { pid: peerPid, started: 'stale-previous-boot', token };
        // On win32, omit started for repeated live checks so Get-CimInstance powershell calls don't dominate fuzz time;
        // 'reused' still exercises studioProcessStarted(pid) on Windows.
        return { pid: peerPid, started: process.platform === 'win32' ? undefined : peerStart, token };
      };

      const writePeerFile = (kind, state) => {
        const token = `peer-${kind}-${crypto.randomUUID()}`;
        const peerPid = kind === 'maint' ? peerMaintChild.pid : peerUseChild.pid;
        const pid = state === 'dead' ? deadPid : peerPid;
        const name = kind === 'maint' ? `.automatic-update.${token}.lock` : `.studio-use.${pid}.${token}.json`;
        setPeerZombie(kind, state === 'zombie');
        fs.writeFileSync(path.join(dataDir, name), JSON.stringify(makeOwnerPayload(kind, state, token)));
        return { name, token, state };
      };

      const verifyNoLiveOwnerUnlinked = () => {
        for (const lease of activeLeases) {
          const p = path.join(dataDir, lease.name);
          assert.equal(fs.existsSync(p), true, `seed ${seed}: live use lease missing ${lease.name}`);
        }
        if (peerMaint && peerMaint.state === 'live') {
          assert.equal(fs.existsSync(path.join(dataDir, peerMaint.name)), true, `seed ${seed}: live peer maint missing`);
        }
        if (peerUse && peerUse.state === 'live') {
          assert.equal(fs.existsSync(path.join(dataDir, peerUse.name)), true, `seed ${seed}: live peer use missing`);
        }
      };

      const closeLease = async index => {
        const lease = activeLeases.splice(index, 1)[0];
        if (lease.kind === 'direct') {
          lease.release();
        } else if (rng() < 0.5) {
          lease.controller.abort(new Error('client abort'));
          await lease.reader.cancel().catch(() => {});
        } else {
          await lease.reader.cancel().catch(() => {});
        }
        assert.equal(fs.existsSync(path.join(dataDir, lease.name)), false, `seed ${seed}: released lease left file`);
      };

      const states = ['live', 'zombie', 'dead', 'reused'];

      for (let step = 0; step < 40; step++) {
        const op = Math.floor(rng() * 7);

        if (op === 0 || op === 1) {
          // acquireStudioUse (direct or holdStudioResponse stream)
          const beforeNames = new Set(fs.readdirSync(dataDir));
          const maintLive = peerMaint && peerMaint.state === 'live';
          if (maintLive) {
            await assert.rejects(
              acquireStudioUse({ dataDir, timeoutMs: 25 }),
              /finishing an automatic update/
            );
            assert.equal(
              fs.readdirSync(dataDir).some(n => n.startsWith('.studio-use.') && !beforeNames.has(n)),
              false,
              `seed ${seed} step ${step}: failed acquire left dangling file`
            );
          } else {
            const release = await acquireStudioUse({ dataDir, timeoutMs: 250 });
            const added = fs.readdirSync(dataDir).filter(n => n.startsWith('.studio-use.') && !beforeNames.has(n));
            assert.equal(added.length, 1);
            if (peerMaint && peerMaint.state !== 'live') {
              assert.equal(fs.existsSync(path.join(dataDir, peerMaint.name)), false);
              peerMaint = null;
            }
            if (op === 1) {
              const controller = new AbortController();
              const stream = new ReadableStream({
                start(c) { c.enqueue(new TextEncoder().encode('chunk')); }
              });
              const wrapped = holdStudioResponse(new Response(stream), release, controller.signal);
              const reader = wrapped.body.getReader();
              await reader.read();
              activeLeases.push({ kind: 'stream', release, reader, controller, name: added[0] });
            } else {
              activeLeases.push({ kind: 'direct', release, name: added[0] });
            }
          }
        } else if (op === 2 && activeLeases.length > 0) {
          await closeLease(Math.floor(rng() * activeLeases.length));
        } else if (op === 3 && !peerMaint) {
          const chosen = states[Math.floor(rng() * states.length)];
          peerMaint = writePeerFile('maint', chosen);
        } else if (op === 4 && !peerUse) {
          const chosen = states[Math.floor(rng() * states.length)];
          peerUse = writePeerFile('use', chosen);
        } else if (op === 5 && (peerMaint || peerUse)) {
          // Crash / become zombie / dead / PID-reused
          if (peerMaint && (!peerUse || rng() < 0.5)) {
            if (peerMaint.state === 'live') {
              const nextState = ['zombie', 'dead', 'reused'][Math.floor(rng() * 3)];
              peerMaint.state = nextState;
              setPeerZombie('maint', nextState === 'zombie');
              fs.writeFileSync(
                path.join(dataDir, peerMaint.name),
                JSON.stringify(makeOwnerPayload('maint', nextState, peerMaint.token))
              );
            } else {
              fs.rmSync(path.join(dataDir, peerMaint.name), { force: true });
              peerMaint = null;
              setPeerZombie('maint', false);
            }
          } else if (peerUse) {
            if (peerUse.state === 'live') {
              const nextState = ['zombie', 'dead', 'reused'][Math.floor(rng() * 3)];
              peerUse.state = nextState;
              setPeerZombie('use', nextState === 'zombie');
              fs.writeFileSync(
                path.join(dataDir, peerUse.name),
                JSON.stringify(makeOwnerPayload('use', nextState, peerUse.token))
              );
            } else {
              fs.rmSync(path.join(dataDir, peerUse.name), { force: true });
              peerUse = null;
              setPeerZombie('use', false);
            }
          }
        } else if (op === 6) {
          // Run auto-update; when system is otherwise free, inject a mid-download acquireStudioUse race
          if (!supportsOfficialStudio(process.platform, process.arch)) continue;
          const anyUseActive = activeLeases.length > 0 || (peerUse && peerUse.state === 'live');
          const anyMaintActive = peerMaint && peerMaint.state === 'live';
          if (!anyUseActive && !anyMaintActive) {
            fs.rmSync(path.join(dataDir, archive.name), { force: true });
            injectRaceOnDownload = true;
          }
          const result = await updateStudioAutomatically({ dataDir, fetchFn, force: true });
          injectRaceOnDownload = false;
          assert.equal(result.state, 'busy', `seed ${seed} step ${step}: expected busy, got ${JSON.stringify(result)}`);
          assert.equal(fs.readFileSync(bin, 'utf8'), 'v0.3.6-executable', `seed ${seed}: binary mutated illegally`);
          assert.equal(
            fs.readdirSync(dataDir).some(n => n.startsWith('.automatic-update.') && n.endsWith('.lock') && (!peerMaint || n !== peerMaint.name)),
            false,
            `seed ${seed}: own maintenance lock leaked`
          );
        }

        verifyNoLiveOwnerUnlinked();
      }

      // Quiescence cleanup: drain remaining leases & simulate peer crash/exit -> verify full recovery
      while (activeLeases.length > 0) await closeLease(0);
      if (peerMaint?.state === 'live') {
        fs.rmSync(path.join(dataDir, peerMaint.name), { force: true });
        peerMaint = null;
      }
      if (peerUse?.state === 'live') {
        fs.rmSync(path.join(dataDir, peerUse.name), { force: true });
        peerUse = null;
      }
      setPeerZombie('maint', peerMaint?.state === 'zombie');
      setPeerZombie('use', peerUse?.state === 'zombie');

      const finalRelease = await acquireStudioUse({ dataDir, timeoutMs: 250 });
      finalRelease();

      if (supportsOfficialStudio(process.platform, process.arch)) {
        const settledFetchFn = async (url, init) => {
          const str = String(url);
          if (!str.includes('github.com') && new URL(str).pathname === '/api/status') {
            return Response.json({
              version: 'v0.3.7',
              running: true,
              ready: false,
              state: 'RUNNING',
              active_requests: 0,
              accounts: { total: 0, busy: 0 },
              camoufox: { ready: false, preparing: false }
            });
          }
          return fetchFn(url, init);
        };
        const settled = await updateStudioAutomatically({ dataDir, fetchFn: settledFetchFn, force: true });
        assert.equal(settled.state, 'current', `seed ${seed}: expected current after stale reclamation, got ${JSON.stringify(settled)}`);
      } else {
        // Fallback if test ever runs on an unsupported arch where checkAndUpdate returns 'disabled'
        peerUse = null;
      }

      const leftovers = fs.readdirSync(dataDir).filter(
        n => n.startsWith('.studio-use.') || (n.startsWith('.automatic-update.') && n.endsWith('.lock'))
      );
      assert.deepEqual(leftovers, [], `seed ${seed}: stale lock files remained after quiescence`);
      setPeerZombie('maint', false);
      setPeerZombie('use', false);
      setProcRoot();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
