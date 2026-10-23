import type React from 'react';

import {
  Icon,
  type IconProps,
} from '@stagewise/ui/icons/nucleo/ui-outline-18/Icon.tsx';

// Nucleo icon kept with the website because @stagewise/ui does not ship it.
export const IconMenuOutline18: React.FC<IconProps> = (props) => (
  <Icon size="18px" {...props}>
    <g
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
    >
      <line x1="2.25" y1="9" x2="15.75" y2="9" />
      <line x1="2.25" y1="3.75" x2="15.75" y2="3.75" />
      <line x1="2.25" y1="14.25" x2="15.75" y2="14.25" />
    </g>
  </Icon>
);
