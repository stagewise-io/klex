// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { i18n, locales, t } from '@/i18n';

import { workflowMarkup } from './index';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('mobile workflow navigation', () => {
  it.each(locales)(
    'includes each visible number and phase in its accessible name in %s',
    async (locale) => {
      await i18n.changeLanguage(locale);
      const document = new DOMParser().parseFromString(
        workflowMarkup(['', '', '', '']),
        'text/html',
      );
      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '.new-workflow-mobile-steps button',
        ),
      ];
      const phases = [
        'Request',
        'Plan & build',
        'Test & fix',
        'Report back',
      ] as const;
      expect(buttons).toHaveLength(4);
      buttons.forEach((button, index) => {
        const number = String(index + 1).padStart(2, '0');
        expect(button.textContent).toBe(number);
        expect(button.getAttribute('aria-label')).toContain(number);
        expect(button.getAttribute('aria-label')).toContain(t(phases[index]));
        expect(button.getAttribute('aria-controls')).toBe(
          `new-workflow-panel-${index}`,
        );
        expect(button.getAttribute('aria-current')).toBe(
          index === 0 ? 'step' : 'false',
        );
      });
    },
  );
});
