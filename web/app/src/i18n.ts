import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const language = navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';

void i18n.use(initReactI18next).init({
  resources: {
    en: {
      translation: {
        conversation: 'Conversation',
        system: 'System',
        now: 'Сейчас',
        openNavigation: 'Open navigation',
        openNow: 'Open Сейчас',
        navigation: 'Navigation',
        awake: 'Awake',
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
        awake: 'Бодрствует',
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
