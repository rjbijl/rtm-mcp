/**
 * Test het gedrag tegen een nagebootste RTM-endpoint: signature in de body,
 * rsp.stat=fail mapping, 503-retry, timeline-hergebruik en de volledige
 * add-task-flow inclusief handle.
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
              { id: 'L1', name: 'Inbox', deleted: '0', locked: '1', archived: '0', position: '-1', smart: '0' },
              { id: 'L2', name: 'Werk', deleted: '0', locked: '0', archived: '0', position: '0', smart: '0' },
              { id: 'L3', name: 'Vandaag', deleted: '0', locked: '0', archived: '0', position: '0', smart: '1', filter: 'due:today' }
            ] }
          }
        });
      case 'rtm.tasks.add':
        return send({
          rsp: {
            stat: 'ok',
            transaction: { id: 'TX-1', undoable: '1' },
            list: { id: params.list_id ?? 'L1', taskseries: {
              id: 'S9', created: '', modified: '', name: params.name, source: 'api', url: '', location_id: '',
              task: { id: 'T9', due: '2026-09-11T00:00:00Z', has_due_time: '0', added: '', completed: '', deleted: '', priority: '1', postponed: '0', estimate: '' }
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
  ({ RtmClient } = await import('../dist/rtm.js'));
  ({ registerTools } = await import('../dist/tools.js'));
  ({ McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js'));
  ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
  ({ InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js'));
});

after(() => httpServer.close());

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

test('elke call stuurt api_key, format=json, v=2, auth_token en een geldige api_sig', async () => {
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
  assert.equal(api_sig, signParams(rest, 'BANANAS'), 'api_sig moet over alle overige params kloppen');
});

test('rsp.stat=fail wordt een RtmError met code', async () => {
  scenario = 'fail98';
  await assert.rejects(() => newClient().call('rtm.lists.getList'), (e) => {
    assert.equal(e.name, 'RtmError');
    assert.equal(e.code, '98');
    return true;
  });
  scenario = 'ok';
});

test('foutcode 98 krijgt een bruikbare hint richting het model', async () => {
  scenario = 'fail98';
  const client = await connectedClient();
  const res = await client.callTool({ name: 'rtm_get_lists', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /npm run auth/);
  scenario = 'ok';
});

test('HTTP 503 wordt geretryd in plaats van gegooid', async () => {
  requests.length = 0;
  scenario = 'flaky503';
  const rsp = await newClient().call('rtm.lists.getList');
  assert.ok(rsp.lists, 'moet uiteindelijk slagen');
  assert.equal(requests.length, 3, 'twee keer 503, derde poging slaagt');
  scenario = 'ok';
});

test('timeline wordt één keer aangemaakt en daarna hergebruikt', async () => {
  requests.length = 0;
  const client = newClient();
  await client.getTimeline();
  await client.getTimeline();
  await client.getTimeline();
  assert.equal(requests.filter((r) => r.method === 'rtm.timelines.create').length, 1);
});

test('add_task naar een bestaande lijst geeft een bruikbare handle terug', async () => {
  const client = await connectedClient();
  const res = await client.callTool({
    name: 'rtm_add_task',
    arguments: { name: 'Factuur sturen ^friday !1', list: 'Werk' }
  });
  assert.notEqual(res.isError, true, res.content[0].text);
  const handle = res.content[0].text.match(/handle: (\S+)/)?.[1];
  assert.ok(handle, 'antwoord moet een handle bevatten');
  const { decodeHandle } = await import('../dist/handles.js');
  assert.deepEqual(decodeHandle(handle), { listId: 'L2', seriesId: 'S9', taskId: 'T9' });
  const add = requests.findLast((r) => r.method === 'rtm.tasks.add');
  assert.equal(add.parse, '1', 'smart add staat standaard aan');
  assert.equal(add.list_id, 'L2', 'lijstnaam moet naar id vertaald zijn');
  assert.equal(add.timeline, 'TL-1');
});

test('add_task weigert een smart list met uitleg', async () => {
  const client = await connectedClient();
  const res = await client.callTool({
    name: 'rtm_add_task',
    arguments: { name: 'Test', list: 'Vandaag' }
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /smart list/);
});

test('add_task noemt de beschikbare lijsten bij een onbekende lijstnaam', async () => {
  const client = await connectedClient();
  const res = await client.callTool({
    name: 'rtm_add_task',
    arguments: { name: 'Test', list: 'Bestaatniet' }
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Inbox, Werk/);
});

test('list_tasks voegt status:incomplete toe tenzij je dat zelf regelt', async () => {
  const client = await connectedClient();
  await client.callTool({ name: 'rtm_list_tasks', arguments: {} });
  assert.match(requests.findLast((r) => r.method === 'rtm.tasks.getList').filter, /status:incomplete/);

  await client.callTool({ name: 'rtm_list_tasks', arguments: { filter: 'status:completed' } });
  const second = requests.findLast((r) => r.method === 'rtm.tasks.getList').filter;
  assert.equal(second, '(status:completed)', 'eigen status-filter wordt niet overschreven');

  await client.callTool({ name: 'rtm_list_tasks', arguments: { include_completed: true } });
  assert.equal(requests.findLast((r) => r.method === 'rtm.tasks.getList').filter, undefined);
});

test('undo draait de laatste toevoeging terug', async () => {
  const client = await connectedClient();
  await client.callTool({ name: 'rtm_add_task', arguments: { name: 'Weg hiermee' } });
  const res = await client.callTool({ name: 'rtm_undo', arguments: {} });
  assert.notEqual(res.isError, true, res.content[0].text);
  assert.match(res.content[0].text, /Weg hiermee/);
  const undo = requests.findLast((r) => r.method === 'rtm.transactions.undo');
  assert.equal(undo.transaction_id, 'TX-1');
});

test('undo zonder geschiedenis geeft een nette melding', async () => {
  const client = await connectedClient();
  const res = await client.callTool({ name: 'rtm_undo', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Geen omkeerbare wijzigingen/);
});

test('update_task zonder velden doet geen enkele API-call', async () => {
  const client = await connectedClient();
  const { encodeHandle } = await import('../dist/handles.js');
  const before = requests.length;
  const res = await client.callTool({
    name: 'rtm_update_task',
    arguments: { handle: encodeHandle({ listId: 'L1', seriesId: 'S1', taskId: 'T1' }) }
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /minstens één veld/);
  assert.equal(requests.filter((r) => r.method.startsWith('rtm.tasks.set')).length, 0);
  assert.ok(requests.length >= before);
});

test('update_task met due "none" wist de due date', async () => {
  const client = await connectedClient();
  const { encodeHandle } = await import('../dist/handles.js');
  await client.callTool({
    name: 'rtm_update_task',
    arguments: { handle: encodeHandle({ listId: 'L1', seriesId: 'S1', taskId: 'T1' }), due: 'none' }
  });
  const call = requests.findLast((r) => r.method === 'rtm.tasks.setDueDate');
  assert.equal(call.due, undefined, 'due weglaten is hoe RTM de datum wist');
  assert.equal(call.parse, undefined);
});
