/**
 * Smoke test: start de echte server over stdio met een echte MCP client,
 * inventariseert de tools en controleert dat een falende call netjes als
 * tool-error terugkomt in plaats van de verbinding te slopen.
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
  console.error(`ONTBREEKT: ${missing.join(', ')}`);
  process.exit(1);
}

// Ongeldige handle: moet een nette tool-error geven, geen crash.
const bad = await client.callTool({
  name: 'rtm_complete_task',
  arguments: { handle: 'rommel' }
});
console.log(`\nongeldige handle -> isError=${bad.isError}: ${bad.content[0].text}`);
if (!bad.isError) {
  console.error('VERWACHTTE een tool-error');
  process.exit(1);
}

// Echte call met nep-credentials: RTM moet een foutcode teruggeven die wij vertalen.
const denied = await client.callTool({ name: 'rtm_get_lists', arguments: {} });
console.log(`nep-credentials -> isError=${denied.isError}: ${denied.content[0].text}`);

// Verbinding moet nog leven na twee fouten.
const again = await client.listTools();
console.log(`\nverbinding leeft nog: ${again.tools.length} tools`);

await client.close();
console.log('SMOKE OK');
