import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@stagewise/ui';

function logoMenuActions(dark: boolean) {
  const theme = dark ? 'dark' : 'light';
  return [
    {
      label: 'Download logo',
      href: `/brand/klex-square-${theme}.svg`,
      download: `klex-square-${theme}.svg`,
    },
    {
      label: 'Download logo + wordmark',
      href: `/klex-logo-${theme}.svg`,
      download: `klex-logo-wordmark-${theme}.svg`,
    },
    { label: 'Show brand kit', href: '/brand', download: undefined },
  ];
}

function LogoContextMenu() {
  const [dark, setDark] = useState(false);
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) setDark(document.documentElement.classList.contains('dark'));
      }}
    >
      <ContextMenuTrigger
        render={<a className="new-brand" href="/" aria-label="Klex home" />}
      >
        <img
          className="new-logo-light"
          src="/klex-logo-light.svg"
          alt="Klex"
          width="88"
          height="33"
        />
        <img
          className="new-logo-dark"
          src="/klex-logo-dark.svg"
          alt="Klex"
          width="88"
          height="33"
        />
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label="Klex logo"
        className="min-w-64 motion-reduce:animate-none"
      >
        {logoMenuActions(dark).map((action) => (
          <ContextMenuItem
            key={action.label}
            render={<a href={action.href} download={action.download} />}
          >
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Swaps each prerendered logo link for one with a context menu. */
export function mountLogoMenus(container: ParentNode) {
  const mounted = Array.from(
    container.querySelectorAll<HTMLAnchorElement>('a.new-brand'),
    (logo) => {
      const host = logo.ownerDocument.createElement('span');
      host.style.display = 'contents';
      const root = createRoot(host);
      logo.replaceWith(host);
      root.render(<LogoContextMenu />);
      return { host, logo, root };
    },
  );
  return () => {
    for (const { host, logo, root } of mounted) {
      root.unmount();
      host.replaceWith(logo);
    }
  };
}
