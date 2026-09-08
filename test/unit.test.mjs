import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signParams, asArray } from '../dist/rtm.js';
import { encodeHandle, decodeHandle } from '../dist/handles.js';
import { flattenTasks } from '../dist/format.js';

test('api_sig komt overeen met RTM\'s eigen voorbeeld', () => {
  // Uit https://www.rememberthemilk.com/services/api/authentication.rtm
  // secret BANANAS, params yxz=foo feg=bar abc=baz -> 82044aae4dd676094f23f1ec152159ba
  const sig = signParams({ yxz: 'foo', feg: 'bar', abc: 'baz' }, 'BANANAS');
  assert.equal(sig, '82044aae4dd676094f23f1ec152159ba');
});

test('api_sig negeert een al aanwezige api_sig', () => {
  const a = signParams({ yxz: 'foo', feg: 'bar', abc: 'baz' }, 'BANANAS');
  const b = signParams({ yxz: 'foo', feg: 'bar', abc: 'baz', api_sig: 'rommel' }, 'BANANAS');
  assert.equal(a, b);
});

test('api_sig sorteert op key, niet op invoegvolgorde', () => {
  const a = signParams({ b: '2', a: '1', c: '3' }, 's3cr3t');
  const b = signParams({ c: '3', a: '1', b: '2' }, 's3cr3t');
  assert.equal(a, b);
});

test('api_sig gebruikt UTF-8 bytes', () => {
  // Mag niet crashen en moet stabiel zijn voor niet-ASCII taaknamen
  const sig = signParams({ name: 'Café: façade opnieuw beoordelen ☕' }, 'BANANAS');
  assert.match(sig, /^[0-9a-f]{32}$/);
});

test('asArray normaliseert RTM\'s single-vs-array JSON', () => {
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray({ id: '1' }), [{ id: '1' }]);
  assert.deepEqual(asArray([{ id: '1' }, { id: '2' }]), [{ id: '1' }, { id: '2' }]);
});

test('task handle roundtrip', () => {
  const ref = { listId: '111', seriesId: '222', taskId: '333' };
  assert.deepEqual(decodeHandle(encodeHandle(ref)), ref);
});

test('ongeldige handle geeft een bruikbare fout', () => {
  assert.throws(() => decodeHandle('niet-base64-met-triple'), /Ongeldige task handle/);
  assert.throws(() => decodeHandle(Buffer.from('1:2').toString('base64url')), /Ongeldige task handle/);
});

test('flattenTasks pakt meerdere instanties van een herhalende taskseries', () => {
  const rsp = {
    tasks: {
      list: {
        id: 'L1',
        taskseries: {
          id: 'S1',
          name: 'Standup',
          tags: { tag: 'werk' },
          task: [
            { id: 'T1', due: '2026-09-09T00:00:00Z', has_due_time: '0', priority: '2', completed: '', deleted: '' },
            { id: 'T2', due: '2026-09-10T00:00:00Z', has_due_time: '0', priority: '2', completed: '', deleted: '' }
          ]
        }
      }
    }
  };
  const tasks = flattenTasks(rsp, new Map([['L1', 'Werk']]));
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((t) => t.due), ['2026-09-09', '2026-09-10']);
  assert.deepEqual(tasks[0].tags, ['werk']);
  assert.equal(tasks[0].listName, 'Werk');
  assert.notEqual(tasks[0].handle, tasks[1].handle);
});

test('flattenTasks slaat verwijderde taken over en overleeft één-element-objecten', () => {
  const rsp = {
    tasks: {
      list: [
        {
          id: 'L1',
          taskseries: [
            { id: 'S1', name: 'Weg', task: { id: 'T1', deleted: '2026-01-01T00:00:00Z', due: '', has_due_time: '0', priority: 'N', completed: '' } },
            { id: 'S2', name: 'Blijft', task: { id: 'T2', deleted: '', due: '', has_due_time: '0', priority: '1', completed: '' } }
          ]
        }
      ]
    }
  };
  const tasks = flattenTasks(rsp, new Map([['L1', 'Inbox']]));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].name, 'Blijft');
  assert.equal(tasks[0].priority, '!1');
});
