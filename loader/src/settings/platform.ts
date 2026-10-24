/** The platform's own setting declarations (ADR-014 D6): the single declaration site. */
import { createSettingsRegistry, type SettingDeclaration } from './registry.js';
import { taskHarnessRegistry, defaultTaskHarness } from '../task-harness-registry.js';

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
    en: 'Which registered harness runs new tasks. Running tasks keep their harness.',
    ru: 'Какой зарегистрированный исполнитель запускает новые задачи. Запущенные задачи сохраняют свой исполнитель.',
  },
  control: 'select',
  dataClass: 'publicConfig',
  default: defaultTaskHarness,
  options: Object.entries(taskHarnessRegistry).map(([value, agent]) => ({
    value,
    label: { en: agent.label, ru: agent.label },
  })),
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

/**
 * Task-only channel resource budgets (ADR-014 D2). Defaults are the tested
 * ceilings: increasing a ceiling needs the fairness fixture again, not an
 * unbounded owner override. Lower values apply to the next channel admission.
 */
const taskChannelMaxFrameBytes: SettingDeclaration = {
  key: 'tasks.channel.maxFrameBytes',
  section: 'tasks',
  label: { en: 'Task channel frame limit', ru: 'Предел кадра канала задач' },
  description: {
    en: 'Maximum bytes in one task channel frame. Larger frames are refused.',
    ru: 'Наибольшее число байтов в одном кадре канала задач. Более крупные кадры отклоняются.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 65_536,
  integer: true,
  min: 1,
  max: 65_536,
  unit: { en: 'bytes', ru: 'байты' },
  authority: 'owner',
  apply: 'nextAdmission',
};

const taskChannelMaxUnackedFrames: SettingDeclaration = {
  key: 'tasks.channel.maxUnackedFrames',
  section: 'tasks',
  label: {
    en: 'Unacknowledged frames per connection',
    ru: 'Кадры без подтверждения на соединение',
  },
  description: {
    en: 'Maximum unacknowledged task channel frames on one connection. Saturation applies backpressure.',
    ru: 'Наибольшее число кадров без подтверждения в одном соединении. При заполнении применяется обратное давление.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 16,
  integer: true,
  min: 1,
  max: 16,
  unit: { en: 'frames', ru: 'кадры' },
  authority: 'owner',
  apply: 'nextAdmission',
};

const taskChannelMaxUnackedBytes: SettingDeclaration = {
  key: 'tasks.channel.maxUnackedBytes',
  section: 'tasks',
  label: { en: 'Unacknowledged bytes per connection', ru: 'Байты без подтверждения на соединение' },
  description: {
    en: 'Maximum unacknowledged task channel bytes on one connection. Saturation applies backpressure.',
    ru: 'Наибольшее число байтов без подтверждения в одном соединении. При заполнении применяется обратное давление.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 1_048_576,
  integer: true,
  min: 1,
  max: 1_048_576,
  unit: { en: 'bytes', ru: 'байты' },
  authority: 'owner',
  apply: 'nextAdmission',
};

const taskChannelMaxBufferedBytes: SettingDeclaration = {
  key: 'tasks.channel.maxBufferedBytes',
  section: 'tasks',
  label: { en: 'Task channel process buffer', ru: 'Буфер канала задач на процесс' },
  description: {
    en: 'Maximum task channel bytes buffered across the core process. This never borrows owner intake capacity.',
    ru: 'Наибольшее число байтов канала задач в буфере процесса ядра. Резерв ввода владельца не используется.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 4_194_304,
  integer: true,
  min: 1,
  max: 4_194_304,
  unit: { en: 'bytes', ru: 'байты' },
  authority: 'owner',
  apply: 'nextAdmission',
};

const taskChannelAckTimeoutMs: SettingDeclaration = {
  key: 'tasks.channel.ackTimeoutMs',
  section: 'tasks',
  label: { en: 'Task channel ACK timeout', ru: 'Срок подтверждения канала задач' },
  description: {
    en: 'Maximum milliseconds to acknowledge a task channel frame before disconnect and replay.',
    ru: 'Наибольшее число миллисекунд до подтверждения кадра, после которого соединение закрывается для повтора.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 5_000,
  integer: true,
  min: 1,
  max: 5_000,
  unit: { en: 'milliseconds', ru: 'миллисекунды' },
  authority: 'owner',
  apply: 'nextAdmission',
};

const taskChannelWorkers: SettingDeclaration = {
  key: 'tasks.channel.workers',
  section: 'tasks',
  label: { en: 'Task channel workers', ru: 'Обработчики канала задач' },
  description: {
    en: 'Bounded task channel workers, separate from owner intake and artifact transfer workers.',
    ru: 'Ограниченное число обработчиков канала задач, отдельно от ввода владельца и передачи файлов.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 2,
  integer: true,
  min: 1,
  max: 2,
  unit: { en: 'workers', ru: 'обработчики' },
  authority: 'owner',
  apply: 'nextAdmission',
};

const taskChannelSqlConnections: SettingDeclaration = {
  key: 'tasks.channel.sqlConnections',
  section: 'tasks',
  label: { en: 'Task channel SQL connections', ru: 'Соединения SQL канала задач' },
  description: {
    en: 'Reserved task channel SQL connections, independent of owner intake and artifact transfer pools.',
    ru: 'Выделенные соединения SQL канала задач, независимо от пулов ввода владельца и передачи файлов.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 2,
  integer: true,
  min: 1,
  max: 2,
  unit: { en: 'connections', ru: 'соединения' },
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
  integer: true,
  min: 1,
  max: 30,
  unit: { en: 'days', ru: 'дни' },
  authority: 'owner',
  apply: 'immediate',
};

/**
 * The platform storage ceiling is a fixed owner decision (20 GB decimal, ADR
 * -015), not an editable value: read-only, so the registry refuses every
 * write and a screen renders it as fixed text; the bounds pin the one
 * allowed number and the bytes format shows it as 20 GB, never a raw digit
 * string.
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
  format: 'bytes',
  readOnly: true,
  authority: 'owner',
  apply: 'immediate',
};

/** The registry the loader serves and writes through; the declaration site above is its content. */
export const platformSettings = createSettingsRegistry([
  tasksConcurrency,
  tasksHarness,
  tasksWrapGraceSeconds,
  taskChannelMaxFrameBytes,
  taskChannelMaxUnackedFrames,
  taskChannelMaxUnackedBytes,
  taskChannelMaxBufferedBytes,
  taskChannelAckTimeoutMs,
  taskChannelWorkers,
  taskChannelSqlConnections,
  storageRetention,
  storageWarningLeadDays,
  storageCeilingBytes,
]);
