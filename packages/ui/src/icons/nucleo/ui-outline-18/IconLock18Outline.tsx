import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconLock18OutlineProps extends IconProps {
  strokeWidth?: number;
}

export const IconLock18Outline: React.FC<IconLock18OutlineProps> = ({
  strokeWidth = 1.5,
  ...props
}) => {
  return (
    <Icon size="18px" {...props}>
      <path
        d="M5.75 8.25V5C5.75 3.205 7.205 1.75 9 1.75C10.795 1.75 12.25 3.205 12.25 5V8.25"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="9"
        y1="11.75"
        x2="9"
        y2="12.75"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <rect
        x="3.25"
        y="8.25"
        width="11.5"
        height="8"
        rx="2"
        ry="2"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Icon>
  );
};
