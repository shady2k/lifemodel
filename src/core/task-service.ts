import type { TaskAcceptanceService, TaskService } from '../ports/tasks.js';
import { TaskRegistryError } from '../ports/tasks.js';
import type { TaskCommandMailbox, TaskCommandReader } from '../ports/task-channel.js';

/** Domain facade. Commands return after the fenced commit, not launcher admission. */
export function createTaskService(deps: {
  tasks: TaskAcceptanceService;
  mailbox: TaskCommandReader & Pick<TaskCommandMailbox, 'enqueueCommand'>;
}): TaskService {
  const send = async (taskId: string, commandId: string, text: string, questionId?: string) => {
    const task = await deps.tasks.read(taskId);
    if (!task) throw new TaskRegistryError(taskId, 'not_found');
    return deps.mailbox.enqueueCommand({
      taskId,
      attemptId: task.attemptId,
      commandId,
      text,
      kind: questionId === undefined ? 'steer' : 'answer',
      ...(questionId === undefined ? {} : { questionId }),
    });
  };
  return {
    accept: (request) => deps.tasks.accept(request),
    readByLaunchKey: (key) => deps.tasks.readByLaunchKey(key),
    list: () => deps.tasks.list(),
    listActiveContext: () => deps.tasks.listActiveContext(),
    read: async (id) => {
      const task = await deps.tasks.read(id);
      if (!task) return null;
      const [commands, question] = await Promise.all([
        deps.mailbox.readCommands(id),
        deps.mailbox.readQuestion(id),
      ]);
      return { ...task, commands, question };
    },
    readCommand: (id) => deps.mailbox.readCommand(id),
    steer: (taskId, commandId, text) => send(taskId, commandId, text),
    answer: (taskId, commandId, questionId, text) => send(taskId, commandId, text, questionId),
  };
}
