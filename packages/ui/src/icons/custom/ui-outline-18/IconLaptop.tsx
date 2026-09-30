import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconLaptopProps extends IconProps {
  strokeWidth?: number;
}

export const IconLaptop: React.FC<IconLaptopProps> = ({
  strokeWidth = 1.5,
  ...props
}) => {
  return (
    <Icon size="18px" {...props}>
      <rect
        fill="none"
        height="9"
        rx="1.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        width="12"
        x="3"
        y="2.5"
      />
      <path
        d="M3 11.5 1.75 14.5h14.5L15 11.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    </Icon>
  );
};
