import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconChevronUpOutline18Props extends IconProps {
  strokeWidth?: number;
}
export const IconChevronUpOutline18: React.FC<IconChevronUpOutline18Props> = ({
  strokeWidth = 1.5,
  ...props
}) => {
  return (
    <Icon size="18px" {...props}>
      <polyline
        points="2.75 11.5 9 5.25 15.25 11.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    </Icon>
  );
};
