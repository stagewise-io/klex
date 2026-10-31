import { describe, expect, it } from 'vitest';

import { buttonVariants } from '@stagewise/ui';

import { createFooterMarkup, footerMarkup } from './footer.ts';

describe('shared website footer', () => {
  it('can omit the CTA without changing the shared footer navigation or the default footer', () => {
    const compact = createFooterMarkup({ showCta: false });
    expect(compact).not.toContain('Make room for a new coworker.');
    expect(compact).not.toContain('new-footer-main');
    expect(compact).not.toContain('new-footer-cta');
    expect(
      compact.slice(compact.indexOf('<div class="new-footer-bottom">')),
    ).toBe(
      footerMarkup.slice(
        footerMarkup.indexOf('<div class="new-footer-bottom">'),
      ),
    );
    expect(createFooterMarkup()).toBe(footerMarkup);
  });
  it('uses the same button variants as the shared UI component', () => {
    expect(footerMarkup).toContain(
      `class="new-footer-cta ${buttonVariants({ size: 'lg' })}"`,
    );
  });

  it('keeps the complete site footer navigation, branding, and attribution', () => {
    expect(footerMarkup.match(/<footer\b/g)).toHaveLength(1);
    expect(footerMarkup).toContain('Make room for a new coworker.');
    expect(footerMarkup).toContain('https://cloud.klex.bot');
    expect(footerMarkup).toContain('aria-label="Resources"');
    expect(footerMarkup).toContain('aria-label="Company"');
    expect(footerMarkup).toContain('href="/legal/privacy"');
    expect(footerMarkup).toContain('href="/legal/terms"');
    expect(footerMarkup).toContain(
      'href="https://cloud.klex.bot/withdrawal">Withdraw from contract</a>',
    );
    expect(footerMarkup).toContain(
      'href="https://cloud.klex.bot/cancel-contract">Cancel contracts here</a>',
    );
    expect(footerMarkup).toContain('/stagewise-wordmark.svg');
    expect(footerMarkup).toContain(
      'European Union Intellectual Property Office',
    );
    expect(footerMarkup).toContain('Third-party product names');
    expect(footerMarkup).not.toContain('legal-footer');
  });
});
