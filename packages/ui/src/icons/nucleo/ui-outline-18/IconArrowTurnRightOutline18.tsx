import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconArrowTurnRightOutline18Props extends IconProps {
  strokeWidth?: number;
}

export const IconArrowTurnRightOutline18: React.FC<
  IconArrowTurnRightOutline18Props
> = ({ strokeWidth = 1.5, ...props }) => {
  return (
    <Icon size="18px" {...props}>
      <path
        d="M15.25,8.25H4.75c-1.105,0-2,.895-2,2v4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
        data-color="color-2"
      />
      <polyline
        points="11 12.5 15.25 8.25 11 4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    </Icon>
  );
};
