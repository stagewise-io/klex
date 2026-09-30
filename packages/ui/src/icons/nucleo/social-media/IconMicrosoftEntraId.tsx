import type React from 'react';

export interface IconMicrosoftEntraIdProps
  extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  title?: string;
}

export const IconMicrosoftEntraId: React.FC<IconMicrosoftEntraIdProps> = ({
  size = 18,
  title,
  ...props
}) => {
  return (
    <svg
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden={
        title || props['aria-label'] || props['aria-labelledby']
          ? undefined
          : true
      }
      {...props}
    >
      {title && <title>{title}</title>}
      <path
        d="M3.80176 14.0318C4.18976 14.2738 4.83476 14.5428 5.51676 14.5428C6.13776 14.5428 6.71476 14.3628 7.19276 14.0558C7.19276 14.0558 7.19376 14.0558 7.19476 14.0548L8.99976 12.9268V16.9998C8.71376 16.9998 8.42576 16.9218 8.17576 16.7658L3.80176 14.0318Z"
        fill="currentColor"
        fillOpacity={0.7}
      />
      <path
        d="M7.853 1.507L0.352996 9.967C-0.226004 10.621 -0.0750036 11.609 0.675996 12.078C0.675996 12.078 3.452 13.813 3.802 14.032C4.19 14.274 4.835 14.543 5.517 14.543C6.138 14.543 6.715 14.363 7.193 14.056C7.193 14.056 7.194 14.056 7.195 14.055L9 12.927L4.636 10.199L9.001 5.275V1C8.577 1 8.153 1.169 7.853 1.507Z"
        fill="currentColor"
        fillOpacity={0.2}
      />
      <path
        d="M4.63623 10.1994L4.68823 10.2314L9.00023 12.9274H9.00123V5.27639L9.00023 5.27539L4.63623 10.1994Z"
        fill="currentColor"
        fillOpacity={0.4}
      />
      <path
        d="M17.324 12.078C18.075 11.609 18.226 10.621 17.647 9.967L12.726 4.416C12.329 4.231 11.884 4.125 11.413 4.125C10.488 4.125 9.66098 4.524 9.11098 5.151L9.00198 5.274L13.366 10.198L9.00098 12.926V16.999C9.28798 16.999 9.57398 16.921 9.82398 16.765L17.324 12.077V12.078Z"
        fill="currentColor"
      />
      <path
        d="M9.001 1V5.275L9.11 5.152C9.66 4.525 10.487 4.126 11.412 4.126C11.884 4.126 12.328 4.233 12.725 4.417L10.146 1.508C9.847 1.17 9.423 1.001 9 1.001L9.001 1Z"
        fill="currentColor"
        fillOpacity={0.6}
      />
      <path
        d="M13.365 10.1994L9.00098 5.27637V12.9264L13.365 10.1994Z"
        fill="currentColor"
        fillOpacity={0.6}
      />
    </svg>
  );
};
