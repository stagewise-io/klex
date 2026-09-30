import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconArrowDownOutline18Props extends IconProps {
  strokeWidth?: number;
}
export const IconArrowDownOutline18: React.FC<IconArrowDownOutline18Props> = ({
  strokeWidth = 1.5,
  ...props
}) => {
  return (
    <Icon size="18px" {...props}>
      <line
        x1="9"
        y1="15.25"
        x2="9"
        y2="2.75"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
      <polyline
        points="13.25 11 9 15.25 4.75 11"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    </Icon>
  );
};
