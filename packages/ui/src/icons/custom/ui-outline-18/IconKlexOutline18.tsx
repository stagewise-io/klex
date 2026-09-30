import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconKlexOutline18Props extends IconProps {
  strokeWidth?: number;
}

export const IconKlexOutline18: React.FC<IconKlexOutline18Props> = ({
  strokeWidth = 1.5,
  ...props
}) => {
  return (
    <Icon size="18px" {...props}>
      <path
        d="M15.1157 7.5232C15.2123 4.8178 13.609 2.25 10.7464 2.25C7.2812 2.25 6.2607 4.5553 5.9252 7.0712C5.0212 13.8511 2.8784 14.1964 2.8784 14.6483C2.8784 14.8774 3.5062 15.7469 5.7033 14.8053C6.6157 14.4143 7.3672 15.3563 8.0575 15.4331C8.7912 15.5147 9.2226 15.1597 9.9408 14.9622C10.7668 14.7351 11.526 15.59 12.1379 15.59C14.2472 15.59 14.965 11.7418 15.1157 7.5232Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
      <ellipse
        cx="10.7255"
        cy="6.9582"
        fill="currentColor"
        rx=".6278"
        ry=".9416"
      />
      <ellipse
        cx="12.9226"
        cy="6.9582"
        fill="currentColor"
        rx=".6278"
        ry=".9416"
      />
    </Icon>
  );
};
