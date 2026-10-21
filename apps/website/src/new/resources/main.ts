import '../base.css';
import '../navigation.css';
import '../sections/footer/footer.css';
import './resources.css';

import { mountLogoMenus } from '../logo-menu';
import { mountNavigation } from '../navigation';
import { mountPngDownloads } from './png-downloads';

const app = document.getElementById('app');
if (!app) throw new Error('The website root is missing.');

const isPress = location.pathname.replace(/\/$/, '') === '/press';
document.body.classList.add('resource-page');
if (!app.hasChildNodes())
  app.innerHTML = (await import('./page-markup')).resourceMarkup(isPress);

const events = new AbortController();
matchMedia('(prefers-color-scheme: dark)').addEventListener(
  'change',
  ({ matches }) => document.documentElement.classList.toggle('dark', matches),
  { signal: events.signal },
);
const disposeLogoMenus = mountLogoMenus(app);
const disposeNavigation = mountNavigation();
const disposePngDownloads = mountPngDownloads(app);
import.meta.hot?.dispose(() => {
  events.abort();
  disposeLogoMenus();
  disposeNavigation();
  disposePngDownloads();
});
