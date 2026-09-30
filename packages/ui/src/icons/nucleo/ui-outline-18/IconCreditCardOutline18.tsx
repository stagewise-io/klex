import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconCreditCardOutline18Props extends IconProps {
  strokeWidth?: number;
}
export const IconCreditCardOutline18: React.FC<
  IconCreditCardOutline18Props
> = ({ strokeWidth = 1.5, ...props }) => {
  return (
    <Icon size="18px" {...props}>
      <rect
        x="1.75"
        y="3.75"
        width="14.5"
        height="10.5"
        rx="2"
        ry="2"
        transform="translate(18 18) rotate(180)"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="1.75"
        x2="16.25"
        y1="7.25"
        y2="7.25"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="4.25"
        x2="7.25"
        y1="11.25"
        y2="11.25"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="12.75"
        x2="13.75"
        y1="11.25"
        y2="11.25"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Icon>
  );
};
