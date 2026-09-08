/**
 * Elke schrijfoperatie op een taak vereist het triple list_id / taskseries_id /
 * task_id. Die drie los aan het model teruggeven leidt gegarandeerd tot
 * verhaspelde ids, dus we bundelen ze in één opaque handle.
 */
export interface TaskRef {
  listId: string;
  seriesId: string;
  taskId: string;
}

export function encodeHandle(ref: TaskRef): string {
  return Buffer.from(`${ref.listId}:${ref.seriesId}:${ref.taskId}`, 'utf8').toString('base64url');
}

export function decodeHandle(handle: string): TaskRef {
  let decoded: string;
  try {
    decoded = Buffer.from(handle, 'base64url').toString('utf8');
  } catch {
    throw new Error(`Ongeldige task handle: ${handle}`);
  }
  const parts = decoded.split(':');
  if (parts.length !== 3 || parts.some((p) => !p)) {
    throw new Error(
      `Ongeldige task handle: ${handle}. Gebruik een handle uit rtm_list_tasks of rtm_add_task.`
    );
  }
  return { listId: parts[0], seriesId: parts[1], taskId: parts[2] };
}
