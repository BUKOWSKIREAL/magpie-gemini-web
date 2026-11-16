import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Execute the workflow's real reporting script against a fake GitHub API. No
// issue is created, commented on, or closed outside this in-memory fixture.
const workflow = fs.readFileSync(new URL('../.github/workflows/studio-upstream-watch.yml', import.meta.url), 'utf8');
const report = workflow.slice(workflow.indexOf('      - name: Sync upstream compatibility tracking issue'));
const script = /node --input-type=module <<'JS'\n([\s\S]*?)\n          JS/.exec(report)?.[1];
assert.ok(script, 'reporting script must be exercised directly');
const execute = new (Object.getPrototypeOf(async function() {}).constructor)('process', 'fetch', 'console', script);
const prefix = '[Upstream Watch] Official AIStudio2API v0.3.10 ';
const runUrl = 'https://github.com/example/repo/actions/runs/123';

async function runReport({ result = 'failure', issues = [], comments = [], jobs = [] } = {}) {
  const writes = [], reads = [];
  await execute({ env: {
    GH_TOKEN: 'fixture', REPO: 'example/repo', UPSTREAM_TAG: 'v0.3.10',
    VERIFY_RESULT: result, RUN_URL: runUrl, RUN_ID: '123', RUN_ATTEMPT: '2'
  } }, async (url, init) => {
    const target = new URL(url);
    if (init.method) {
      writes.push({ method: init.method, path: target.pathname, body: JSON.parse(init.body) });
      return Response.json({ number: 64 });
    }
    reads.push(target);
    if (target.pathname.endsWith('/jobs')) {
      assert.equal(target.pathname, '/repos/example/repo/actions/runs/123/attempts/2/jobs');
      const page = Number(target.searchParams.get('page'));
      return Response.json({ jobs: jobs.slice((page - 1) * 100, page * 100) });
    }
    if (target.pathname.endsWith('/comments')) return Response.json(comments);
    if (target.pathname.endsWith('/issues')) return Response.json(issues);
    assert.fail('unexpected API URL: ' + url);
  }, { log() {} });
  return { writes, reads };
}

const failed = (name, step) => ({
  name: `verify / studio (${name})`, conclusion: 'failure',
  html_url: `${runUrl}/job/${name}`,
  steps: [{ name: step, conclusion: 'failure' }, { name: 'Cleanup', conclusion: 'success' }]
});

describe('Upstream watch failure reporting', () => {
  it('reports fixture and official backend failures by platform and step without asserting upstream breakage', async () => {
    const { writes } = await runReport({ jobs: [
      failed('windows', 'Test installation, lifecycle and account integration with isolated fixtures'),
      failed('intel', 'Pack and verify the actual installed package against the official backend')
    ] });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.title, prefix + 'verification failed');
    const body = writes[0].body.body;
    assert.match(body, /does not establish an upstream compatibility regression/);
    assert.match(body, /windows.*isolated fixtures/);
    assert.match(body, /intel.*official backend/);
    assert.match(body, /`npm test`/);
    assert.match(body, /studio-auto-update-smoke/);
    assert.match(body, /actions\/runs\/123\/attempts\/2/);
    assert.ok(!body.includes('Cleanup'));
    const reportJob = workflow.slice(workflow.indexOf('\n  report:'));
    assert.match(reportJob, /permissions:\n      contents: read\n      actions: read\n      issues: write/);
  });

  it('reuses the existing compatibility-titled issue and paginates the current attempt jobs', async () => {
    const jobs = Array.from({ length: 100 }, () => ({ name: 'verify / passed', conclusion: 'success' }));
    jobs.push(failed('windows', 'Isolated tests'));
    const { writes, reads } = await runReport({
      issues: [{ number: 63, title: prefix + 'compatibility check failed', body: 'previous run' }], jobs
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, '/repos/example/repo/issues/63/comments');
    assert.match(writes[0].body.body, /windows.*Isolated tests/);
    assert.equal(reads.filter(url => url.pathname.endsWith('/jobs')).length, 2);
  });

  it('reports a failed rerun even when the previous attempt was already reported', async () => {
    const { writes } = await runReport({
      issues: [{ number: 63, title: prefix + 'verification failed', body: runUrl }],
      comments: [{ body: 'Previous attempt: ' + runUrl + '/attempts/1' }],
      jobs: [failed('intel', 'Official backend')]
    });
    assert.equal(writes.length, 1);
    assert.match(writes[0].body.body, /attempts\/2/);
    assert.match(writes[0].body.body, /intel.*Official backend/);
  });

  it('does not duplicate a report for the same attempt', async () => {
    const { writes } = await runReport({
      issues: [{ number: 63, title: prefix + 'verification failed' }],
      comments: [{ body: 'Already reported: ' + runUrl + '/attempts/2' }]
    });
    assert.deepEqual(writes, []);
  });

  it('still closes existing tracking issues only after successful verification', async () => {
    const { writes, reads } = await runReport({ result: 'success', issues: [
      { number: 63, title: prefix + 'compatibility check failed' },
      { number: 65, title: 'Unrelated issue' }
    ] });
    assert.equal(writes.length, 2);
    assert.match(writes[0].body.body, /recovered/);
    assert.deepEqual(writes[1], { method: 'PATCH', path: '/repos/example/repo/issues/63', body: { state: 'closed' } });
    assert.ok(reads.every(url => !url.pathname.endsWith('/jobs')));
  });
});
