import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconEmptyOutline18Props extends IconProps {
  strokeWidth?: number;
}

export const IconEmptyOutline18: React.FC<IconEmptyOutline18Props> = ({
  strokeWidth = 1.5,
  ...props
}) => {
  return (
    <Icon size="18px" {...props}>
      <path
        d="M4.581 13.419C3.45 12.288 2.75 10.725 2.75 9C2.75 5.548 5.548 2.75 9 2.75C10.726 2.75 12.288 3.45 13.419 4.581"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M2 16L16 2"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        data-color="color-2"
        fill="none"
      />
      <path
        d="M7.25537 14.9868C7.81087 15.1487 8.39267 15.25 8.99997 15.25C12.452 15.25 15.25 12.4519 15.25 9C15.25 8.3926 15.1486 7.811 14.9868 7.2554"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Icon>
  );
};
