import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconChevronMaximizeDiagonal2Outline18Props extends IconProps {
  strokeWidth?: number;
}

export const IconChevronMaximizeDiagonal2Outline18: React.FC<
  IconChevronMaximizeDiagonal2Outline18Props
> = ({ strokeWidth = 1.5, ...props }) => {
  return (
    <Icon size="18px" {...props}>
      <polyline
        points="14.25 9.75 14.25 14.25 9.75 14.25"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
        data-color="color-2"
      />
      <polyline
        points="3.75 8.25 3.75 3.75 8.25 3.75"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    </Icon>
  );
};
