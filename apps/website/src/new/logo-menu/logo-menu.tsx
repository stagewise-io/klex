import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@stagewise/ui/src/components/ui/context-menu.tsx';

export function logoMenuActions(dark: boolean) {
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

export function LogoContextMenu() {
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

class LogoMenuModule {
  private started = false;
  private closed = false;
  private readonly mounted: {
    host: HTMLElement;
    logo: HTMLAnchorElement;
    root: Root;
  }[] = [];

  private readonly container: ParentNode;

  constructor(container: ParentNode) {
    this.container = container;
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    try {
      for (const logo of this.container.querySelectorAll<HTMLAnchorElement>(
        'a.new-brand',
      )) {
        const host = logo.ownerDocument.createElement('span');
        host.style.display = 'contents';
        const root = createRoot(host);
        this.mounted.push({ host, logo, root });
        logo.replaceWith(host);
        root.render(<LogoContextMenu />);
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { host, logo, root } of this.mounted) {
      root.unmount();
      host.replaceWith(logo);
    }
    this.mounted.length = 0;
  }
}

export function mountLogoMenus(container: ParentNode) {
  const menus = new LogoMenuModule(container);
  menus.start();
  return () => menus.close();
}
