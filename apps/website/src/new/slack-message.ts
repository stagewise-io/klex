import './slack-message.css';

import { type BodyShape, mascotMarkup } from '../mascot';
import { heroLooks } from './bot-looks';

// Static, authored website content only. body contains trusted message markup.
export function slackMessageMarkup({
  name,
  bot,
  look: avatarLook,
  time,
  body,
  className = '',
  hidden = false,
}: {
  name: string;
  bot?: 'monica' | 'kristine' | 'jonathan' | 'jeff';
  look?: { color: string; shape: BodyShape };
  time: string;
  body: string;
  className?: string;
  hidden?: boolean;
}) {
  const look = avatarLook ?? (bot ? heroLooks[bot] : undefined);
  return `<article class="new-slack-message ${className}" ${hidden ? 'hidden' : ''} ${bot ? '' : 'aria-live="off"'}>
    <span class="new-slack-avatar ${look ? 'new-slack-bot-avatar' : 'new-slack-you-avatar'}" aria-hidden="true" ${look ? `style="--slack-avatar-color: ${look.color}"` : ''}>
      ${look ? mascotMarkup(look.color, look.shape) : name[0]}
    </span>
    <div>
      <p class="new-slack-message-meta"><strong>${name}</strong>${bot ? '<span class="new-slack-bot-label">APP</span>' : ''}<time>${time}</time></p>
      <p>${body}</p>
    </div>
  </article>`;
}
