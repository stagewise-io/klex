import type { FC, HTMLAttributes } from 'react';

import { cn } from '../../lib/utils';
import { StagewiseLogo } from './stagewise-logo';
import { StagewiseLogoText } from './stagewise-logo-text';

export interface StagewiseLogoComboProps
  extends HTMLAttributes<HTMLDivElement> {
  /** className applied to the logo mark */
  logoClassName?: string;
  /** className applied to the wordmark */
  textClassName?: string;
  /** Height of the combined logo in px. Defaults to 32. */
  size?: number;
}

export const StagewiseLogoCombo: FC<StagewiseLogoComboProps> = ({
  className,
  logoClassName,
  textClassName,
  size = 32,
  style,
  ...props
}) => {
  return (
    <div
      className={cn('flex shrink-0 items-center', className)}
      style={{ gap: size * 0.26, ...style }}
      role="img"
      aria-label="stagewise"
      {...props}
    >
      <StagewiseLogo
        className={cn('shrink-0', logoClassName)}
        style={{ width: size, height: size }}
      />
      <StagewiseLogoText
        className={cn('shrink-0', textClassName)}
        style={{ height: size * 0.9, width: 'auto' }}
      />
    </div>
  );
};
