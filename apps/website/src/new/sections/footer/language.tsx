import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@stagewise/ui';

import {
  browserLocale,
  changeLanguagePreference,
  currentLocale,
  isLocale,
  languagePreference,
  localeNames,
  locales,
  t,
} from '@/i18n';
import { mountIsland } from '@/new/island';

export function LanguageSelector({
  placement = 'footer',
}: {
  placement?: 'footer' | 'header' | 'menu';
}) {
  const value = languagePreference();
  const automaticLocale = browserLocale();
  return (
    <Select
      value={value === automaticLocale ? 'auto' : value}
      onValueChange={(next) => {
        if (next === 'auto' || isLocale(next)) changeLanguagePreference(next);
      }}
    >
      <SelectTrigger
        data-language
        data-language-placement={placement}
        data-language-value={value}
        className="new-footer-language"
        aria-label={`${t('Language')}: ${localeNames[currentLocale()]}`}
        title={t('Language')}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2.25 4.25H10.25" />
          <path d="M6.25 2.25V4.25" />
          <path d="M4.25 4.25C4.3353 6.7587 5.9446 8.94141 8.2746 9.78371" />
          <path d="M8.25 4.25C7.85 9.875 2.25 10.25 2.25 10.25" />
          <path d="M9.25 15.75L12.25 7.75H12.75L15.75 15.75" />
          <path d="M10.188 13.25H14.813" />
        </svg>
        {placement === 'footer' && (
          <span className="new-language-name" lang={currentLocale()} dir="auto">
            {localeNames[currentLocale()]}
          </span>
        )}
      </SelectTrigger>
      <SelectContent
        data-language-menu={placement}
        side={placement === 'footer' ? 'top' : 'bottom'}
        align="start"
        alignItemWithTrigger={false}
        className="w-max max-w-[calc(100vw-2rem)]"
      >
        <SelectItem
          value="auto"
          onClick={() => {
            if (value === automaticLocale) changeLanguagePreference('auto');
          }}
        >
          <span lang={automaticLocale} dir="auto">
            {localeNames[automaticLocale]} (
            {t('Default', { lng: automaticLocale })})
          </span>
        </SelectItem>
        {locales
          .filter((locale) => locale !== automaticLocale)
          .map((locale) => (
            <SelectItem key={locale} value={locale}>
              <span lang={locale} dir="auto">
                {localeNames[locale]}
              </span>
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

export function mountLanguageSelector() {
  return mountIsland('language', <LanguageSelector />);
}
