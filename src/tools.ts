import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RtmClient, RtmError, asArray, type RtmTaskSeries, type RtmTransaction } from './rtm.js';
import { decodeHandle, encodeHandle } from './handles.js';
import { flattenTasks, renderLists, renderTasks } from './format.js';

const SMART_ADD_HELP = `
Smart Add syntax (in the name field, only when smart_add=true):
  ^  due date/time    ^tomorrow, ^friday 17:00, ^15/3/2026, ^next monday
  !  priority 1-3     !1
  #  list OR tag      #Work  (matches an existing list name first, otherwise becomes a tag)
  @  location         @office
  *  repeat           *daily, *every week, *after 2 weeks
  =  time estimate    =30 min, =2 hours
  a URL in the text is attached to the task
Note: # is ambiguous. If you need a specific list for sure, use the list
parameter instead of #Name.`.trim();

const FILTER_HELP = `
Filter syntax (the same language as RTM's advanced search / smart lists):
  status:incomplete | status:completed
  list:Inbox | list:"Dead Projects"
  priority:1 | priority:none
  due:today | due:never | dueBefore:today | dueAfter:"today 23:59"
  dueWithin:"1 week of today"
  tag:work | isTagged:false | tagContains:@
  addedWithin:"1 week of today" | completedWithin:"1 week of today"
  isRepeating:true | hasNotes:false | noteContains:foo
  combine with AND, OR, NOT and parentheses
Always put values containing spaces in double quotes.
Example: status:incomplete AND (dueBefore:today OR due:today)`.trim();

/** Three numeric ids plus separators in base64url stays well under 128. */
const handleSchema = z.string().max(128).describe('Task handle.');

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

function errorText(content: string) {
  return { content: [{ type: 'text' as const, text: content }], isError: true };
}

/** Translates RTM error codes into something the model can act on. */
function explain(e: unknown): string {
  if (e instanceof RtmError) {
    const hints: Record<string, string> = {
      '98': 'The auth token is invalid or has been revoked. Run `npm run auth` again.',
      '99': 'Insufficient permissions for this action.',
      '320': 'Invalid list.',
      '340': 'Invalid task handle; fetch a fresh one with rtm_list_tasks.',
      '3040': 'This list is read-only.',
      '4020': 'You cannot add a task to a smart list; pick a regular list.',
      '4040': 'Subtasks require an RTM Pro account.',
      '4080': 'The due date is before the start date.'
    };
    const hint = hints[e.code];
    return hint ? `${e.message}\n${hint}` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

async function listNameMap(client: RtmClient): Promise<Map<string, string>> {
  const lists = await client.getLists();
  return new Map(lists.map((l) => [l.id, l.name]));
}

export interface ToolOptions {
  /** Project tag for this session, see detectProject(). Undefined disables project tagging. */
  project?: string;
}

export function registerTools(server: McpServer, client: RtmClient, opts: ToolOptions = {}): void {
  const { project } = opts;

  server.registerTool(
    'rtm_add_task',
    {
      title: 'Add a task to Remember The Milk',
      description:
        'Adds a task to Remember The Milk. Without the list parameter the task goes to the Inbox.\n\n' +
        (project
          ? `Current project: "${project}". New tasks are tagged "${project}" automatically; ` +
            'pass tag_project=false for tasks unrelated to this project.\n\n'
          : '') +
        SMART_ADD_HELP,
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe('The task name, optionally with Smart Add tokens when smart_add is true.'),
        list: z
          .string()
          .optional()
          .describe('Name of the list the task should go in. Omit for Inbox.'),
        smart_add: z
          .boolean()
          .default(true)
          .describe('Smart Add parsing of ^ ! # @ * = in the name. Set to false for literal text.'),
        note: z.string().optional().describe('Optional note attached to the task.'),
        tag_project: z
          .boolean()
          .default(true)
          .describe('Tag the task with the current project. Set to false for unrelated tasks.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ name, list, smart_add, note, tag_project }) => {
      try {
        const timeline = await client.getTimeline();
        let listId: string | undefined;

        if (list) {
          const target = await client.findList(list);
          if (!target) {
            const available = (await client.getLists())
              .filter((l) => l.deleted !== '1' && l.smart !== '1')
              .map((l) => l.name)
              .join(', ');
            return errorText(`List "${list}" does not exist. Available: ${available}`);
          }
          if (target.smart === '1') {
            return errorText(`"${list}" is a smart list; tasks cannot be added to it.`);
          }
          listId = target.id;
        }

        const rsp = await client.call<{
          transaction?: RtmTransaction;
          list: { id: string; taskseries: RtmTaskSeries | RtmTaskSeries[] };
        }>('rtm.tasks.add', {
          timeline,
          name,
          parse: smart_add ? '1' : undefined,
          list_id: listId
        });

        client.recordTransaction(rsp.transaction, `task added: ${name}`);

        const series = asArray(rsp.list.taskseries)[0];
        const task = asArray(series.task)[0];
        const handle = encodeHandle({
          listId: rsp.list.id,
          seriesId: series.id,
          taskId: task.id
        });

        const ids = { timeline, list_id: rsp.list.id, taskseries_id: series.id, task_id: task.id };

        // A separate addTags call rather than "#project" in the name: # matches a list
        // name first, and Smart Add is off entirely when smart_add=false.
        const projectTag = project && tag_project ? project : undefined;
        if (projectTag) {
          await client.call('rtm.tasks.addTags', { ...ids, tags: projectTag });
        }

        if (note) {
          await client.call('rtm.tasks.notes.add', { ...ids, note_title: '', note_text: note });
        }

        const names = await listNameMap(client);
        const where = names.get(rsp.list.id) ?? rsp.list.id;
        const due = task.due ? ` (due ${task.due})` : '';
        const tagged = projectTag ? ` #${projectTag}` : '';
        return text(`Added to ${where}: "${series.name}"${due}${tagged}\nhandle: ${handle}`);
      } catch (e) {
        return errorText(explain(e));
      }
    }
  );

  server.registerTool(
    'rtm_list_tasks',
    {
      title: 'List tasks from Remember The Milk',
      description:
        'Fetches tasks. Only incomplete tasks by default. Every task comes with a handle that you ' +
        'need to complete, update or delete it.\n\n' +
        (project
          ? `Current project: "${project}". Results are limited to tasks tagged "${project}"; ` +
            'pass all_projects=true to search across everything.\n\n'
          : '') +
        FILTER_HELP,
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe('RTM filter expression. Combined with include_completed.'),
        list: z.string().optional().describe('Restrict to this list name.'),
        include_completed: z
          .boolean()
          .default(false)
          .describe('Include completed tasks as well.'),
        limit: z.number().int().min(1).max(200).default(50).describe('Maximum number of tasks.'),
        all_projects: z
          .boolean()
          .default(false)
          .describe('Do not restrict to the current project tag.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ filter, list, include_completed, limit, all_projects }) => {
      try {
        let listId: string | undefined;
        if (list) {
          const target = await client.findList(list);
          if (!target) return errorText(`List "${list}" does not exist.`);
          listId = target.id;
        }

        // Without a status filter RTM also returns every completed task.
        const clauses: string[] = [];
        if (filter) clauses.push(`(${filter})`);
        if (!include_completed && !/status:/i.test(filter ?? '')) {
          clauses.push('status:incomplete');
        }
        if (project && !all_projects) clauses.push(`tag:${project}`);
        const effectiveFilter = clauses.join(' AND ') || undefined;

        const rsp = await client.call<{ tasks?: { list?: unknown } }>('rtm.tasks.getList', {
          list_id: listId,
          filter: effectiveFilter
        });

        const names = await listNameMap(client);
        const tasks = flattenTasks(rsp, names);
        tasks.sort((a, b) => {
          if (a.due && b.due) return a.due.localeCompare(b.due);
          if (a.due) return -1;
          if (b.due) return 1;
          return a.name.localeCompare(b.name);
        });

        const shown = tasks.slice(0, limit);
        const suffix =
          tasks.length > shown.length ? `\n(${tasks.length - shown.length} more, raise limit)` : '';
        return text(renderTasks(shown) + suffix);
      } catch (e) {
        return errorText(explain(e));
      }
    }
  );

  server.registerTool(
    'rtm_complete_task',
    {
      title: 'Complete a task',
      description: 'Marks a task as complete. Use the handle from rtm_list_tasks or rtm_add_task.',
      inputSchema: { handle: handleSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ handle }) => {
      try {
        const ref = decodeHandle(handle);
        const timeline = await client.getTimeline();
        const rsp = await client.call<{ transaction?: RtmTransaction; list?: unknown }>(
          'rtm.tasks.complete',
          {
            timeline,
            list_id: ref.listId,
            taskseries_id: ref.seriesId,
            task_id: ref.taskId
          }
        );
        client.recordTransaction(rsp.transaction, 'task completed');
        return text('Completed.');
      } catch (e) {
        return errorText(explain(e));
      }
    }
  );

  server.registerTool(
    'rtm_update_task',
    {
      title: 'Update a task',
      description:
        'Changes the name, due date, priority, tags or time estimate of an existing task. ' +
        'Every field you pass costs a separate API call, so only pass what actually changes.\n' +
        'Note: tags REPLACES all existing tags; use add_tags to add to them.',
      inputSchema: {
        handle: handleSchema,
        name: z.string().optional().describe('New task name.'),
        due: z
          .string()
          .optional()
          .describe(
            'New due date. Natural language is fine ("next friday", "tomorrow 9am"). ' +
              'Pass "none" to clear the due date.'
          ),
        priority: z
          .enum(['1', '2', '3', 'none'])
          .optional()
          .describe('Priority 1 (highest) through 3, or "none".'),
        tags: z.array(z.string()).optional().describe('Replaces ALL tags with this list.'),
        add_tags: z.array(z.string()).optional().describe('Adds tags without removing existing ones.'),
        estimate: z.string().optional().describe('Time estimate, e.g. "30 min" or "2 hours".')
      },
      // name and tags overwrite existing data; that is destructive, even though undo can revert it.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    async ({ handle, name, due, priority, tags, add_tags, estimate }) => {
      try {
        const ref = decodeHandle(handle);
        const timeline = await client.getTimeline();
        const base = {
          timeline,
          list_id: ref.listId,
          taskseries_id: ref.seriesId,
          task_id: ref.taskId
        };
        const done: string[] = [];

        if (name !== undefined) {
          await client.call('rtm.tasks.setName', { ...base, name });
          done.push(`name -> "${name}"`);
        }
        if (due !== undefined) {
          if (due.toLowerCase() === 'none' || due === '') {
            // omitting due clears the due date
            await client.call('rtm.tasks.setDueDate', { ...base });
            done.push('due date cleared');
          } else {
            await client.call('rtm.tasks.setDueDate', { ...base, due, parse: '1' });
            done.push(`due -> ${due}`);
          }
        }
        if (priority !== undefined) {
          await client.call('rtm.tasks.setPriority', {
            ...base,
            priority: priority === 'none' ? 'N' : priority
          });
          done.push(`priority -> ${priority}`);
        }
        if (tags !== undefined) {
          await client.call('rtm.tasks.setTags', { ...base, tags: tags.join(',') });
          done.push(`tags -> ${tags.join(', ') || '(none)'}`);
        }
        if (add_tags !== undefined && add_tags.length > 0) {
          await client.call('rtm.tasks.addTags', { ...base, tags: add_tags.join(',') });
          done.push(`tags added: ${add_tags.join(', ')}`);
        }
        if (estimate !== undefined) {
          await client.call('rtm.tasks.setEstimate', { ...base, estimate });
          done.push(`estimate -> ${estimate}`);
        }

        if (done.length === 0) return errorText('Nothing to update: pass at least one field.');
        return text(`Updated: ${done.join('; ')}`);
      } catch (e) {
        return errorText(explain(e));
      }
    }
  );

  server.registerTool(
    'rtm_delete_task',
    {
      title: 'Delete a task',
      description:
        'Deletes a task. RTM does a soft delete, so rtm_undo can revert this. ' +
        'Requires delete permissions on the auth token.',
      inputSchema: { handle: handleSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    async ({ handle }) => {
      try {
        const ref = decodeHandle(handle);
        const timeline = await client.getTimeline();
        const rsp = await client.call<{ transaction?: RtmTransaction }>('rtm.tasks.delete', {
          timeline,
          list_id: ref.listId,
          taskseries_id: ref.seriesId,
          task_id: ref.taskId
        });
        client.recordTransaction(rsp.transaction, 'task deleted');
        return text('Deleted. Use rtm_undo to revert.');
      } catch (e) {
        return errorText(explain(e));
      }
    }
  );

  server.registerTool(
    'rtm_get_lists',
    {
      title: 'Get lists',
      description:
        'Returns all RTM lists. Smart lists are marked; tasks cannot be added to those.',
      inputSchema: {
        refresh: z.boolean().default(false).describe('Bypass the cache and fetch again.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ refresh }) => {
      try {
        return text(renderLists(await client.getLists(refresh)));
      } catch (e) {
        return errorText(explain(e));
      }
    }
  );

  server.registerTool(
    'rtm_undo',
    {
      title: 'Undo the last change',
      description:
        'Reverts the most recent undoable change made in this session (add, complete, ' +
        'update, delete). Without arguments the most recent one is reverted.',
      inputSchema: {
        steps: z.number().int().min(1).max(5).default(1).describe('Number of changes to revert.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    async ({ steps }) => {
      try {
        if (client.recentTransactions.length === 0) {
          return errorText('No undoable changes known in this session.');
        }
        const timeline = await client.getTimeline();
        const undone: string[] = [];
        for (let i = 0; i < steps; i++) {
          const tx = client.recentTransactions.shift();
          if (!tx) break;
          await client.call('rtm.transactions.undo', { timeline, transaction_id: tx.id });
          undone.push(tx.description);
        }
        return text(`Reverted: ${undone.join('; ')}`);
      } catch (e) {
        return errorText(explain(e));
      }
    }
  );
}
