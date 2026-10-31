import { mountLogoMenus } from '@/new/logo-menu';
import { mountNavigation } from '@/new/navigation';

import { createLegalPage } from './client.ts';

const theme = matchMedia('(prefers-color-scheme: dark)');
const updateTheme = () =>
  document.documentElement.classList.toggle('dark', theme.matches);
updateTheme();
theme.addEventListener('change', updateTheme);

const page = createLegalPage({
  document,
  window,
  fetch: window.fetch.bind(window),
});
void page.start();
const disposeNavigation = mountNavigation();
const disposeLogos = mountLogoMenus(document.body);

import.meta.hot?.dispose(() => {
  page.close();
  theme.removeEventListener('change', updateTheme);
  disposeLogos();
  disposeNavigation();
});
