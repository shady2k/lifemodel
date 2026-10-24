import { AcpTaskHarness, type AcpTaskHarnessOptions } from './task-acp.js';
import { taskHarnessRegistry } from './task-harness-registry.js';
export async function createRegisteredHarness(
  name: string,
  options: AcpTaskHarnessOptions,
  overrides?: Partial<Pick<NonNullable<AcpTaskHarnessOptions['agent']>, 'configFile' | 'command'>>
): Promise<AcpTaskHarness> {
  if (!Object.hasOwn(taskHarnessRegistry, name)) throw new Error('harness_not_registered');
  const registered = taskHarnessRegistry[name];
  if (!registered) throw new Error('harness_not_registered');
  const agent = { ...registered, ...overrides };
  const { configureAgent, toolOutputFailed } = (await import(agent.adapterModule)) as {
    configureAgent: NonNullable<AcpTaskHarnessOptions['configure']>;
    toolOutputFailed: NonNullable<AcpTaskHarnessOptions['toolOutputFailed']>;
  };
  return new AcpTaskHarness({ ...options, agent, configure: configureAgent, toolOutputFailed });
}
