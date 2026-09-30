import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconWaveformLinesOutline18Props extends IconProps {
  strokeWidth?: number;
}
export const IconWaveformLinesOutline18: React.FC<
  IconWaveformLinesOutline18Props
> = ({ strokeWidth = 1.5, ...props }) => {
  return (
    <Icon size="18px" {...props}>
      <line
        x1="1.25"
        x2="1.25"
        y1="8.25"
        y2="9.75"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="16.25"
        x2="16.25"
        y1="8.25"
        y2="9.75"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="4.25"
        x2="4.25"
        y1="3.75"
        y2="14.25"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="7.25"
        x2="7.25"
        y1="5.75"
        y2="12.25"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="10.25"
        x2="10.25"
        y1="2.75"
        y2="15.25"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="13.25"
        x2="13.25"
        y1="5.75"
        y2="12.25"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Icon>
  );
};
