import './title-avatars.css';

import { createRoot } from 'react-dom/client';

import { heroLooks } from '../../bot-looks';
import { Klex } from '../../klex';

export const workflowTitleMarkup = (title: string) =>
  title.replace(
    /\b(Monica|Kristine|Jonathan|Jeff)\b/g,
    (name) =>
      `<span class="new-workflow-bot-name"><span class="new-workflow-title-avatar" data-bot="${name.toLowerCase()}" aria-hidden="true"></span>${name}</span>`,
  );

export function mountWorkflowTitleAvatars(navigation: HTMLElement) {
  const avatars = Array.from(
    navigation.querySelectorAll<HTMLElement>('.new-workflow-title-avatar'),
  ).map((host) => {
    const root = createRoot(host);
    const look = heroLooks[host.dataset.bot ?? ''];
    const resize = new ResizeObserver(([entry]) => {
      root.render(
        <Klex
          {...look}
          size={entry.contentRect.width}
          layout="avatar"
          activity="idle"
        />,
      );
    });
    resize.observe(host);
    return () => {
      resize.disconnect();
      root.unmount();
    };
  });
  return () => {
    for (const dispose of avatars) dispose();
  };
}
