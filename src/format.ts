import { asArray, type RtmList, type RtmTaskInstance, type RtmTaskSeries } from './rtm.js';
import { encodeHandle } from './handles.js';

const PRIORITY_LABEL: Record<string, string> = { '1': '!1', '2': '!2', '3': '!3' };

export function seriesTags(series: RtmTaskSeries): string[] {
  const raw = series.tags as { tag?: string | string[] } | string[] | undefined;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as string[];
  return asArray(raw.tag);
}

function formatDue(task: RtmTaskInstance): string {
  if (!task.due) return '';
  const d = new Date(task.due);
  if (Number.isNaN(d.getTime())) return task.due;
  // has_due_time=0 means "all day"; RTM puts those at midnight UTC.
  return task.has_due_time === '1'
    ? d.toISOString().replace('T', ' ').slice(0, 16) + 'Z'
    : d.toISOString().slice(0, 10);
}

export interface FlatTask {
  handle: string;
  name: string;
  listName: string;
  due: string;
  priority: string;
  tags: string[];
  completed: boolean;
  estimate: string;
  url: string;
}

/**
 * Flattens the nested tasks > list > taskseries > task structure.
 * Note: one taskseries can hold several task instances (repeating tasks),
 * so this is a nested loop, not a map.
 */
export function flattenTasks(
  rsp: { tasks?: { list?: unknown } },
  listNameById: Map<string, string>
): FlatTask[] {
  const out: FlatTask[] = [];
  for (const list of asArray(rsp.tasks?.list) as Array<{
    id: string;
    taskseries?: RtmTaskSeries | RtmTaskSeries[];
  }>) {
    for (const series of asArray(list.taskseries)) {
      for (const task of asArray(series.task)) {
        if (task.deleted) continue;
        out.push({
          handle: encodeHandle({ listId: list.id, seriesId: series.id, taskId: task.id }),
          name: series.name,
          listName: listNameById.get(list.id) ?? list.id,
          due: formatDue(task),
          priority: PRIORITY_LABEL[task.priority] ?? '',
          tags: seriesTags(series),
          completed: Boolean(task.completed),
          estimate: task.estimate ?? '',
          url: series.url ?? ''
        });
      }
    }
  }
  return out;
}

export function renderTasks(tasks: FlatTask[]): string {
  if (tasks.length === 0) return 'No tasks found for this filter.';
  const lines = tasks.map((t) => {
    const bits = [
      t.completed ? '[x]' : '[ ]',
      t.name,
      t.due ? `due:${t.due}` : '',
      t.priority,
      t.tags.length ? t.tags.map((x) => `#${x}`).join(' ') : '',
      `list:${t.listName}`,
      `handle:${t.handle}`
    ].filter(Boolean);
    return bits.join('  ');
  });
  return `${tasks.length} task${tasks.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

export function renderLists(lists: RtmList[]): string {
  const active = lists.filter((l) => l.deleted !== '1');
  const lines = active.map((l) => {
    const flags = [
      l.smart === '1' ? 'smart (read-only for new tasks)' : '',
      l.archived === '1' ? 'archived' : '',
      l.locked === '1' ? 'locked' : ''
    ].filter(Boolean);
    return `${l.name}${flags.length ? `  (${flags.join(', ')})` : ''}`;
  });
  return `${active.length} lists:\n${lines.join('\n')}`;
}
