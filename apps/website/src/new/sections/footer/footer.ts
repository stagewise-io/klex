import { buttonVariants } from '@stagewise/ui';

import { createFooterMarkup as renderFooter } from './markup.ts';

export function createFooterMarkup({
  showCta = true,
}: {
  showCta?: boolean;
} = {}): string {
  return renderFooter({ showCta, buttonClass: buttonVariants({ size: 'lg' }) });
}

export const footerMarkup = createFooterMarkup();
