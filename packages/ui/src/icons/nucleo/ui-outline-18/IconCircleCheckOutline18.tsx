import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconCircleCheckOutline18Props extends IconProps {
  strokeWidth?: number;
}
export const IconCircleCheckOutline18: React.FC<
  IconCircleCheckOutline18Props
> = ({ strokeWidth = 1.5, ...props }) => {
  return (
    <Icon size="18px" {...props}>
      <circle
        cx="9"
        cy="9"
        r="7.25"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
      <polyline
        points="5.75 9.25 8 11.75 12.25 6.25"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    </Icon>
  );
};
