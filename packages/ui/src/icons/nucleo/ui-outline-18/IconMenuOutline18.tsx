import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconMenuOutline18Props extends IconProps {
  strokeWidth?: number;
}

export const IconMenuOutline18: React.FC<IconMenuOutline18Props> = ({
  strokeWidth = 1.5,
  ...props
}) => (
  <Icon size="18px" {...props}>
    <g
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
    >
      <line x1="2.25" y1="9" x2="15.75" y2="9" />
      <line x1="2.25" y1="3.75" x2="15.75" y2="3.75" />
      <line x1="2.25" y1="14.25" x2="15.75" y2="14.25" />
    </g>
  </Icon>
);
