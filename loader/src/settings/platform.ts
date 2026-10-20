/** The platform's own setting declarations (ADR-014 D6): the single declaration site. */
import { createSettingsRegistry, type SettingDeclaration } from './registry.js';

/** How many tasks may run at the same time; admission waits below the cap. */
const tasksConcurrency: SettingDeclaration = {
  key: 'tasks.concurrency',
  section: 'tasks',
  label: { en: 'Concurrent tasks', ru: 'Параллельные задачи' },
  description: {
    en: 'How many tasks may run at the same time. Lowering it does not stop running tasks; new tasks wait.',
    ru: 'Сколько задач может выполняться одновременно. Уменьшение не останавливает идущие задачи; новые ждут.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 2,
  min: 1,
  max: 8,
  unit: 'tasks',
  authority: 'owner',
  apply: 'nextAdmission',
};

/** The registry the loader serves and writes through; the declaration site above is its content. */
export const platformSettings = createSettingsRegistry([tasksConcurrency]);
