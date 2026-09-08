/**
 * Live check against the real RTM API. Read-only: lists and at most five open
 * tasks. Needs RTM_API_KEY, RTM_SHARED_SECRET and an authorized token
 * (~/.config/rtm-mcp/auth.json or RTM_AUTH_TOKEN). Not part of `npm test`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (!process.env.RTM_API_KEY || !process.env.RTM_SHARED_SECRET) {
  console.error('RTM_API_KEY and RTM_SHARED_SECRET must be set in this shell.');
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env },
  stderr: 'pipe'
});
transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));

const client = new Client({ name: 'live', version: '1.0.0' });
await client.connect(transport);

const show = (label, res) => {
  console.log(`\n== ${label}${res.isError ? ' (ERROR)' : ''}`);
  console.log(res.content[0].text);
  if (res.isError) process.exitCode = 1;
};

show('rtm_get_lists', await client.callTool({ name: 'rtm_get_lists', arguments: {} }));
show(
  'rtm_list_tasks (limit 5)',
  await client.callTool({ name: 'rtm_list_tasks', arguments: { limit: 5 } })
);

await client.close();
console.log(process.exitCode ? '\nLIVE CHECK FAILED' : '\nLIVE OK');
