import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconPanelLeftOutline18Props extends IconProps {
  strokeWidth?: number;
}
export const IconPanelLeftOutline18: React.FC<IconPanelLeftOutline18Props> = ({
  strokeWidth = 1.5,
  ...props
}) => {
  return (
    <Icon size="18px" {...props}>
      <line
        x1="6.25"
        y1="2.75"
        x2="6.25"
        y2="15.25"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
      <rect
        width="14.5"
        height="12.5"
        x="1.75"
        y="2.75"
        rx="2"
        ry="2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
        transform="translate(18 18) rotate(180)"
      />
    </Icon>
  );
};
