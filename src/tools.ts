import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RtmClient, RtmError, asArray, type RtmTaskSeries, type RtmTransaction } from './rtm.js';
import { decodeHandle, encodeHandle } from './handles.js';
import { flattenTasks, renderLists, renderTasks } from './format.js';

const SMART_ADD_HELP = `
Smart Add syntax (in het name-veld, alleen als smart_add=true):
  ^  due date/tijd    ^tomorrow, ^friday 17:00, ^15/3/2026, ^next monday
  !  prioriteit 1-3   !1
  #  lijst OF tag     #Work  (matcht eerst een bestaande lijstnaam, anders wordt het een tag)
  @  locatie          @kantoor
  *  herhaling        *daily, *every week, *after 2 weeks
  =  tijdsinschatting =30 min, =2 hours
  een URL in de tekst wordt aan de taak gekoppeld
Let op: # is dubbelzinnig. Wil je gegarandeerd een specifieke lijst, gebruik dan
de list-parameter in plaats van #Naam.`.trim();

const FILTER_HELP = `
Filter syntax (dezelfde taal als RTM's advanced search / smart lists):
  status:incomplete | status:completed
  list:Inbox | list:"Dead Projects"
  priority:1 | priority:none
  due:today | due:never | dueBefore:today | dueAfter:"today 23:59"
  dueWithin:"1 week of today"
  tag:werk | isTagged:false | tagContains:@
  addedWithin:"1 week of today" | completedWithin:"1 week of today"
  isRepeating:true | hasNotes:false | noteContains:foo
  te combineren met AND, OR, NOT en haakjes
Waarden met spaties altijd tussen dubbele quotes.
Voorbeeld: status:incomplete AND (dueBefore:today OR due:today)`.trim();

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

function errorText(content: string) {
  return { content: [{ type: 'text' as const, text: content }], isError: true };
}

/** Vertaalt RTM-foutcodes naar iets waar het model wat mee kan. */
function explain(e: unknown): string {
  if (e instanceof RtmError) {
    const hints: Record<string, string> = {
      '98': 'Het auth token is ongeldig of ingetrokken. Draai `npm run auth` opnieuw.',
      '99': 'Onvoldoende permissies voor deze actie.',
      '320': 'Ongeldige lijst.',
      '340': 'Ongeldige taak-handle; haal een verse handle op met rtm_list_tasks.',
      '3040': 'Deze lijst is read-only.',
      '4020': 'Je kunt geen taak toevoegen aan een smart list; kies een gewone lijst.',
      '4040': 'Subtaken vereisen een RTM Pro-account.',
      '4080': 'De due date ligt vóór de startdatum.'
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

export function registerTools(server: McpServer, client: RtmClient): void {
  server.registerTool(
    'rtm_add_task',
    {
      title: 'Taak toevoegen aan Remember The Milk',
      description:
        'Voegt een taak toe aan Remember The Milk. Zonder list-parameter komt de taak in de Inbox.\n\n' +
        SMART_ADD_HELP,
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe('De taaknaam, eventueel met Smart Add tokens als smart_add true is.'),
        list: z
          .string()
          .optional()
          .describe('Naam van de lijst waar de taak in moet. Weglaten = Inbox.'),
        smart_add: z
          .boolean()
          .default(true)
          .describe('Smart Add parsing van ^ ! # @ * = in de naam. Zet op false voor letterlijke tekst.'),
        note: z.string().optional().describe('Optionele notitie bij de taak.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ name, list, smart_add, note }) => {
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
            return errorText(`Lijst "${list}" bestaat niet. Beschikbaar: ${available}`);
          }
          if (target.smart === '1') {
            return errorText(`"${list}" is een smart list; daar kun je geen taken aan toevoegen.`);
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

        client.recordTransaction(rsp.transaction, `taak toegevoegd: ${name}`);

        const series = asArray(rsp.list.taskseries)[0];
        const task = asArray(series.task)[0];
        const handle = encodeHandle({
          listId: rsp.list.id,
          seriesId: series.id,
          taskId: task.id
        });

        if (note) {
          await client.call('rtm.tasks.notes.add', {
            timeline,
            list_id: rsp.list.id,
            taskseries_id: series.id,
            task_id: task.id,
            note_title: '',
            note_text: note
          });
        }

        const names = await listNameMap(client);
        const where = names.get(rsp.list.id) ?? rsp.list.id;
        const due = task.due ? ` (due ${task.due})` : '';
        return text(`Toegevoegd aan ${where}: "${series.name}"${due}\nhandle: ${handle}`);
      } catch (e) {
        return errorText(explain(e));
      }
    }
  );

  server.registerTool(
    'rtm_list_tasks',
    {
      title: 'Taken ophalen uit Remember The Milk',
      description:
        'Haalt taken op. Standaard alleen openstaande taken. Elke taak krijgt een handle die je ' +
        'nodig hebt voor afvinken, wijzigen of verwijderen.\n\n' +
        FILTER_HELP,
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe('RTM filter-expressie. Wordt gecombineerd met include_completed.'),
        list: z.string().optional().describe('Beperk tot deze lijstnaam.'),
        include_completed: z
          .boolean()
          .default(false)
          .describe('Ook afgeronde taken meenemen.'),
        limit: z.number().int().min(1).max(200).default(50).describe('Maximum aantal taken.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ filter, list, include_completed, limit }) => {
      try {
        let listId: string | undefined;
        if (list) {
          const target = await client.findList(list);
          if (!target) return errorText(`Lijst "${list}" bestaat niet.`);
          listId = target.id;
        }

        // Zonder status-filter geeft RTM ook alle afgeronde taken terug.
        const clauses: string[] = [];
        if (filter) clauses.push(`(${filter})`);
        if (!include_completed && !/status:/i.test(filter ?? '')) {
          clauses.push('status:incomplete');
        }
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
          tasks.length > shown.length ? `\n(${tasks.length - shown.length} meer, verhoog limit)` : '';
        return text(renderTasks(shown) + suffix);
      } catch (e) {
        return errorText(explain(e));
      }
    }
  );

  server.registerTool(
    'rtm_complete_task',
    {
      title: 'Taak afvinken',
      description: 'Vinkt een taak af. Gebruik de handle uit rtm_list_tasks of rtm_add_task.',
      inputSchema: { handle: z.string().describe('Task handle.') },
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
        client.recordTransaction(rsp.transaction, 'taak afgevinkt');
        return text('Afgevinkt.');
      } catch (e) {
        return errorText(explain(e));
      }
    }
  );

  server.registerTool(
    'rtm_update_task',
    {
      title: 'Taak wijzigen',
      description:
        'Wijzigt naam, due date, prioriteit, tags of tijdsinschatting van een bestaande taak. ' +
        'Elk opgegeven veld kost een aparte API-call, dus geef alleen mee wat echt verandert.\n' +
        'Let op: tags VERVANGT alle bestaande tags; gebruik add_tags om toe te voegen.',
      inputSchema: {
        handle: z.string().describe('Task handle.'),
        name: z.string().optional().describe('Nieuwe taaknaam.'),
        due: z
          .string()
          .optional()
          .describe(
            'Nieuwe due date. Natuurlijke taal mag ("next friday", "tomorrow 9am"). ' +
              'Geef "none" om de due date te wissen.'
          ),
        priority: z
          .enum(['1', '2', '3', 'none'])
          .optional()
          .describe('Prioriteit 1 (hoogst) t/m 3, of "none".'),
        tags: z.array(z.string()).optional().describe('Vervangt ALLE tags door deze lijst.'),
        add_tags: z.array(z.string()).optional().describe('Voegt tags toe zonder bestaande te wissen.'),
        estimate: z.string().optional().describe('Tijdsinschatting, bijv. "30 min" of "2 hours".')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
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
          done.push(`naam -> "${name}"`);
        }
        if (due !== undefined) {
          if (due.toLowerCase() === 'none' || due === '') {
            // due weglaten wist de due date
            await client.call('rtm.tasks.setDueDate', { ...base });
            done.push('due date gewist');
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
          done.push(`prioriteit -> ${priority}`);
        }
        if (tags !== undefined) {
          await client.call('rtm.tasks.setTags', { ...base, tags: tags.join(',') });
          done.push(`tags -> ${tags.join(', ') || '(leeg)'}`);
        }
        if (add_tags !== undefined && add_tags.length > 0) {
          await client.call('rtm.tasks.addTags', { ...base, tags: add_tags.join(',') });
          done.push(`tags toegevoegd: ${add_tags.join(', ')}`);
        }
        if (estimate !== undefined) {
          await client.call('rtm.tasks.setEstimate', { ...base, estimate });
          done.push(`estimate -> ${estimate}`);
        }

        if (done.length === 0) return errorText('Niets om te wijzigen: geef minstens één veld mee.');
        return text(`Bijgewerkt: ${done.join('; ')}`);
      } catch (e) {
        return errorText(explain(e));
      }
    }
  );

  server.registerTool(
    'rtm_delete_task',
    {
      title: 'Taak verwijderen',
      description:
        'Verwijdert een taak. RTM doet een soft delete, dus rtm_undo kan dit terugdraaien. ' +
        'Vereist delete-permissies op het auth token.',
      inputSchema: { handle: z.string().describe('Task handle.') },
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
        client.recordTransaction(rsp.transaction, 'taak verwijderd');
        return text('Verwijderd. Terugdraaien kan met rtm_undo.');
      } catch (e) {
        return errorText(explain(e));
      }
    }
  );

  server.registerTool(
    'rtm_get_lists',
    {
      title: 'Lijsten ophalen',
      description:
        'Geeft alle RTM-lijsten. Smart lists worden gemarkeerd; daar kun je geen taken aan toevoegen.',
      inputSchema: {
        refresh: z.boolean().default(false).describe('Cache omzeilen en opnieuw ophalen.')
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
      title: 'Laatste wijziging terugdraaien',
      description:
        'Draait de laatste omkeerbare wijziging in deze sessie terug (toevoegen, afvinken, ' +
        'wijzigen, verwijderen). Zonder argumenten wordt de meest recente teruggedraaid.',
      inputSchema: {
        steps: z.number().int().min(1).max(5).default(1).describe('Aantal wijzigingen terugdraaien.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ steps }) => {
      try {
        if (client.recentTransactions.length === 0) {
          return errorText('Geen omkeerbare wijzigingen bekend in deze sessie.');
        }
        const timeline = await client.getTimeline();
        const undone: string[] = [];
        for (let i = 0; i < steps; i++) {
          const tx = client.recentTransactions.shift();
          if (!tx) break;
          await client.call('rtm.transactions.undo', { timeline, transaction_id: tx.id });
          undone.push(tx.description);
        }
        return text(`Teruggedraaid: ${undone.join('; ')}`);
      } catch (e) {
        return errorText(explain(e));
      }
    }
  );
}
