import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  html,
  i18n,
  locales,
  matchLocale,
  preferenceKey,
  resources,
  t,
  validateMessages,
} from './i18n';
import { messages } from './messages';

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.resetModules();
  await i18n.changeLanguage('en');
});

describe('translation catalogs', () => {
  it('provides every English key in all twelve languages without fallback', () => {
    validateMessages();
    for (const locale of locales) {
      expect(Object.keys(resources[locale].translation)).toEqual(
        Object.keys(messages),
      );
      for (const value of Object.values(resources[locale].translation))
        expect(value.trim()).not.toBe('');
    }
  });
  it('translates English source strings and escapes HTML templates', async () => {
    await i18n.changeLanguage('de');
    expect(t('Language')).toBe('Sprache');
    await i18n.changeLanguage('en');
    expect(html('Add description...')).toBe('Add description...');
    expect(
      html('Apps {{name}} uses', { name: `<a title="x">Tom & 'Jo'</a>` }),
    ).toBe(
      'Apps &lt;a title=&quot;x&quot;&gt;Tom &amp; &#39;Jo&#39;&lt;/a&gt; uses',
    );
  });
  it.each([
    [['de-DE', 'en-US'], 'de'],
    [['zh-Hant-TW'], 'zh'],
    [['pt_BR'], 'pt'],
    [['it-IT', 'uk-UA'], 'uk'],
    [['it-IT'], 'en'],
    [[], 'en'],
  ] as const)('matches device languages %j to %s', (preferences, expected) => {
    expect(matchLocale(preferences)).toBe(expected);
  });
});

function browser(search: string, saved: string | null, languages = ['ja-JP']) {
  const storage = new Map<string, string>(
    saved ? [[preferenceKey, saved]] : [],
  );
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  const location = {
    href: `https://klex.bot/brand${search}`,
    search,
    origin: 'https://klex.bot',
    assign: vi.fn(),
  };
  const select = {
    value: '',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const cookies = new Map<string, string>();
  const cookieWrites: string[] = [];
  const document = {
    get cookie() {
      return [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    },
    set cookie(value: string) {
      cookieWrites.push(value);
      const [pair] = value.split(';');
      const separator = pair.indexOf('=');
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    },
    documentElement: { lang: '', dir: '' },
    querySelectorAll: () => [],
    querySelector: () => select,
  };
  vi.stubGlobal('window', { location, localStorage });
  vi.stubGlobal('location', location);
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('navigator', { languages, language: languages[0] });
  vi.stubGlobal('document', document);
  vi.stubGlobal('history', { state: null, replaceState: vi.fn() });
  return {
    storage,
    localStorage,
    location,
    select,
    document,
    cookies,
    cookieWrites,
  };
}

describe('language detection and footer', () => {
  it('migrates an existing localStorage preference to the shared cookie', async () => {
    const env = browser('', 'fr');
    const module = await import('./i18n');
    expect(module.currentLocale()).toBe('fr');
    expect(env.cookies.get(preferenceKey)).toBe('fr');
    expect(env.storage.has(preferenceKey)).toBe(false);
  });
  it.each(['en', 'auto'])(
    'uses shared %s instead of a stale local preference',
    async (value) => {
      const env = browser('', 'de', ['en-US']);
      env.cookies.set(preferenceKey, value);
      const module = await import('./i18n');
      expect(module.currentLocale()).toBe('en');
      expect(module.languagePreference()).toBe(value);
    },
  );
  it('ignores invalid cookie values and malformed unrelated cookies', async () => {
    const env = browser('', null, ['en-US']);
    env.cookies.set('other', '%broken');
    env.cookies.set(preferenceKey, 'invalid');
    const module = await import('./i18n');
    expect(module.currentLocale()).toBe('en');
  });
  it('uses a host-only nonsecure cookie on local development origins', async () => {
    const env = browser('', null);
    env.location.href = 'http://localhost:5173/';
    const module = await import('./i18n');
    module.changeLanguagePreference('fr');
    expect(env.cookieWrites.at(-1)).toBe(
      'klex-language=fr; Path=/; Max-Age=31536000; SameSite=Lax',
    );
  });
  it('retains the legacy setting if cookies cannot be written', async () => {
    const env = browser('', 'fr');
    Object.defineProperty(env.document, 'cookie', {
      get: () => '',
      set: () => {},
    });
    const module = await import('./i18n');
    expect(module.currentLocale()).toBe('fr');
    expect(env.storage.get(preferenceKey)).toBe('fr');
    module.changeLanguagePreference('de');
    expect(env.location.assign).toHaveBeenCalledWith('https://klex.bot/brand');
  });
  it('prefers the browser primary language when its preference list disagrees', async () => {
    browser('', null, ['de-DE', 'en-US']);
    vi.stubGlobal('navigator', {
      language: 'en-US',
      languages: ['de-DE', 'en-US'],
    });
    const module = await import('./i18n');
    expect(module.browserLocale()).toBe('en');
    expect(module.currentLocale()).toBe('en');
  });
  it('keeps the automatic language independent of URL and saved overrides', async () => {
    browser('?lang=ar', 'de', ['en-US', 'de-DE']);
    const module = await import('./i18n');
    expect(module.currentLocale()).toBe('de');
    expect(module.browserLocale()).toBe('en');
    expect(
      module.t('Automatic (device language)', { lng: module.browserLocale() }),
    ).toBe('Automatic (device language)');
  });
  it('uses English automatically when English is the browser preference', async () => {
    browser('', null, ['en-GB', 'de-DE']);
    const module = await import('./i18n');
    expect(module.currentLocale()).toBe('en');
  });
  it.each([
    ['?lang=ar', 'de', 'de'],
    ['', 'fr', 'fr'],
    ['', null, 'ja'],
    ['?lang=invalid', 'de', 'de'],
  ])(
    'ignores language URLs and uses saved choice then browser: %s / %s',
    async (search, saved, expected) => {
      browser(search ?? '', saved);
      const module = await import('./i18n');
      expect(module.currentLocale()).toBe(expected);
    },
  );
  it('sets Arabic direction, persists footer changes, and resets automatic selection', async () => {
    const env = browser('?lang=de', 'ar');
    const module = await import('./i18n');
    const dispose = module.mountLanguage();
    expect(env.document.documentElement).toEqual({ lang: 'ar', dir: 'rtl' });
    expect(module.languagePreference()).toBe('ar');
    module.changeLanguagePreference('fr');
    expect(env.cookies.get(preferenceKey)).toBe('fr');
    expect(env.storage.has(preferenceKey)).toBe(false);
    expect(env.cookieWrites.at(-1)).toContain('Domain=klex.bot; Secure');
    expect(env.location.assign).toHaveBeenLastCalledWith(
      'https://klex.bot/brand',
    );
    module.changeLanguagePreference('auto');
    expect(env.cookies.get(preferenceKey)).toBe('auto');
    expect(env.storage.has(preferenceKey)).toBe(false);
    expect(env.location.assign).toHaveBeenLastCalledWith(
      'https://klex.bot/brand',
    );
    dispose();
  });
  it('keeps legal content English and saves cookies when localStorage is blocked', async () => {
    const env = browser('?lang=ar', null);
    env.localStorage.getItem = () => {
      throw new Error('blocked');
    };
    env.localStorage.setItem = () => {
      throw new Error('blocked');
    };
    const module = await import('./i18n');
    module.mountLanguage({ preserveEnglish: true });
    expect(env.document.documentElement).toEqual({ lang: 'en', dir: 'ltr' });
    module.changeLanguagePreference('de');
    expect(env.cookies.get(preferenceKey)).toBe('de');
    expect(env.location.assign).toHaveBeenLastCalledWith(
      'https://klex.bot/brand',
    );
  });
});
