import '../base.css';
import '../navigation.css';
import '../sections/footer/footer.css';
import './resources.css';

import { currentLocale, mountLanguage } from '@/i18n';

import { mountCloudStatus } from '../cloud-status';
import { mountLogoMenus } from '../logo-menu';
import { mountNavigation } from '../navigation';
import { mountLanguageSelector } from '../sections/footer/language';
import { mountPngDownloads } from './png-downloads';

const app = document.getElementById('app');
if (!app) throw new Error('The website root is missing.');

const isPress = location.pathname.replace(/\/$/, '') === '/press';
document.body.classList.add('resource-page');
if (!app.hasChildNodes() || currentLocale() !== 'en')
  app.innerHTML = (await import('./page-markup')).resourceMarkup(isPress);

const events = new AbortController();
matchMedia('(prefers-color-scheme: dark)').addEventListener(
  'change',
  ({ matches }) => document.documentElement.classList.toggle('dark', matches),
  { signal: events.signal },
);
const disposeLanguage = mountLanguage();
const disposeLanguageSelector = mountLanguageSelector();
const disposeCloudStatus = mountCloudStatus();
const disposeLogoMenus = mountLogoMenus(app);
const disposeNavigation = mountNavigation();
const disposePngDownloads = mountPngDownloads(app);
import.meta.hot?.dispose(() => {
  events.abort();
  disposeLanguage();
  disposeLanguageSelector();
  disposeCloudStatus();
  disposeLogoMenus();
  disposeNavigation();
  disposePngDownloads();
});
