import { mountLogoMenus } from '@/new/logo-menu';
import { mountNavigation } from '@/new/navigation';

const theme = matchMedia('(prefers-color-scheme: dark)');
const updateTheme = () =>
  document.documentElement.classList.toggle('dark', theme.matches);
updateTheme();
theme.addEventListener('change', updateTheme);

const disposeNavigation = mountNavigation();
const disposeLogos = mountLogoMenus(document.body);

import.meta.hot?.dispose(() => {
  theme.removeEventListener('change', updateTheme);
  disposeLogos();
  disposeNavigation();
});
