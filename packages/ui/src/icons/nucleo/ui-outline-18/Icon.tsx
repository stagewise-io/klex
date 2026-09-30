import type React from 'react';

export interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  title?: string;
}
export const Icon: React.FC<IconProps> = ({
  children,
  size = 18,
  title,
  width,
  height,
  ...props
}) => {
  return (
    <svg
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
      width={width || size}
      height={height || size}
      viewBox="0 0 18 18"
      aria-hidden={
        title || props['aria-label'] || props['aria-labelledby']
          ? undefined
          : true
      }
      {...props}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
};
