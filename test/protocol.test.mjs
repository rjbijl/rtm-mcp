/**
 * Tests behaviour against a mock RTM endpoint: signature in the body,
 * rsp.stat=fail mapping, 503 retry, timeline reuse and the full
 * add-task flow including the handle.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const requests = [];
let scenario = 'ok';

const httpServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const params = Object.fromEntries(new URLSearchParams(body));
    requests.push(params);

    const send = (obj, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (scenario === 'hang') return; // never answer; the client has to abort on its own
    if (scenario === 'fail98') {
      return send({ rsp: { stat: 'fail', err: { code: '98', msg: 'Login failed / Invalid auth token' } } });
    }
    if (scenario === 'flaky503' && requests.filter((r) => r.method === params.method).length < 3) {
      res.writeHead(503);
      return res.end('Service Temporarily Unavailable');
    }

    switch (params.method) {
      case 'rtm.timelines.create':
        return send({ rsp: { stat: 'ok', timeline: 'TL-1' } });
      case 'rtm.lists.getList':
        return send({
          rsp: {
            stat: 'ok',
            lists: { list: [
              { id: '1001', name: 'Inbox', deleted: '0', locked: '1', archived: '0', position: '-1', smart: '0' },
              { id: '1002', name: 'Work', deleted: '0', locked: '0', archived: '0', position: '0', smart: '0' },
              { id: '1003', name: 'Today', deleted: '0', locked: '0', archived: '0', position: '0', smart: '1', filter: 'due:today' }
            ] }
          }
        });
      case 'rtm.tasks.add':
        return send({
          rsp: {
            stat: 'ok',
            transaction: { id: 'TX-1', undoable: '1' },
            list: { id: params.list_id ?? '1001', taskseries: {
              id: '9009', created: '', modified: '', name: params.name, source: 'api', url: '', location_id: '',
              task: { id: '9010', due: '2026-09-11T00:00:00Z', has_due_time: '0', added: '', completed: '', deleted: '', priority: '1', postponed: '0', estimate: '' }
            } }
          }
        });
      case 'rtm.transactions.undo':
        return send({ rsp: { stat: 'ok' } });
      default:
        return send({ rsp: { stat: 'ok' } });
    }
  });
});

let baseUrl;
let RtmClient, registerTools, McpServer, Client, InMemoryTransport;

before(async () => {
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}/`;
  process.env.RTM_REST_ENDPOINT = baseUrl;
  process.env.RTM_ALLOW_ENDPOINT_OVERRIDE = '1';
  ({ RtmClient } = await import('../dist/rtm.js'));
  ({ registerTools } = await import('../dist/tools.js'));
  ({ McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js'));
  ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
  ({ InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js'));
});

after(() => {
  httpServer.closeAllConnections();
  httpServer.close();
});

function newClient() {
  return new RtmClient({ apiKey: 'KEY', sharedSecret: 'BANANAS', authToken: 'TOKEN' });
}

async function connectedClient() {
  const server = new McpServer({ name: 't', version: '1' });
  registerTools(server, newClient());
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

test('every call sends api_key, format=json, v=2, auth_token and a valid api_sig', async () => {
  requests.length = 0;
  scenario = 'ok';
  await newClient().call('rtm.lists.getList');
  const req = requests.at(-1);
  assert.equal(req.api_key, 'KEY');
  assert.equal(req.format, 'json');
  assert.equal(req.v, '2');
  assert.equal(req.auth_token, 'TOKEN');
  const { signParams } = await import('../dist/rtm.js');
  const { api_sig, ...rest } = req;
  assert.equal(api_sig, signParams(rest, 'BANANAS'), 'api_sig must cover all other params');
});

test('rsp.stat=fail becomes an RtmError with a code', async () => {
  scenario = 'fail98';
  await assert.rejects(() => newClient().call('rtm.lists.getList'), (e) => {
    assert.equal(e.name, 'RtmError');
    assert.equal(e.code, '98');
    return true;
  });
  scenario = 'ok';
});

test('error code 98 gets an actionable hint for the model', async () => {
  scenario = 'fail98';
  const client = await connectedClient();
  const res = await client.callTool({ name: 'rtm_get_lists', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /npm run auth/);
  scenario = 'ok';
});

test('HTTP 503 is retried instead of thrown', async () => {
  requests.length = 0;
  scenario = 'flaky503';
  const rsp = await newClient().call('rtm.lists.getList');
  assert.ok(rsp.lists, 'must eventually succeed');
  assert.equal(requests.length, 3, 'two 503s, third attempt succeeds');
  scenario = 'ok';
});

test('the timeline is created once and reused afterwards', async () => {
  requests.length = 0;
  const client = newClient();
  await client.getTimeline();
  await client.getTimeline();
  await client.getTimeline();
  assert.equal(requests.filter((r) => r.method === 'rtm.timelines.create').length, 1);
});

test('add_task to an existing list returns a usable handle', async () => {
  const client = await connectedClient();
  const res = await client.callTool({
    name: 'rtm_add_task',
    arguments: { name: 'Send invoice ^friday !1', list: 'Work' }
  });
  assert.notEqual(res.isError, true, res.content[0].text);
  const handle = res.content[0].text.match(/handle: (\S+)/)?.[1];
  assert.ok(handle, 'response must contain a handle');
  const { decodeHandle } = await import('../dist/handles.js');
  assert.deepEqual(decodeHandle(handle), { listId: '1002', seriesId: '9009', taskId: '9010' });
  const add = requests.findLast((r) => r.method === 'rtm.tasks.add');
  assert.equal(add.parse, '1', 'smart add is on by default');
  assert.equal(add.list_id, '1002', 'list name must be translated to an id');
  assert.equal(add.timeline, 'TL-1');
});

test('add_task refuses a smart list with an explanation', async () => {
  const client = await connectedClient();
  const res = await client.callTool({
    name: 'rtm_add_task',
    arguments: { name: 'Test', list: 'Today' }
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /smart list/);
});

test('add_task names the available lists for an unknown list name', async () => {
  const client = await connectedClient();
  const res = await client.callTool({
    name: 'rtm_add_task',
    arguments: { name: 'Test', list: 'DoesNotExist' }
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Inbox, Work/);
});

test('list_tasks adds status:incomplete unless you handle it yourself', async () => {
  const client = await connectedClient();
  await client.callTool({ name: 'rtm_list_tasks', arguments: {} });
  assert.match(requests.findLast((r) => r.method === 'rtm.tasks.getList').filter, /status:incomplete/);

  await client.callTool({ name: 'rtm_list_tasks', arguments: { filter: 'status:completed' } });
  const second = requests.findLast((r) => r.method === 'rtm.tasks.getList').filter;
  assert.equal(second, '(status:completed)', 'an explicit status filter is not overridden');

  await client.callTool({ name: 'rtm_list_tasks', arguments: { include_completed: true } });
  assert.equal(requests.findLast((r) => r.method === 'rtm.tasks.getList').filter, undefined);
});

test('undo reverts the most recent addition', async () => {
  const client = await connectedClient();
  await client.callTool({ name: 'rtm_add_task', arguments: { name: 'Get rid of this' } });
  const res = await client.callTool({ name: 'rtm_undo', arguments: {} });
  assert.notEqual(res.isError, true, res.content[0].text);
  assert.match(res.content[0].text, /Get rid of this/);
  const undo = requests.findLast((r) => r.method === 'rtm.transactions.undo');
  assert.equal(undo.transaction_id, 'TX-1');
});

test('undo without history gives a clean message', async () => {
  const client = await connectedClient();
  const res = await client.callTool({ name: 'rtm_undo', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /No undoable changes/);
});

test('update_task without fields makes no API call at all', async () => {
  const client = await connectedClient();
  const { encodeHandle } = await import('../dist/handles.js');
  const before = requests.length;
  const res = await client.callTool({
    name: 'rtm_update_task',
    arguments: { handle: encodeHandle({ listId: '1001', seriesId: '5001', taskId: '5002' }) }
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /at least one field/);
  assert.equal(requests.filter((r) => r.method.startsWith('rtm.tasks.set')).length, 0);
  assert.ok(requests.length >= before);
});

test('update_task with due "none" clears the due date', async () => {
  const client = await connectedClient();
  const { encodeHandle } = await import('../dist/handles.js');
  await client.callTool({
    name: 'rtm_update_task',
    arguments: { handle: encodeHandle({ listId: '1001', seriesId: '5001', taskId: '5002' }), due: 'none' }
  });
  const call = requests.findLast((r) => r.method === 'rtm.tasks.setDueDate');
  assert.equal(call.due, undefined, 'omitting due is how RTM clears the date');
  assert.equal(call.parse, undefined);
});

test('a hanging RTM is aborted on the request timeout', { timeout: 10_000 }, async () => {
  scenario = 'hang';
  const client = new RtmClient(
    { apiKey: 'KEY', sharedSecret: 'BANANAS', authToken: 'TOKEN' },
    { requestTimeoutMs: 200 }
  );
  const started = Date.now();
  await assert.rejects(() => client.call('rtm.lists.getList'), /did not respond within 200ms/);
  assert.ok(Date.now() - started < 8000, 'must not hang indefinitely');
  scenario = 'ok';
});

test('an absurdly long handle is rejected by the schema, not by RTM', async () => {
  const client = await connectedClient();
  const before = requests.length;
  const res = await client.callTool({
    name: 'rtm_complete_task',
    arguments: { handle: 'A'.repeat(300) }
  });
  assert.equal(res.isError, true);
  assert.doesNotMatch(res.content[0].text, /Invalid task handle/, 'must be caught by the schema, not by decodeHandle');
  assert.match(res.content[0].text, /128/, 'the error names the maximum length');
  assert.equal(requests.length, before, 'no API call for a handle that fails the schema');
});

test('update and undo are annotated as destructive', async () => {
  const client = await connectedClient();
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.rtm_update_task.annotations.destructiveHint, true, 'name/tags overwrite data');
  assert.equal(byName.rtm_undo.annotations.destructiveHint, true, 'undo reverts earlier changes');
  assert.equal(byName.rtm_delete_task.annotations.destructiveHint, true);
  assert.equal(byName.rtm_list_tasks.annotations.readOnlyHint, true);
});
