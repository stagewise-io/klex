import './profile-card.css';

import type { ComponentProps } from 'react';

import {
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
} from '@stagewise/ui/src/components/ui/popover.tsx';

import { connectorRegistry } from '../connector-registry';

type ProfileApp = { name: string; logoSrc: string };

const apps = {
  ...connectorRegistry,
  gmail: { name: 'Gmail', logoSrc: '/connectors/gmail.svg' },
  chrome: { name: 'Chrome', logoSrc: '/connectors/chrome.svg' },
};

/** Illustrative app usage shared by the hero and office profiles. */
export const botProfileApps: Record<string, readonly ProfileApp[]> = {
  jonathan: [apps.github, apps.linear, apps.slack],
  kristine: [apps.slack, apps.linear, apps.github, apps.gmail],
  monica: [apps.gmail, apps.slack],
  jeff: [apps.chrome, apps.github, apps.slack],
  harry: [apps.gmail, apps.slack],
};

export function ProfileApps({
  name,
  apps,
}: {
  name: string;
  apps: readonly ProfileApp[];
}) {
  if (!apps.length) return null;
  return (
    <div className="new-bot-profile-apps">
      <span>Uses</span>
      <ul aria-label={`Apps ${name} uses`}>
        {apps.map((app) => (
          <li key={app.logoSrc} title={app.name}>
            <img src={app.logoSrc} alt={app.name} width={20} height={20} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProfileCard({
  name,
  role,
  work,
  apps = [],
  ...props
}: {
  name: string;
  role: string;
  work: string;
  apps?: readonly ProfileApp[];
} & Omit<ComponentProps<typeof PopoverContent>, 'children'>) {
  return (
    <PopoverContent
      side="top"
      sideOffset={8}
      className="new-bot-profile new-member-hover-card w-64 max-w-[calc(100vw-1.5rem)] gap-3 overflow-x-hidden overflow-y-auto rounded-[10px] p-4 ring-0"
      {...props}
    >
      <div className="new-member-hover-card-identity">
        <PopoverTitle>{name}</PopoverTitle>
        <span className="new-klex-name-role">{role}</span>
      </div>
      <PopoverDescription className="leading-normal text-foreground">
        {work}
      </PopoverDescription>
      <ProfileApps name={name} apps={apps} />
    </PopoverContent>
  );
}
