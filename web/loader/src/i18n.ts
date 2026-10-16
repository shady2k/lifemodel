import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
export function languageFor(locale: string): 'en' | 'ru' {
  return new Intl.Locale(locale).language === 'ru' ? 'ru' : 'en';
}
const language = languageFor(navigator.language);
void i18n.use(initReactI18next).init({
  resources: {
    en: {
      translation: {
        brand: 'lifemodel',
        setupTitle: 'Set your password',
        loginTitle: 'Welcome back',
        description: 'Your private, proactive AI companion.',
        password: 'Password',
        confirm: 'Continue',
        wrong: 'That password did not match. Try again.',
        setupError: 'Could not complete setup. Please try again.',
        loading: 'Connecting…',
        settingsTitle: 'Setup complete',
        settingsDescription: 'Your loader is ready. Model setup will continue in the next step.',
        logout: 'Log out',
        ru: 'Русский',
        en: 'English',
      },
    },
    ru: {
      translation: {
        brand: 'lifemodel',
        setupTitle: 'Создайте пароль',
        loginTitle: 'С возвращением',
        description: 'Ваш личный проактивный ИИ-компаньон.',
        password: 'Пароль',
        confirm: 'Продолжить',
        wrong: 'Пароль не подошёл. Попробуйте ещё раз.',
        setupError: 'Не удалось завершить настройку. Попробуйте ещё раз.',
        loading: 'Подключение…',
        settingsTitle: 'Настройка завершена',
        settingsDescription: 'Загрузчик готов. Настройка модели появится на следующем шаге.',
        logout: 'Выйти',
        ru: 'Русский',
        en: 'English',
      },
    },
  },
  lng: language,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});
document.documentElement.lang = language;
i18n.on('languageChanged', (current) => {
  document.documentElement.lang = current;
});
export default i18n;
