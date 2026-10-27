/** Round-robin work keyed first by credential, then by verified Job UID. */
export interface Work {
  taskId: string;
  run(): Promise<void>;
  cancelled(): boolean;
}

export function createTaskChannelScheduler(limit: number, isClosed: () => boolean) {
  const queues = new Map<string, Work[]>();
  const activeTasks = new Set<string>();
  const ready: string[] = [];
  let active = 0;
  function schedule(): void {
    while (!isClosed() && active < limit && ready.length) {
      const taskId = ready.shift();
      if (!taskId || activeTasks.has(taskId)) continue;
      const queue = queues.get(taskId);
      const work = queue?.shift();
      if (!work) {
        queues.delete(taskId);
        continue;
      }
      if (work.cancelled()) {
        if (queue?.length) ready.push(taskId);
        else queues.delete(taskId);
        continue;
      }
      active++;
      activeTasks.add(taskId);
      void work.run().finally(() => {
        active--;
        activeTasks.delete(taskId);
        if (queues.get(taskId)?.length) ready.push(taskId);
        else queues.delete(taskId);
        schedule();
      });
    }
  }
  return {
    add(work: Work) {
      const queue = queues.get(work.taskId) ?? [];
      queue.push(work);
      queues.set(work.taskId, queue);
      if (!activeTasks.has(work.taskId) && !ready.includes(work.taskId)) ready.push(work.taskId);
      schedule();
    },
    remove(work: Work) {
      const queue = queues.get(work.taskId);
      const index = queue?.indexOf(work) ?? -1;
      if (queue && index >= 0) queue.splice(index, 1);
      if (queue?.length === 0) {
        queues.delete(work.taskId);
        const readyIndex = ready.indexOf(work.taskId);
        if (readyIndex >= 0) ready.splice(readyIndex, 1);
      }
    },
    clear() {
      queues.clear();
      ready.length = 0;
    },
  };
}
