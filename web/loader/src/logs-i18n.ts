/**
 * The logs page's words (ADR-016 §4). They are added to the loader's existing
 * i18n instance so the page follows the same language switch as the rest of
 * the loader.
 */
import i18n from './i18n';

const en = {
  logsTitle: 'Logs',
  logsDescription:
    'Every module’s lines on this machine. Filter by time, module, level, conversation and text.',
  logsTimeFrom: 'From',
  logsTimeTo: 'To',
  logsModule: 'Module',
  logsAllModules: 'All modules',
  logsLevel: 'Level',
  logsAllLevels: 'All levels',
  logsConversation: 'Conversation',
  logsConversationPlaceholder: 'conversation id',
  logsText: 'Text',
  logsTextPlaceholder: 'words in the message',
  logsSearch: 'Show logs',
  logsSearching: 'Reading logs…',
  logsNoRecords: 'No records in this range.',
  logsRecordCount_one: '{{count}} record',
  logsRecordCount_other: '{{count}} records',
  logsUnavailable: 'The log store did not answer. Reason: {{reason}}.',
  logsLoadFailed: 'The log store could not be reached.',
  logsInvalidRange: 'The start of the range must be before its end.',
  logsInvalidFilter: 'The {{field}} filter cannot be searched with that value.',
  logsUntrusted: 'untrusted',
  logsFields: 'Fields',
  logsSettings: 'Settings',
  logs_reason_timeout: 'the request timed out',
  logs_reason_connection_refused: 'the connection was refused',
  logs_reason_unreachable: 'the store could not be reached',
  logs_reason_read_only: 'the store is refusing writes (read-only)',
  logs_reason_http_error: 'the store answered with an error',
  logs_reason_invalid_response: 'the store answered with an unreadable response',
};

const ru = {
  logsTitle: 'Логи',
  logsDescription:
    'Строки всех модулей на этой машине. Фильтруйте по времени, модулю, уровню, беседе и тексту.',
  logsTimeFrom: 'С',
  logsTimeTo: 'По',
  logsModule: 'Модуль',
  logsAllModules: 'Все модули',
  logsLevel: 'Уровень',
  logsAllLevels: 'Все уровни',
  logsConversation: 'Беседа',
  logsConversationPlaceholder: 'идентификатор беседы',
  logsText: 'Текст',
  logsTextPlaceholder: 'слова в сообщении',
  logsSearch: 'Показать логи',
  logsSearching: 'Чтение логов…',
  logsNoRecords: 'В этом диапазоне записей нет.',
  logsRecordCount_one: '{{count}} запись',
  logsRecordCount_few: '{{count}} записи',
  logsRecordCount_many: '{{count}} записей',
  logsRecordCount_other: '{{count}} записей',
  logsUnavailable: 'Хранилище логов не ответило. Причина: {{reason}}.',
  logsLoadFailed: 'Не удалось связаться с хранилищем логов.',
  logsInvalidRange: 'Начало диапазона должно быть раньше его конца.',
  logsInvalidFilter: 'Фильтр «{{field}}»: с таким значением искать нельзя.',
  logsUntrusted: 'недоверенный',
  logsFields: 'Поля',
  logsSettings: 'Настройки',
  logs_reason_timeout: 'истекло время ожидания',
  logs_reason_connection_refused: 'соединение отклонено',
  logs_reason_unreachable: 'хранилище недоступно',
  logs_reason_read_only: 'хранилище не принимает записи (только чтение)',
  logs_reason_http_error: 'хранилище ответило ошибкой',
  logs_reason_invalid_response: 'хранилище ответило нечитаемым ответом',
};

i18n.addResourceBundle('en', 'translation', en, true, true);
i18n.addResourceBundle('ru', 'translation', ru, true, true);
