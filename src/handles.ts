/**
 * Every write operation on a task needs the triple list_id / taskseries_id /
 * task_id. Handing those three to the model separately guarantees mixed-up
 * ids, so we bundle them into one opaque handle.
 */
export interface TaskRef {
  listId: string;
  seriesId: string;
  taskId: string;
}

export function encodeHandle(ref: TaskRef): string {
  return Buffer.from(`${ref.listId}:${ref.seriesId}:${ref.taskId}`, 'utf8').toString('base64url');
}

/** RTM ids are always numeric. Anything else is garbage or an injection attempt. */
const RTM_ID = /^\d+$/;

export function decodeHandle(handle: string): TaskRef {
  // Buffer.from(..., 'base64url') never throws; invalid characters are silently dropped.
  // The validation below is therefore the only real check.
  const parts = Buffer.from(handle, 'base64url').toString('utf8').split(':');
  if (parts.length !== 3 || !parts.every((p) => RTM_ID.test(p))) {
    throw new Error(
      `Invalid task handle: ${handle}. Use a handle from rtm_list_tasks or rtm_add_task.`
    );
  }
  return { listId: parts[0], seriesId: parts[1], taskId: parts[2] };
}
