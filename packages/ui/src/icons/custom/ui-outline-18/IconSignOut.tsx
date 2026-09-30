import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconSignOutProps extends IconProps {
  strokeWidth?: number;
}

export const IconSignOut: React.FC<IconSignOutProps> = ({
  strokeWidth = 1.5,
  ...props
}) => {
  return (
    <Icon size="18px" {...props}>
      <path
        d="M8.25 2.75h-3.5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h3.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
      <path
        d="m11.25 5.5 3.5 3.5-3.5 3.5M14.75 9h-7.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    </Icon>
  );
};
