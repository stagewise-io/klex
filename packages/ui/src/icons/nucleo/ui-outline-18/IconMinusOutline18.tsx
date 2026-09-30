import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconMinusOutline18Props extends IconProps {
  strokeWidth?: number;
}
export const IconMinusOutline18: React.FC<IconMinusOutline18Props> = ({
  strokeWidth = 1.5,
  ...props
}) => {
  return (
    <Icon size="18px" {...props}>
      <line
        x1="3.25"
        y1="9"
        x2="14.75"
        y2="9"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    </Icon>
  );
};
