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
        asleepUntil: 'asleep until {{time}}',
        noConnection: 'no connection since {{time}}',
        creatureDescription: 'Creature state',
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
        asleepUntil: 'спит до {{time}}',
        noConnection: 'нет связи с {{time}}',
        creatureDescription: 'Состояние lifemodel',
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
