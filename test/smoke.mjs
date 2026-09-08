/**
 * Smoke test: start the real server over stdio with a real MCP client,
 * list the tools and check that a failing call comes back as a clean
 * tool error instead of tearing down the connection.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: {
    ...process.env,
    RTM_API_KEY: 'dummy_key_for_smoke_test',
    RTM_SHARED_SECRET: 'BANANAS',
    RTM_AUTH_TOKEN: 'dummy_token'
  },
  stderr: 'pipe'
});

const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools/list: ${tools.length} tools`);
for (const t of tools) {
  const required = Object.keys(t.inputSchema?.properties ?? {});
  console.log(`  - ${t.name}(${required.join(', ')})`);
}

const expected = [
  'rtm_add_task',
  'rtm_list_tasks',
  'rtm_complete_task',
  'rtm_update_task',
  'rtm_delete_task',
  'rtm_get_lists',
  'rtm_undo'
];
const missing = expected.filter((n) => !tools.some((t) => t.name === n));
if (missing.length) {
  console.error(`MISSING: ${missing.join(', ')}`);
  process.exit(1);
}

// Invalid handle: must give a clean tool error, not a crash.
const bad = await client.callTool({
  name: 'rtm_complete_task',
  arguments: { handle: 'junk' }
});
console.log(`\ninvalid handle -> isError=${bad.isError}: ${bad.content[0].text}`);
if (!bad.isError) {
  console.error('EXPECTED a tool error');
  process.exit(1);
}

// Real call with fake credentials: RTM must return an error code that we translate.
const denied = await client.callTool({ name: 'rtm_get_lists', arguments: {} });
console.log(`fake credentials -> isError=${denied.isError}: ${denied.content[0].text}`);

// The connection must still be alive after two errors.
const again = await client.listTools();
console.log(`\nconnection still alive: ${again.tools.length} tools`);

await client.close();
console.log('SMOKE OK');
