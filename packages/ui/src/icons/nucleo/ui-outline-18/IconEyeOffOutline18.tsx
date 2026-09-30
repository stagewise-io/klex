import { Icon, type IconProps } from './Icon';

export function IconEyeOffOutline18({
  strokeWidth = 1.5,
  ...props
}: IconProps) {
  return (
    <Icon fill="none" {...props}>
      <path
        d="M7.08 3.71A8 8 0 0 1 9 3.5c3.795 0 6.009 2.715 6.956 4.387a2.26 2.26 0 0 1 0 2.226 10.5 10.5 0 0 1-1.72 2.247M11.4 14.13a8.23 8.23 0 0 1-2.4.37c-3.795 0-6.009-2.715-6.956-4.387a2.26 2.26 0 0 1 0-2.226A10.63 10.63 0 0 1 4 5.4M7.055 7.055a2.75 2.75 0 0 0 3.89 3.89M1.75 1.75l14.5 14.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  );
}
