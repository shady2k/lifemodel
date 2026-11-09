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
  logsHelp:
    'Pages are read as the store had them when the first page was read. Records that are byte-identical — same time, message, pod and stream — cannot be told apart.',
  logsMore: 'Show older records',
  logsIncomplete:
    'Incomplete: records arrived while you were scrolling. Refresh from the first page to read the window again.',
  logsRefresh: 'Refresh from the first page',
  logsUnavailable: 'The log store did not answer. Reason: {{reason}}.',
  logsLoadFailed: 'The log store could not be reached.',
  logsInvalidRange: 'The start of the range must be before its end.',
  logsInvalidFilter: 'The {{field}} filter cannot be searched with that value.',
  logsInvalidParameter: 'The {{parameter}} parameter is not valid.',
  logsUntrusted: 'untrusted',
  logsFields: 'Fields',
  logsSettings: 'Settings',
  logs_reason_timeout: 'the request timed out',
  logs_reason_connection_refused: 'the connection was refused',
  logs_reason_unreachable: 'the store could not be reached',
  logs_reason_read_only: 'the store is refusing writes (read-only)',
  logs_reason_http_error: 'the store answered with an error',
  logs_reason_invalid_response: 'the store answered with an unreadable response',
  logsCollectionUnknown: 'collection status unknown',
  logsCollectionStopped_one: 'collection stopped {{count}} minute ago; results may be incomplete',
  logsCollectionStopped_other:
    'collection stopped {{count}} minutes ago; results may be incomplete',
  logsStoreReadOnly: 'the store is refusing writes (read-only)',
  logsEvictorStale: 'the log evictor is failing or has not run',
  logsEvictionNotice: 'logs for {{date}} were removed at {{time}}; {{bytes}} bytes freed',
  logsRetentionTitle: 'Retention',
  logsRetentionDescription:
    'How long logs are kept, and how much space they may take before the oldest days are dropped.',
  logsRetentionDays: 'Days kept',
  logsRetentionSize: 'Size limit (MiB)',
  logsRetentionLargest: 'The largest bound this volume can reach is {{size}}.',
  logsRetentionSave: 'Save retention',
  logsRetentionSaving: 'Saving…',
  logsRetentionApplied: 'Applied at {{time}}: the store runs {{days}} days with a {{size}} limit.',
  logsRetentionAppliedNow: 'Applied: the store runs {{days}} days with a {{size}} limit.',
  logsRetentionPending: 'Waiting for the store to run the new values: {{reason}}',
  logsRetentionPending_store_unavailable: 'it is restarting or not answering',
  logsRetentionPending_rollout_timeout: 'it did not finish its restart in time',
  logsRetentionPending_forbidden: 'the loader may not write its settings',
  logsRetentionPending_mismatch: 'it still answers the previous values',
  logsRetentionRefused:
    'Refused: {{asked}} is above {{largest}}, the largest bound this volume can reach. The rest of the space is the evictor’s threshold.',
  logsRetentionDoesNotFit:
    'retention does not fit this volume: the saved bound {{asked}} is above {{largest}}',
  logsRetentionVolumeNote:
    'Raising the volume is an installation step, not a setting here: use the installer option or the NixOS option.',
  logsRetentionUnavailable: 'The retention setting could not be read. Reason: {{reason}}.',
  logsRetentionInvalid: 'The {{field}} value is not valid.',
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
  logsHelp:
    'Страницы читаются так, как хранилище видело их при чтении первой страницы. Байт-в-байт одинаковые записи — одно время, сообщение, под и поток — различить нельзя.',
  logsMore: 'Показать более старые записи',
  logsIncomplete:
    'Неполно: записи пришли, пока вы листали. Обновите с первой страницы, чтобы прочитать окно заново.',
  logsRefresh: 'Обновить с первой страницы',
  logsUnavailable: 'Хранилище логов не ответило. Причина: {{reason}}.',
  logsLoadFailed: 'Не удалось связаться с хранилищем логов.',
  logsInvalidRange: 'Начало диапазона должно быть раньше его конца.',
  logsInvalidFilter: 'Фильтр «{{field}}»: с таким значением искать нельзя.',
  logsInvalidParameter: 'Параметр «{{parameter}}» задан неверно.',
  logsUntrusted: 'недоверенный',
  logsFields: 'Поля',
  logsSettings: 'Настройки',
  logs_reason_timeout: 'истекло время ожидания',
  logs_reason_connection_refused: 'соединение отклонено',
  logs_reason_unreachable: 'хранилище недоступно',
  logs_reason_read_only: 'хранилище не принимает записи (только чтение)',
  logs_reason_http_error: 'хранилище ответило ошибкой',
  logs_reason_invalid_response: 'хранилище ответило нечитаемым ответом',
  logsCollectionUnknown: 'состояние сбора неизвестно',
  logsCollectionStopped_one:
    'сбор логов остановился {{count}} минуту назад; результаты могут быть неполными',
  logsCollectionStopped_few:
    'сбор логов остановился {{count}} минуты назад; результаты могут быть неполными',
  logsCollectionStopped_many:
    'сбор логов остановился {{count}} минут назад; результаты могут быть неполными',
  logsCollectionStopped_other:
    'сбор логов остановился {{count}} минут назад; результаты могут быть неполными',
  logsStoreReadOnly: 'хранилище не принимает записи (только чтение)',
  logsEvictorStale: 'вытеснитель логов не работает или ещё не запускался',
  logsEvictionNotice: 'логи за {{date}} удалены в {{time}}; освобождено {{bytes}} байт',
  logsRetentionTitle: 'Хранение',
  logsRetentionDescription:
    'Сколько хранятся логи и сколько места они могут занять, прежде чем старые дни будут удалены.',
  logsRetentionDays: 'Хранить дней',
  logsRetentionSize: 'Предел размера (МиБ)',
  logsRetentionLargest: 'Наибольший предел, который может достичь этот том: {{size}}.',
  logsRetentionSave: 'Сохранить хранение',
  logsRetentionSaving: 'Сохранение…',
  logsRetentionApplied:
    'Применено в {{time}}: хранилище работает {{days}} дней с пределом {{size}}.',
  logsRetentionAppliedNow: 'Применено: хранилище работает {{days}} дней с пределом {{size}}.',
  logsRetentionPending: 'Ожидание, пока хранилище применит новые значения: {{reason}}',
  logsRetentionPending_store_unavailable: 'оно перезапускается или не отвечает',
  logsRetentionPending_rollout_timeout: 'оно не завершило перезапуск вовремя',
  logsRetentionPending_forbidden: 'загрузчику нельзя записывать его настройки',
  logsRetentionPending_mismatch: 'оно всё ещё отвечает прежними значениями',
  logsRetentionRefused:
    'Отказано: {{asked}} больше {{largest}} — наибольшего предела, которого может достичь этот том. Остальное место — порог вытеснителя.',
  logsRetentionDoesNotFit:
    'хранение не помещается в этот том: сохранённый предел {{asked}} больше {{largest}}',
  logsRetentionVolumeNote:
    'Увеличение тома — шаг установки, а не настройка здесь: используйте параметр установщика или опцию NixOS.',
  logsRetentionUnavailable: 'Не удалось прочитать настройку хранения. Причина: {{reason}}.',
  logsRetentionInvalid: 'Значение «{{field}}» задано неверно.',
};

i18n.addResourceBundle('en', 'translation', en, true, true);
i18n.addResourceBundle('ru', 'translation', ru, true, true);
