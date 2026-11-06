import { createInstance, type TOptions } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import { messages } from './messages.ts';

export const locales = [
  'en',
  'zh',
  'ja',
  'ko',
  'de',
  'fr',
  'es',
  'pt',
  'hi',
  'uk',
  'ru',
  'ar',
] as const;
export type Locale = (typeof locales)[number];
export const localeNames: Record<Locale, string> = {
  en: 'English',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  hi: 'हिन्दी',
  uk: 'Українська',
  ru: 'Русский',
  ar: 'العربية',
};
export const preferenceKey = 'klex-language';

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === 'string' && locales.some((locale) => locale === value)
  );
}

export function matchLocale(preferences: readonly string[]): Locale {
  for (const preference of preferences) {
    const language = preference.toLowerCase().split(/[-_]/)[0];
    if (isLocale(language)) return language;
  }
  return 'en';
}

export function browserLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  return matchLocale(
    [navigator.language, ...(navigator.languages ?? [])].filter(
      (language): language is string => typeof language === 'string',
    ),
  );
}

export function currentLocale(): Locale {
  return matchLocale([i18n.resolvedLanguage ?? i18n.language ?? 'en']);
}

export type Message = keyof typeof messages;
export function validateMessages(): void {
  for (const [source, translations] of Object.entries(messages)) {
    if (
      translations.length !== locales.length - 1 ||
      translations.some((value) => !value.trim())
    )
      throw new Error(`Incomplete translations: ${source}`);
    const placeholders = (value: string) =>
      [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)]
        .map((match) => match[1])
        .sort()
        .join(',');
    if (
      translations.some((value) => placeholders(value) !== placeholders(source))
    )
      throw new Error(`Invalid translation placeholders: ${source}`);
  }
}
validateMessages();

export const resources = Object.fromEntries(
  locales.map((locale, index) => [
    locale,
    {
      translation: Object.fromEntries(
        Object.entries(messages).map(([english, translations]) => [
          english,
          index === 0 ? english : translations[index - 1],
        ]),
      ),
    },
  ]),
);

type LanguagePreference = Locale | 'auto';

function cookiePreference(): LanguagePreference | undefined {
  if (typeof document === 'undefined') return undefined;
  try {
    const value = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${preferenceKey}=`))
      ?.slice(preferenceKey.length + 1);
    return value === 'auto' || isLocale(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function savePreference(language: LanguagePreference): boolean {
  try {
    const url = new URL(location.href);
    const sharedDomain =
      url.hostname === 'klex.bot' || url.hostname.endsWith('.klex.bot');
    document.cookie = `${preferenceKey}=${language}; Path=/; Max-Age=31536000; SameSite=Lax${sharedDomain ? '; Domain=klex.bot' : ''}${url.protocol === 'https:' ? '; Secure' : ''}`;
    return cookiePreference() === language;
  } catch {
    return false;
  }
}

function savedPreference(): LanguagePreference | undefined {
  const cookie = cookiePreference();
  if (cookie !== undefined) return cookie;
  // Migrate the former origin-local setting only when no valid shared choice exists.
  try {
    const legacy = localStorage.getItem(preferenceKey);
    if (isLocale(legacy)) {
      if (savePreference(legacy)) localStorage.removeItem(preferenceKey);
      return legacy;
    }
  } catch {
    // Cookie choices remain usable when localStorage is blocked.
  }
  return undefined;
}

export const i18n = createInstance();
i18n.use(initReactI18next);
if (typeof window !== 'undefined') {
  const detector = new LanguageDetector();
  detector.addDetector({
    name: 'savedPreference',
    lookup: () => {
      const preference = savedPreference();
      return preference === 'auto' ? undefined : preference;
    },
  });
  detector.addDetector({ name: 'browserPreference', lookup: browserLocale });
  i18n.use(detector);
}
await i18n.init({
  resources,
  ...(typeof window === 'undefined' ? { lng: 'en' } : {}),
  fallbackLng: 'en',
  supportedLngs: [...locales],
  nonExplicitSupportedLngs: true,
  load: 'languageOnly',
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  detection: {
    order: ['savedPreference', 'browserPreference'],
    caches: [],
  },
});

export function t(message: Message, options?: TOptions): string {
  return i18n.t(message, options);
}

/** Only for HTML string templates. React handles escaping itself. */
export function html(message: Message, options?: TOptions): string {
  return t(message, options).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] ?? character,
  );
}

export function mountLanguage({
  preserveEnglish = false,
}: {
  preserveEnglish?: boolean;
} = {}): () => void {
  const locale = currentLocale();
  document.documentElement.lang = preserveEnglish ? 'en' : locale;
  document.documentElement.dir = preserveEnglish ? 'ltr' : i18n.dir(locale);
  // Retire old language URLs without disturbing unrelated parameters or anchors.
  const pageUrl = new URL(location.href);
  if (pageUrl.searchParams.has('lang')) {
    pageUrl.searchParams.delete('lang');
    history.replaceState(history.state, '', pageUrl.href);
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const url = new URL(link.href);
    if (
      url.origin === 'https://docs.klex.bot' &&
      locale !== 'en' &&
      !isLocale(url.pathname.split('/')[1])
    ) {
      link.href =
        docsUrl(url.pathname === '/' ? '' : url.pathname, locale) +
        url.search +
        url.hash;
    }
  }
  return () => {};
}

export function languagePreference(): Locale | 'auto' {
  const saved = savedPreference();
  return isLocale(saved) ? saved : 'auto';
}

export function changeLanguagePreference(language: Locale | 'auto'): void {
  if (language !== 'auto' && !isLocale(language)) return;
  if (savePreference(language)) {
    try {
      localStorage.removeItem(preferenceKey);
    } catch {
      // The shared cookie is authoritative; legacy storage may be blocked.
    }
  }
  const url = new URL(location.href);
  url.searchParams.delete('lang');
  location.assign(url.href);
}

export function docsUrl(path = '', locale = currentLocale()): string {
  return `https://docs.klex.bot${locale === 'en' ? '' : `/${locale}`}${path}`;
}
