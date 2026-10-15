import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const language = navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';

void i18n.use(initReactI18next).init({
  resources: {
    en: {
      translation: {
        conversation: 'Conversation',
        system: 'System',
        now: 'Now',
        openNavigation: 'Open navigation',
        openNow: 'Open Now',
        navigation: 'Navigation',
        thinking: 'thinking…',
        awake: 'here',
        asleep: 'asleep',
        asleepUntil: 'asleep until {{time}}',
        noConnection: 'no connection since {{time}}',
        creatureDescription: 'Creature state',
        conversationMessages: 'Conversation messages',
        loading: 'Loading conversation…',
        loadingEarlier: 'Loading earlier messages…',
        transcriptError: 'Could not load the conversation.',
        readAt: 'Read {{time}}',
        newAssistantMessage: 'New message from lifemodel.',
        newOwnerMessage: 'Your message arrived in the conversation.',
        message: 'Message',
        writeMessage: 'Write a message…',
        send: 'Send message',
        reply: 'Reply',
        replyTo: 'Reply to',
        cancelReply: 'Cancel reply',
        retry: 'Retry',
        retrySending: 'Retry sending message',
        notSentRetry: 'Not sent — retry',
      },
    },
    ru: {
      translation: {
        conversation: 'Разговор',
        system: 'Система',
        now: 'Сейчас',
        openNavigation: 'Открыть навигацию',
        openNow: 'Открыть Сейчас',
        navigation: 'Навигация',
        thinking: 'думает…',
        awake: 'на связи',
        asleep: 'спит',
        asleepUntil: 'спит до {{time}}',
        noConnection: 'нет связи с {{time}}',
        creatureDescription: 'Состояние lifemodel',
        conversationMessages: 'Сообщения разговора',
        loading: 'Загружаю разговор…',
        loadingEarlier: 'Загружаю более ранние сообщения…',
        transcriptError: 'Не удалось загрузить разговор.',
        readAt: 'Прочитано {{time}}',
        newAssistantMessage: 'Новое сообщение от lifemodel.',
        newOwnerMessage: 'Ваше сообщение появилось в разговоре.',
        message: 'Сообщение',
        writeMessage: 'Написать сообщение…',
        send: 'Отправить сообщение',
        reply: 'Ответить',
        replyTo: 'Ответить на',
        cancelReply: 'Отменить ответ',
        retry: 'Повторить',
        retrySending: 'Повторить отправку сообщения',
        notSentRetry: 'не отправлено — повторить',
      },
    },
  },
  lng: language,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

document.documentElement.lang = language;
i18n.on('languageChanged', (currentLanguage) => {
  document.documentElement.lang = currentLanguage;
});

export default i18n;
