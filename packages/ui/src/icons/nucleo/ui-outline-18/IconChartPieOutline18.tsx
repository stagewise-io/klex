import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconChartPieOutline18Props extends IconProps {
  strokeWidth?: number;
}
export const IconChartPieOutline18: React.FC<IconChartPieOutline18Props> = ({
  strokeWidth = 1.5,
  ...props
}) => {
  return (
    <Icon size="18px" {...props}>
      <path
        d="M15.602 12c-1.141 2.507-3.668 4.25-6.602 4.25-4.004 0-7.25-3.246-7.25-7.25 0-2.934 1.743-5.461 4.25-6.602"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M16.25 9c0-4.004-3.246-7.25-7.25-7.25v7.25h7.25Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Icon>
  );
};
