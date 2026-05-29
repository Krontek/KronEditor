import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';
import tr from './locales/tr.json';
import ru from './locales/ru.json';

i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
        resources: {
            en: { translation: en },
            tr: { translation: tr },
            ru: { translation: ru }
        },
        // Restrict to the languages we actually ship — without this, the
        // detector can return 'en-US' from the browser and the resolved key
        // never matches our 'en' resource (UI stays on fallback but the
        // switcher highlight breaks).
        supportedLngs: ['en', 'tr', 'ru'],
        fallbackLng: 'en',
        // Collapse regional variants (en-US → en) so resolvedLanguage matches
        // the keys we use in switch buttons.
        load: 'languageOnly',
        nonExplicitSupportedLngs: true,
        // First boot defaults to English regardless of browser locale; user's
        // explicit choice is then persisted in localStorage and used on
        // subsequent loads.
        detection: {
            order: ['localStorage'],
            lookupLocalStorage: 'i18nextLng',
            caches: ['localStorage'],
        },
        interpolation: {
            escapeValue: false
        }
    });

export default i18n;
