import { mountLanguage } from '@/i18n';
import { mountLogoMenus } from '@/new/logo-menu';
import { mountNavigation } from '@/new/navigation';
import { mountLanguageSelector } from '@/new/sections/footer/language';

const theme = matchMedia('(prefers-color-scheme: dark)');
const updateTheme = () =>
  document.documentElement.classList.toggle('dark', theme.matches);
updateTheme();
theme.addEventListener('change', updateTheme);

const disposeLanguage = mountLanguage({ preserveEnglish: true });
const disposeLanguageSelector = mountLanguageSelector();
const disposeNavigation = mountNavigation();
const disposeLogos = mountLogoMenus(document.body);

import.meta.hot?.dispose(() => {
  theme.removeEventListener('change', updateTheme);
  disposeLanguage();
  disposeLanguageSelector();
  disposeLogos();
  disposeNavigation();
});
