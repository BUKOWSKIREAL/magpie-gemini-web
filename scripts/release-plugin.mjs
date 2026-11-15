#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function printHelp() {
  console.log(`Idempotent plugin release orchestrator for magpie-gemini-web.

Usage:
  node scripts/release-plugin.mjs [options]

Options:
  --tag <vX.Y.Z>       Release tag to converge to (default: v<package.json version>)
  --commit <sha>       40-char git commit SHA on origin/main (default: HEAD)
  --repo <owner/name>  GitHub repository (default: package.json repository)
  --notes-file <path>  Markdown release notes file when creating a new draft
  --notes <text>       Inline release notes when creating a new draft
  --generate-notes     Use GitHub's generated release notes for a new draft
  --skip-npm           Build and upload verified tarball to draft without publishing npm
  --dry-run            Validate preconditions and print the execution plan with zero mutations
  --allow-dirty        Allow dirty tracked files during --dry-run preview only
  --json               Print machine-readable JSON output
  -h, --help           Show this help
`);
}

export function parseReleaseArgs(argv) {
  const opts = {
    skipNpm: false,
    dryRun: false,
    allowDirty: false,
    generateNotes: false,
    json: false
  };
  const valueFlags = new Set(['--tag', '--commit', '--repo', '--notes-file', '--notes']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--skip-npm') opts.skipNpm = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--allow-dirty') opts.allowDirty = true;
    else if (arg === '--generate-notes') opts.generateNotes = true;
    else if (arg === '--json') opts.json = true;
    else if (valueFlags.has(arg)) {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      const next = argv[++i];
      if (!next && arg !== '--notes') throw new Error(`Missing value for ${arg}`);
      if (arg === '--tag') opts.tag = next;
      else if (arg === '--commit') opts.commit = next;
      else if (arg === '--repo') opts.repo = next;
      else if (arg === '--notes-file') opts.notesFile = path.resolve(process.cwd(), next);
      else if (arg === '--notes') opts.notes = next;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  const notesChoices = [opts.notesFile !== undefined, opts.notes !== undefined, opts.generateNotes].filter(Boolean).length;
  if (notesChoices > 1) {
    throw new Error('Specify at most one of --notes-file, --notes, or --generate-notes');
  }
  if (opts.allowDirty && !opts.dryRun) {
    throw new Error('--allow-dirty is only permitted together with --dry-run');
  }
  return opts;
}

function defaultExec(file, args, options = {}) {
  return new Promise(resolve => {
    execFile(file, args, { cwd: options.cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout = '', stderr = '') => {
      if (!err) return resolve({ status: 0, stdout, stderr });
      const status = typeof err.code === 'number' ? err.code : 1;
      resolve({ status, stdout, stderr: stderr || err.message });
    });
  });
}

async function runCmd(execFn, cmd, args, { cwd, allowFail = false } = {}) {
  const res = await execFn(cmd, args, { cwd });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}\n${(res.stderr || res.stdout || '').trim()}`);
  }
  return res;
}

function parseRepoFromPackage(pkg) {
  const raw = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
  const match = String(raw || '').match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/i);
  return match ? match[1] : '';
}

async function resolveTagTargetCommit(execFn, repo, tag, targetCommitish, cwd) {
  if (/^[0-9a-f]{40}$/i.test(String(targetCommitish || ''))) {
    return targetCommitish.toLowerCase();
  }
  const refRes = await runCmd(execFn, 'gh', ['api', `repos/${repo}/git/ref/tags/${tag}`], { cwd, allowFail: true });
  if (refRes.status === 0 && refRes.stdout.trim()) {
    const refObj = JSON.parse(refRes.stdout);
    if (refObj?.object?.type === 'commit' && /^[0-9a-f]{40}$/i.test(refObj.object.sha)) {
      return refObj.object.sha.toLowerCase();
    }
    if (refObj?.object?.type === 'tag' && /^[0-9a-f]{40}$/i.test(refObj.object.sha)) {
      const tagRes = await runCmd(execFn, 'gh', ['api', `repos/${repo}/git/tags/${refObj.object.sha}`], { cwd, allowFail: true });
      if (tagRes.status === 0 && tagRes.stdout.trim()) {
        const tagObj = JSON.parse(tagRes.stdout);
        if (tagObj?.object?.sha) return tagObj.object.sha.toLowerCase();
      }
    }
  }
  return targetCommitish;
}

async function verifyAssetUrlReachable(fetchFn, url) {
  let res = await fetchFn(url, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
  if (res.status === 200) return;
  if (res.status === 405 || res.status === 403) {
    await res.body?.cancel?.().catch(() => {});
    res = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(30000) });
    const status = res.status;
    await res.body?.cancel?.().catch(() => {});
    if (status === 200) return;
    throw new Error(`Pinned backend asset returned HTTP ${status}: ${url}`);
  }
  await res.body?.cancel?.().catch(() => {});
  throw new Error(`Pinned backend asset returned HTTP ${res.status}: ${url}`);
}

async function listWorkflowRuns(execFn, repo, workflowFile, cwd) {
  const res = await runCmd(execFn, 'gh', [
    'run', 'list', '--repo', repo, '--workflow', workflowFile,
    '--event', 'workflow_dispatch', '--limit', '10',
    '--json', 'databaseId,createdAt,status,conclusion,url'
  ], { cwd });
  return JSON.parse(res.stdout || '[]');
}

async function waitForDispatchedRun(execFn, repo, workflowFile, { priorMaxId = 0, startedAt = 0, cwd, sleepFn, pollMs, attempts = 24 }) {
  for (let i = 0; i < attempts; i += 1) {
    const runs = await listWorkflowRuns(execFn, repo, workflowFile, cwd);
    const match = runs.find(r => {
      const id = Number(r?.databaseId) || 0;
      if (id > 0 && priorMaxId > 0) return id > priorMaxId;
      return Date.parse(r.createdAt) >= startedAt - 5000;
    });
    if (match) return match;
    if (i < attempts - 1) await sleepFn(pollMs);
  }
  throw new Error(`Timed out waiting for workflow_dispatch run of ${workflowFile}`);
}

export async function releasePlugin({
  cwd = REPO_ROOT,
  tag,
  commit,
  repo,
  notesFile,
  notes,
  generateNotes = false,
  skipNpm = false,
  dryRun = false,
  allowDirty = false,
  registryBase = 'https://registry.npmjs.org',
  pollMs = 2500,
  execFn = defaultExec,
  fetchFn = globalThis.fetch,
  nowFn = Date.now,
  sleepFn = delay,
  log = console.log
} = {}) {
  if (allowDirty && !dryRun) {
    throw new Error('--allow-dirty is only permitted together with --dry-run');
  }

  const resolvedCommit = (commit || (await runCmd(execFn, 'git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()).toLowerCase();
  assert.match(resolvedCommit, /^[0-9a-f]{40}$/, `Release commit must be a 40-char SHA (got "${resolvedCommit}")`);

  const dirtyRes = await runCmd(execFn, 'git', ['status', '--porcelain', '--untracked-files=no'], { cwd });
  if (dirtyRes.stdout.trim() && !(dryRun && allowDirty)) {
    throw new Error('Working tree has uncommitted changes to tracked files; commit or stash them first (or pass --dry-run --allow-dirty to preview).');
  }

  const pkgRaw = (await runCmd(execFn, 'git', ['show', `${resolvedCommit}:package.json`], { cwd })).stdout;
  const pkg = JSON.parse(pkgRaw);
  const resolvedTag = tag || `v${pkg.version}`;
  assert.match(resolvedTag, /^v\d+\.\d+\.\d+$/, `Release tag must match vX.Y.Z (got "${resolvedTag}")`);
  assert.equal(`v${pkg.version}`, resolvedTag, `package.json version (${pkg.version}) at ${resolvedCommit} does not match tag ${resolvedTag}`);

  let resolvedRepo = repo || parseRepoFromPackage(pkg);
  if (!resolvedRepo) {
    resolvedRepo = (await runCmd(execFn, 'gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd })).stdout.trim();
  }
  assert.match(resolvedRepo, /^[^/\s]+\/[^/\s]+$/, `Could not determine GitHub repository (got "${resolvedRepo}")`);

  if (!dryRun) {
    await runCmd(execFn, 'git', ['fetch', 'origin', 'main'], { cwd });
  }
  const ancestorRes = await runCmd(execFn, 'git', ['merge-base', '--is-ancestor', resolvedCommit, 'origin/main'], { cwd, allowFail: true });
  if (ancestorRes.status !== 0) {
    throw new Error(`Commit ${resolvedCommit} is not reachable on origin/main; merge/push to main before releasing.`);
  }

  const backendRaw = (await runCmd(execFn, 'git', ['show', `${resolvedCommit}:lib/backend-release.json`], { cwd })).stdout;
  const backendRelease = JSON.parse(backendRaw);
  await Promise.all(Object.values(backendRelease.binaries).map(pin => {
    const url = `https://github.com/${backendRelease.repository}/releases/download/${backendRelease.tag}/${pin.asset}`;
    return verifyAssetUrlReachable(fetchFn, url);
  }));

  const viewArgs = ['release', 'view', resolvedTag, '--repo', resolvedRepo, '--json', 'isDraft,targetCommitish,assets,url'];
  const viewRes = await runCmd(execFn, 'gh', viewArgs, { cwd, allowFail: true });
  let rel = null;
  if (viewRes.status === 0) {
    rel = JSON.parse(viewRes.stdout);
    const existingCommit = await resolveTagTargetCommit(execFn, resolvedRepo, resolvedTag, rel.targetCommitish, cwd);
    assert.equal(
      String(existingCommit).toLowerCase(),
      resolvedCommit,
      `Existing release ${resolvedTag} targets ${existingCommit}, expected ${resolvedCommit}`
    );
  } else if (!/release not found/i.test(`${viewRes.stderr}\n${viewRes.stdout}`)) {
    throw new Error(`Failed to inspect release ${resolvedTag}: ${(viewRes.stderr || viewRes.stdout).trim()}`);
  }

  const tarballName = `${pkg.name}-${pkg.version}.tgz`;
  const hasTarball = !!rel?.assets?.some(a => a.name === tarballName && a.state === 'uploaded');
  let npmPublished = false;
  if (!skipNpm) {
    const npmRes = await fetchFn(`${registryBase.replace(/\/+$/, '')}/${pkg.name}/${pkg.version}`, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(15000)
    });
    if (npmRes.status === 200) {
      npmPublished = true;
    } else if (npmRes.status !== 404) {
      throw new Error(`Unexpected npm registry status ${npmRes.status} while checking ${pkg.name}@${pkg.version}`);
    }
    await npmRes.body?.cancel?.().catch(() => {});
  }

  const needsPublishWorkflow = !hasTarball || (!skipNpm && !npmPublished);
  if (needsPublishWorkflow && rel && !rel.isDraft && !hasTarball) {
    throw new Error(`Release ${resolvedTag} is already published without ${tarballName}; publish-package.yml requires a private draft to upload a new tarball.`);
  }

  const steps = [];
  let releaseUrl = rel?.url || null;
  let publishRunUrl = null;
  let verifyRunUrl = null;
  let currentIsDraft = rel ? !!rel.isDraft : true;

  // Step 1: Create or reuse draft release
  if (!rel) {
    if (!notesFile && notes === undefined && !generateNotes) {
      if (!dryRun) {
        throw new Error(`Release ${resolvedTag} does not exist yet; pass --notes-file <path>, --notes <text>, or --generate-notes.`);
      }
      steps.push({ action: 'create-draft-release', status: 'planned', tag: resolvedTag, commit: resolvedCommit, note: 'requires --notes-file, --notes, or --generate-notes on live run' });
    } else if (dryRun) {
      steps.push({ action: 'create-draft-release', status: 'planned', tag: resolvedTag, commit: resolvedCommit });
    } else {
      const resolvedNotesFile = notesFile ? path.resolve(cwd, notesFile) : undefined;
      if (resolvedNotesFile && !fs.existsSync(resolvedNotesFile)) {
        throw new Error(`Release notes file not found: ${resolvedNotesFile}`);
      }
      const createArgs = ['release', 'create', resolvedTag, '--repo', resolvedRepo, '--draft', '--target', resolvedCommit, '--title', resolvedTag];
      if (resolvedNotesFile) createArgs.push('--notes-file', resolvedNotesFile);
      else if (notes !== undefined) createArgs.push('--notes', notes);
      else createArgs.push('--generate-notes');
      const created = await runCmd(execFn, 'gh', createArgs, { cwd });
      releaseUrl = created.stdout.trim() || JSON.parse((await runCmd(execFn, 'gh', viewArgs, { cwd })).stdout).url;
      currentIsDraft = true;
      steps.push({ action: 'create-draft-release', status: 'completed', tag: resolvedTag, commit: resolvedCommit, url: releaseUrl });
    }
  } else {
    steps.push({
      action: 'create-draft-release',
      status: 'skipped',
      reason: rel.isDraft ? 'existing-draft' : 'already-published',
      url: rel.url
    });
  }

  // Step 2: Run publish-package.yml if tarball missing or npm version still unpublished
  if (needsPublishWorkflow) {
    if (dryRun) {
      steps.push({
        action: 'publish-package',
        status: 'planned',
        workflow: 'publish-package.yml',
        tag: resolvedTag,
        publishNpm: !skipNpm
      });
    } else {
      const priorRuns = await listWorkflowRuns(execFn, resolvedRepo, 'publish-package.yml', cwd);
      const priorMaxId = priorRuns.reduce((max, r) => Math.max(max, Number(r?.databaseId) || 0), 0);
      const startedAt = nowFn();
      await runCmd(execFn, 'gh', [
        'workflow', 'run', 'publish-package.yml', '--repo', resolvedRepo,
        '-f', `tag=${resolvedTag}`, '-f', `publish_npm=${String(!skipNpm)}`
      ], { cwd });
      const run = await waitForDispatchedRun(execFn, resolvedRepo, 'publish-package.yml', { priorMaxId, startedAt, cwd, sleepFn, pollMs });
      publishRunUrl = run.url || null;
      await runCmd(execFn, 'gh', ['run', 'watch', String(run.databaseId), '--repo', resolvedRepo, '--exit-status', '--interval', '15'], { cwd });
      steps.push({ action: 'publish-package', status: 'completed', runId: run.databaseId, url: publishRunUrl, publishNpm: !skipNpm });
    }
  } else {
    steps.push({
      action: 'publish-package',
      status: 'skipped',
      reason: skipNpm ? 'tarball-already-uploaded' : 'tarball-and-npm-already-published'
    });
  }

  // Step 3: Undraft GitHub release (--latest) & fetch tag locally
  if (!skipNpm) {
    if (dryRun) {
      if (currentIsDraft) {
        steps.push({ action: 'undraft-release', status: 'planned', tag: resolvedTag, latest: true });
      } else {
        steps.push({ action: 'undraft-release', status: 'skipped', reason: 'already-published' });
      }
      steps.push({ action: 'git-fetch-tags', status: 'planned' });
    } else {
      const refreshed = JSON.parse((await runCmd(execFn, 'gh', viewArgs, { cwd })).stdout);
      currentIsDraft = !!refreshed.isDraft;
      releaseUrl = refreshed.url || releaseUrl;
      if (currentIsDraft) {
        await runCmd(execFn, 'gh', ['release', 'edit', resolvedTag, '--repo', resolvedRepo, '--draft=false', '--latest'], { cwd });
        const afterEdit = JSON.parse((await runCmd(execFn, 'gh', viewArgs, { cwd })).stdout);
        releaseUrl = afterEdit.url || releaseUrl;
        steps.push({ action: 'undraft-release', status: 'completed', tag: resolvedTag, url: releaseUrl });
      } else {
        steps.push({ action: 'undraft-release', status: 'skipped', reason: 'already-published', url: releaseUrl });
      }
      await runCmd(execFn, 'git', ['fetch', '--tags', 'origin'], { cwd });
      steps.push({ action: 'git-fetch-tags', status: 'completed' });
    }

    // Step 4: Verify publicly distributed package against GitHub release
    if (dryRun) {
      steps.push({ action: 'verify-package', status: 'planned', workflow: 'verify-package.yml', ref: resolvedTag });
    } else {
      const priorVerifyRuns = await listWorkflowRuns(execFn, resolvedRepo, 'verify-package.yml', cwd);
      const priorVerifyMaxId = priorVerifyRuns.reduce((max, r) => Math.max(max, Number(r?.databaseId) || 0), 0);
      const verifyStartedAt = nowFn();
      await runCmd(execFn, 'gh', ['workflow', 'run', 'verify-package.yml', '--repo', resolvedRepo, '-f', `ref=${resolvedTag}`], { cwd });
      const verifyRun = await waitForDispatchedRun(execFn, resolvedRepo, 'verify-package.yml', {
        priorMaxId: priorVerifyMaxId,
        startedAt: verifyStartedAt,
        cwd,
        sleepFn,
        pollMs
      });
      verifyRunUrl = verifyRun.url || null;
      await runCmd(execFn, 'gh', ['run', 'watch', String(verifyRun.databaseId), '--repo', resolvedRepo, '--exit-status', '--interval', '15'], { cwd });
      steps.push({ action: 'verify-package', status: 'completed', runId: verifyRun.databaseId, url: verifyRunUrl });
    }
  } else {
    log(`Draft release ${resolvedTag} updated with verified tarball (--skip-npm set; release remains draft).`);
  }

  return {
    ok: true,
    dryRun,
    tag: resolvedTag,
    commit: resolvedCommit,
    repo: resolvedRepo,
    releaseUrl,
    publishRunUrl,
    verifyRunUrl,
    steps
  };
}

async function main() {
  const opts = parseReleaseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  const result = await releasePlugin(opts);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.dryRun ? '[DRY RUN] ' : ''}Release ${result.tag} (${result.repo} @ ${result.commit.slice(0, 7)}):`);
    for (const step of result.steps) {
      const detail = step.url || step.reason || step.note || (step.workflow ? `workflow=${step.workflow}` : '');
      console.log(`  - ${step.action}: ${step.status}${detail ? ` (${detail})` : ''}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
