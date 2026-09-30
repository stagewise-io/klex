import type { SVGProps } from 'react';

export function IconSlack(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" fill="none" {...props}>
      <g fill="#36C5F0">
        <rect y="8" width="14" height="6" rx="3" />
        <path d="M14 3a3 3 0 1 0-3 3h3V3Z" />
      </g>
      <g fill="#2EB67D">
        <rect x="18" width="6" height="14" rx="3" />
        <path d="M29 14a3 3 0 1 0-3-3v3h3Z" />
      </g>
      <g fill="#ECB22E">
        <rect x="18" y="18" width="14" height="6" rx="3" />
        <path d="M18 29a3 3 0 1 0 3-3h-3v3Z" />
      </g>
      <g fill="#E01E5A">
        <rect x="8" y="18" width="6" height="14" rx="3" />
        <path d="M3 18a3 3 0 1 0 3 3v-3H3Z" />
      </g>
    </svg>
  );
}
