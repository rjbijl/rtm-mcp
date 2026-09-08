import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signParams, asArray, resolveRestEndpoint } from '../dist/rtm.js';
import { encodeHandle, decodeHandle } from '../dist/handles.js';
import { flattenTasks } from '../dist/format.js';
import { writeStoredAuth } from '../dist/config.js';
import { detectProject } from '../dist/project.js';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('api_sig matches RTM\'s own documented example', () => {
  // From https://www.rememberthemilk.com/services/api/authentication.rtm
  // secret BANANAS, params yxz=foo feg=bar abc=baz -> 82044aae4dd676094f23f1ec152159ba
  const sig = signParams({ yxz: 'foo', feg: 'bar', abc: 'baz' }, 'BANANAS');
  assert.equal(sig, '82044aae4dd676094f23f1ec152159ba');
});

test('api_sig ignores an api_sig that is already present', () => {
  const a = signParams({ yxz: 'foo', feg: 'bar', abc: 'baz' }, 'BANANAS');
  const b = signParams({ yxz: 'foo', feg: 'bar', abc: 'baz', api_sig: 'junk' }, 'BANANAS');
  assert.equal(a, b);
});

test('api_sig sorts by key, not by insertion order', () => {
  const a = signParams({ b: '2', a: '1', c: '3' }, 's3cr3t');
  const b = signParams({ c: '3', a: '1', b: '2' }, 's3cr3t');
  assert.equal(a, b);
});

test('api_sig uses UTF-8 bytes', () => {
  // Must not crash and must be stable for non-ASCII task names
  const sig = signParams({ name: 'Café: reassess the façade ☕' }, 'BANANAS');
  assert.match(sig, /^[0-9a-f]{32}$/);
});

test('asArray normalizes RTM\'s single-vs-array JSON', () => {
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray({ id: '1' }), [{ id: '1' }]);
  assert.deepEqual(asArray([{ id: '1' }, { id: '2' }]), [{ id: '1' }, { id: '2' }]);
});

test('task handle round-trips', () => {
  const ref = { listId: '111', seriesId: '222', taskId: '333' };
  assert.deepEqual(decodeHandle(encodeHandle(ref)), ref);
});

test('an invalid handle gives a useful error', () => {
  assert.throws(() => decodeHandle('not-base64-with-triple'), /Invalid task handle/);
  assert.throws(() => decodeHandle(Buffer.from('1:2').toString('base64url')), /Invalid task handle/);
});

test('flattenTasks picks up multiple instances of a repeating taskseries', () => {
  const rsp = {
    tasks: {
      list: {
        id: 'L1',
        taskseries: {
          id: 'S1',
          name: 'Standup',
          tags: { tag: 'work' },
          task: [
            { id: 'T1', due: '2026-09-09T00:00:00Z', has_due_time: '0', priority: '2', completed: '', deleted: '' },
            { id: 'T2', due: '2026-09-10T00:00:00Z', has_due_time: '0', priority: '2', completed: '', deleted: '' }
          ]
        }
      }
    }
  };
  const tasks = flattenTasks(rsp, new Map([['L1', 'Work']]));
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((t) => t.due), ['2026-09-09', '2026-09-10']);
  assert.deepEqual(tasks[0].tags, ['work']);
  assert.equal(tasks[0].listName, 'Work');
  assert.notEqual(tasks[0].handle, tasks[1].handle);
});

test('flattenTasks skips deleted tasks and survives single-element objects', () => {
  const rsp = {
    tasks: {
      list: [
        {
          id: 'L1',
          taskseries: [
            { id: 'S1', name: 'Gone', task: { id: 'T1', deleted: '2026-01-01T00:00:00Z', due: '', has_due_time: '0', priority: 'N', completed: '' } },
            { id: 'S2', name: 'Stays', task: { id: 'T2', deleted: '', due: '', has_due_time: '0', priority: '1', completed: '' } }
          ]
        }
      ]
    }
  };
  const tasks = flattenTasks(rsp, new Map([['L1', 'Inbox']]));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].name, 'Stays');
  assert.equal(tasks[0].priority, '!1');
});

test('a handle with non-numeric ids is rejected', () => {
  // RTM ids are always numeric; anything else is garbage or an injection attempt.
  assert.throws(() => decodeHandle(Buffer.from('1:2:x').toString('base64url')), /Invalid task handle/);
  assert.throws(() => decodeHandle(Buffer.from('a:b:c').toString('base64url')), /Invalid task handle/);
  assert.throws(() => decodeHandle(Buffer.from('1:2:3&evil=1').toString('base64url')), /Invalid task handle/);
  assert.deepEqual(decodeHandle(encodeHandle({ listId: '1', seriesId: '22', taskId: '333' })), {
    listId: '1', seriesId: '22', taskId: '333'
  });
});

test('without RTM_REST_ENDPOINT the real RTM endpoint is used', () => {
  assert.equal(resolveRestEndpoint({}), 'https://api.rememberthemilk.com/services/rest/');
});

test('RTM_REST_ENDPOINT without explicit consent is refused', () => {
  assert.throws(
    () => resolveRestEndpoint({ RTM_REST_ENDPOINT: 'http://evil.example/' }),
    /RTM_ALLOW_ENDPOINT_OVERRIDE/
  );
});

test('RTM_REST_ENDPOINT with consent is used and reported', () => {
  const warnings = [];
  const url = resolveRestEndpoint(
    { RTM_REST_ENDPOINT: 'http://127.0.0.1:9/', RTM_ALLOW_ENDPOINT_OVERRIDE: '1' },
    (msg) => warnings.push(msg)
  );
  assert.equal(url, 'http://127.0.0.1:9/');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /http:\/\/127\.0\.0\.1:9\//);
});

test('writeStoredAuth resets an existing auth.json back to 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rtm-mcp-test-'));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    const file = join(dir, 'rtm-mcp', 'auth.json');
    mkdirSync(join(dir, 'rtm-mcp'), { recursive: true });
    writeFileSync(file, '{}');
    chmodSync(file, 0o644);
    assert.equal(writeStoredAuth({ auth_token: 'secret' }), file);
    assert.equal((statSync(file).mode & 0o777).toString(8), '600');
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

function tmp() {
  return mkdtempSync(join(tmpdir(), 'rtm-mcp-project-'));
}

test('detectProject uses the git root name when started in a subdirectory', () => {
  const root = tmp();
  mkdirSync(join(root, 'myproj', '.git'), { recursive: true });
  mkdirSync(join(root, 'myproj', 'backend', 'src'), { recursive: true });
  assert.equal(detectProject(join(root, 'myproj', 'backend', 'src'), {}, join(root, 'home')), 'myproj');
});

test('detectProject treats a .git file (worktree) as a repo root too', () => {
  const root = tmp();
  mkdirSync(join(root, 'wt', 'lib'), { recursive: true });
  writeFileSync(join(root, 'wt', '.git'), 'gitdir: /elsewhere');
  assert.equal(detectProject(join(root, 'wt', 'lib'), {}, join(root, 'home')), 'wt');
});

test('detectProject falls back to the cwd name outside a repo', () => {
  const root = tmp();
  mkdirSync(join(root, 'loose'));
  assert.equal(detectProject(join(root, 'loose'), {}, join(root, 'home')), 'loose');
});

test('detectProject yields no project in the home directory or at /', () => {
  const home = tmp();
  assert.equal(detectProject(home, {}, home), undefined);
  assert.equal(detectProject('/', {}, home), undefined);
});

test('detectProject ignores a repo root that is the home directory itself', () => {
  const home = tmp();
  mkdirSync(join(home, '.git'));
  mkdirSync(join(home, 'proj'));
  assert.equal(detectProject(join(home, 'proj'), {}, home), 'proj');
  assert.equal(detectProject(home, {}, home), undefined);
});

test('RTM_PROJECT overrides detection; empty disables it', () => {
  const root = tmp();
  mkdirSync(join(root, 'ignored', '.git'), { recursive: true });
  assert.equal(detectProject(join(root, 'ignored'), { RTM_PROJECT: 'My Project' }, join(root, 'home')), 'my-project');
  assert.equal(detectProject(join(root, 'ignored'), { RTM_PROJECT: '' }, join(root, 'home')), undefined);
});

test('detectProject normalizes to a safe RTM tag', () => {
  const root = tmp();
  mkdirSync(join(root, 'Foo  Bar,Baz'));
  assert.equal(detectProject(join(root, 'Foo  Bar,Baz'), {}, join(root, 'home')), 'foo-barbaz');
});
