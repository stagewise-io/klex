import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconArrowUpOutline18Props extends IconProps {
  strokeWidth?: number;
}
export const IconArrowUpOutline18: React.FC<IconArrowUpOutline18Props> = ({
  strokeWidth = 1.5,
  ...props
}) => {
  return (
    <Icon size="18px" {...props}>
      <line
        x1="9"
        y1="2.75"
        x2="9"
        y2="15.25"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
        data-color="color-2"
      />
      <polyline
        points="4.75 7 9 2.75 13.25 7"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    </Icon>
  );
};
