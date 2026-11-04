import { Klex } from '@klex/mascot';
import { renderToStaticMarkup } from 'react-dom/server';

import { IconGithub } from '@stagewise/ui/icons/nucleo/social-media/IconGithub.tsx';
import { IconDiscord } from '@stagewise/ui/icons/provider/IconDiscord.tsx';
import { IconSlack } from '@stagewise/ui/icons/provider/IconSlack.tsx';

import { mascotMarkup } from '../../mascot';
import { heroLooks, klexLook } from '../bot-looks';

/** Build-only renderer: keep the package's exact static avatar artwork. */
export function renderStaticMascots() {
  return {
    github: renderToStaticMarkup(<IconGithub />),
    discord: renderToStaticMarkup(<IconDiscord />),
    slack: renderToStaticMarkup(<IconSlack />),
    ...Object.fromEntries(
      Object.entries(heroLooks).map(([name, look]) => [
        `slack-${name}`,
        mascotMarkup(look.color, look.shape),
      ]),
    ),
    ...Object.fromEntries(
      Object.entries({ ...heroLooks, brand: klexLook }).map(([name, look]) => [
        name,
        renderToStaticMarkup(
          <Klex {...look} size={160} layout="avatar" idle={false} />,
        ),
      ]),
    ),
  };
}
