import type React from 'react';

import { Icon, type IconProps } from './Icon';

interface IconMsgs2Outline18Props extends IconProps {
  strokeWidth?: number;
}
export const IconMsgs2Outline18: React.FC<IconMsgs2Outline18Props> = ({
  strokeWidth = 1.5,
  ...props
}) => {
  return (
    <Icon size="18px" {...props}>
      <path
        d="m11.5598,4.7546c-.8373-1.4424-2.3575-2.4387-4.1301-2.5015-2.8675-.1013-5.1796,2.3672-5.1796,5.2366v4.2603c0,.2761.2239.5.5.5h2.0253"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
        data-color="color-2"
      />
      <path
        d="m15.75,11.9676v3.2824c0,.2761-.22.5-.4961.5h-3.0176c-2.5925,0-4.5949-1.8811-4.4814-4.1988.1004-2.0509,1.7454-3.6959,3.7963-3.7963,2.3178-.1135,4.1989,1.8922,4.1989,4.2127Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    </Icon>
  );
};
