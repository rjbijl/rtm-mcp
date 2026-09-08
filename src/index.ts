#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadCredentials } from './config.js';
import { RtmClient } from './rtm.js';
import { detectProject } from './project.js';
import { registerTools } from './tools.js';

/**
 * With stdio transport, stdout IS the JSON-RPC channel. A single console.log
 * breaks the connection. All diagnostics therefore go to stderr.
 */
function log(msg: string): void {
  process.stderr.write(`[rtm-mcp] ${msg}\n`);
}

async function main(): Promise<void> {
  const creds = loadCredentials(true);
  const client = new RtmClient(creds);
  // Claude Code starts us with the project directory as cwd; that name becomes the project tag.
  const project = detectProject();

  const server = new McpServer(
    { name: 'rtm-mcp', version: '0.1.0' },
    {
      instructions:
        'Remember The Milk. Tasks can be added using Smart Add syntax in the name. ' +
        'To update, complete or delete a task you need a handle from rtm_list_tasks or ' +
        'rtm_add_task. RTM allows only 1 request per second, so do not fetch more than needed.' +
        (project
          ? ` This session runs in project "${project}": new tasks are tagged with it and ` +
            'rtm_list_tasks only shows tasks with that tag unless all_projects is set.'
          : '')
    }
  );

  registerTools(server, client, { project });

  // Validate the token once at startup instead of on every call.
  try {
    const rsp = await client.call<{ auth: { perms: string; user: { username: string } } }>(
      'rtm.auth.checkToken'
    );
    log(`logged in as ${rsp.auth.user.username} (perms: ${rsp.auth.perms})`);
  } catch (e) {
    log(`warning: token check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  await server.connect(new StdioServerTransport());
  log(project ? `server running on stdio, project "${project}"` : 'server running on stdio, no project');
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
