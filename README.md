# rtm-mcp

MCP server for Remember The Milk. Stdio transport, meant to add and fetch tasks
from Claude Code in WSL (or any other local MCP client).

## What it does

| Tool | Purpose |
|---|---|
| `rtm_add_task` | Add a task, with Smart Add syntax (`^friday !1 #Work`) or as literal text |
| `rtm_list_tasks` | Fetch tasks using RTM's filter language (`status:incomplete AND dueBefore:today`) |
| `rtm_complete_task` | Mark as complete |
| `rtm_update_task` | Name, due date, priority, tags, estimate |
| `rtm_delete_task` | Delete (soft delete on RTM's side) |
| `rtm_get_lists` | Lists, with smart lists marked |
| `rtm_undo` | Revert the last undoable change(s) made in this session |

The Smart Add tokens and the filter syntax are part of the tool descriptions,
so the model does not have to guess them.

## Install

```bash
git clone https://github.com/rjbijl/rtm-mcp.git ~/tools/rtm-mcp
cd ~/tools/rtm-mcp
npm install
npm run build
```

Put your key and secret in the environment and authorize once:

```bash
export RTM_API_KEY=your_key
export RTM_SHARED_SECRET=your_secret
npm run auth
```

That prints a URL. Approve it in the browser, press Enter, and the token ends
up in `~/.config/rtm-mcp/auth.json` (mode 600). The token does not expire on
its own; only when you revoke access in RTM.

## Hooking it into Claude Code

```bash
claude mcp add --scope user rtm \
  --env RTM_API_KEY=your_key \
  --env RTM_SHARED_SECRET=your_secret \
  -- node /home/YOUR_USER/tools/rtm-mcp/dist/index.js
```

`--scope user` puts it in `~/.claude.json` so it is available in all your
projects. The path must be absolute: Claude Code starts this process itself and
has no idea what your working directory is.

Verify with `/mcp` in a session, or `claude mcp list`.

## How it works

Claude Code starts `dist/index.js` as a subprocess and talks JSON-RPC over
stdin/stdout. So there is no daemon and no port. Consequence: **stdout is
sacred**; all logging in this server goes to stderr. One `console.log` on the
server path and the connection is broken.

What the client handles for you:

- **api_sig signing.** md5 of your shared secret plus all parameters sorted
  alphabetically and concatenated.
- **Rate limiting.** RTM allows 1 request per second with bursts up to 3.
  Beyond that RTM throttles you and eventually returns 503. A token bucket sits
  in front, with exponential backoff on 503.
- **Timeouts.** Every request is aborted after 20 seconds and retried, so a
  stalled connection never blocks a tool call.
- **Timeline reuse.** Every write requires a timeline. One is created per
  process and reused; that saves a call from your per-second budget on every
  action.
- **The single-vs-array quirk.** RTM's JSON turns one element into an object
  and several into an array. Everything goes through a normalization helper.
- **The id triple.** Task operations require `list_id` + `taskseries_id` +
  `task_id`. Those are bundled into one opaque handle so the model cannot mix
  them up.
- **Repeating tasks.** One taskseries can contain several task instances; each
  is returned separately with its own handle.

## Testing

```bash
npm test                       # signing, normalization, handles, flattening
node --test test/protocol.test.mjs   # full tool flows against a mock endpoint
node test/smoke.mjs            # real stdio server through a real MCP client
```

The protocol tests run against a local mock RTM, including 503 retry, timeout
and error-code mapping. To do that they override `RTM_REST_ENDPOINT`. Because
every request carries your `api_key` and `auth_token`, the server refuses such
an override unless `RTM_ALLOW_ENDPOINT_OVERRIDE=1` is set explicitly alongside
it; it then reports the override on stderr. Leave that flag out in production.

## Later: from Cowork as well

Stdio only works on the machine where Claude Code runs. If you want to reach
the same tasks from Cowork or claude.ai, a remote HTTP variant is needed:
`StreamableHTTPServerTransport` from the same SDK wrapped around
`src/index.ts`, running on a publicly reachable machine, with OAuth in front.
The tools in `src/tools.ts` and the client in `src/rtm.ts` are
transport-agnostic and can move over as-is.

Alternative for that scenario: RTM's own hosted MCP server at
`https://www.rememberthemilk.com/mcp`, which works in both surfaces but
requires a Pro subscription.

## License and origin

MIT, see [LICENSE](LICENSE). Built by Robert-Jan Bijl together with Claude
(Anthropic's Claude Code); the tests, the security hardening and most of the
code came out of that collaboration.
