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
  unit: { en: 'tasks', ru: 'задачи' },
  authority: 'owner',
  apply: 'nextAdmission',
};

/** Which harness adapter runs a task; task acceptance snapshots it (ADR-014 D6). */
const tasksHarness: SettingDeclaration = {
  key: 'tasks.harness',
  section: 'tasks',
  label: { en: 'Task harness', ru: 'Исполнитель задач' },
  description: {
    en: 'Which harness runs new tasks: OpenCode or Prime Agent. Running tasks keep their harness.',
    ru: 'Какой исполнитель запускает новые задачи: OpenCode или Prime Agent. Запущенные задачи сохраняют свой исполнитель.',
  },
  control: 'select',
  dataClass: 'publicConfig',
  default: 'opencode',
  options: [
    { value: 'opencode', label: { en: 'OpenCode', ru: 'OpenCode' } },
    { value: 'prime-agent', label: { en: 'Prime Agent', ru: 'Prime Agent' } },
  ],
  authority: 'owner',
  apply: 'nextAdmission',
};

/**
 * How long a wrapping task may finish its work after a soft stop before the
 * hard deadline ends it; task acceptance snapshots the value (ADR-014 D6).
 */
const tasksWrapGraceSeconds: SettingDeclaration = {
  key: 'tasks.wrapGraceSeconds',
  section: 'tasks',
  label: { en: 'Soft-stop grace', ru: 'Время на завершение' },
  description: {
    en: 'How many seconds a task may wrap up after a soft stop before it is ended.',
    ru: 'Сколько секунд задача может завершать дела после мягкой остановки, прежде чем будет прервана.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 300,
  min: 30,
  max: 3600,
  unit: { en: 'seconds', ru: 'секунды' },
  authority: 'owner',
  apply: 'nextAdmission',
};

/** How long sealed task output is kept; forever is an enum value, never 0 (ADR-014 D6). */
const storageRetention: SettingDeclaration = {
  key: 'storage.retention',
  section: 'tasks',
  label: { en: 'Output retention', ru: 'Срок хранения результатов' },
  description: {
    en: 'How long sealed task output is kept: 90 days, or forever (deletion is then only manual).',
    ru: 'Как долго хранятся запечатанные результаты задач: 90 дней или всегда (тогда удаление только вручную).',
  },
  control: 'select',
  dataClass: 'publicConfig',
  default: '90d',
  options: [
    { value: '90d', label: { en: '90 days', ru: '90 дней' } },
    { value: 'forever', label: { en: 'Forever', ru: 'Всегда' } },
  ],
  authority: 'owner',
  apply: 'immediate',
};

/**
 * How many days before a planned deletion the owner is warned; the deletion
 * plans snapshot the lead they announced (ADR-015). The value is whole days,
 * never a raw second count.
 */
const storageWarningLeadDays: SettingDeclaration = {
  key: 'storage.warningLeadDays',
  section: 'tasks',
  label: { en: 'Deletion warning lead', ru: 'Предупреждение перед удалением' },
  description: {
    en: 'How many days before stored output is deleted the owner is warned first.',
    ru: 'За сколько дней до удаления сохранённых результатов владельца предупреждают заранее.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 7,
  min: 1,
  max: 30,
  unit: { en: 'days', ru: 'дни' },
  authority: 'owner',
  apply: 'immediate',
};

/**
 * The platform storage ceiling is a fixed owner decision (20 GB decimal, ADR
 * -015), not an editable value: its bounds pin min, max and default to the
 * one allowed number, so the registry refuses every other value and the
 * owner cannot change the ceiling.
 */
const storageCeilingBytes: SettingDeclaration = {
  key: 'storage.ceilingBytes',
  section: 'tasks',
  label: { en: 'Storage ceiling', ru: 'Потолок хранилища' },
  description: {
    en: 'Fixed at 20 GB (20,000,000,000 bytes) of sealed task output. It cannot be changed.',
    ru: 'Фиксирован: 20 ГБ (20 000 000 000 байт) запечатанных результатов задач. Его нельзя изменить.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 20_000_000_000,
  min: 20_000_000_000,
  max: 20_000_000_000,
  unit: { en: 'bytes', ru: 'байты' },
  authority: 'owner',
  apply: 'immediate',
};

/** The registry the loader serves and writes through; the declaration site above is its content. */
export const platformSettings = createSettingsRegistry([
  tasksConcurrency,
  tasksHarness,
  tasksWrapGraceSeconds,
  storageRetention,
  storageWarningLeadDays,
  storageCeilingBytes,
]);
