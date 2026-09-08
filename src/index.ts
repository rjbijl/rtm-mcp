#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadCredentials } from './config.js';
import { RtmClient } from './rtm.js';
import { registerTools } from './tools.js';

/**
 * Bij stdio-transport IS stdout het JSON-RPC kanaal. Eén console.log en de
 * verbinding is stuk. Alle diagnostiek gaat daarom naar stderr.
 */
function log(msg: string): void {
  process.stderr.write(`[rtm-mcp] ${msg}\n`);
}

async function main(): Promise<void> {
  const creds = loadCredentials(true);
  const client = new RtmClient(creds);

  const server = new McpServer(
    { name: 'rtm-mcp', version: '0.1.0' },
    {
      instructions:
        'Remember The Milk. Taken toevoegen kan met Smart Add syntax in de naam. ' +
        'Voor wijzigen/afvinken/verwijderen heb je een handle nodig uit rtm_list_tasks of ' +
        'rtm_add_task. RTM staat maar 1 request per seconde toe, dus vraag niet meer op dan nodig.'
    }
  );

  registerTools(server, client);

  // Valideer het token één keer bij het opstarten in plaats van bij elke call.
  try {
    const rsp = await client.call<{ auth: { perms: string; user: { username: string } } }>(
      'rtm.auth.checkToken'
    );
    log(`ingelogd als ${rsp.auth.user.username} (perms: ${rsp.auth.perms})`);
  } catch (e) {
    log(`waarschuwing: token check faalde: ${e instanceof Error ? e.message : String(e)}`);
  }

  await server.connect(new StdioServerTransport());
  log('server draait op stdio');
}

main().catch((e) => {
  log(`fataal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
