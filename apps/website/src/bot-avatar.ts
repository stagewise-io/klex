import { mascotMarkup } from './mascot';

export const botIdentities = {
  Harry: { color: '#2559fe', form: 'box', personality: 'curious' },
  Sarah: { color: '#ffbd91', form: 'circle', personality: 'sunny' },
  Pip: { color: '#a7cbb6', form: 'classic', personality: 'shy' },
  Momo: { color: '#b9a4e3', form: 'diamond', personality: 'curious' },
} as const;

export function botAvatarMarkup(name: keyof typeof botIdentities) {
  const bot = botIdentities[name];
  return mascotMarkup(bot.color, bot.form);
}
