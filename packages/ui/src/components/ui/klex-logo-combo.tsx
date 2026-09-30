import type { FC, HTMLAttributes } from 'react';

import { cn } from '../../lib/utils';
import {
  KlexLogo,
  type KlexLogoColorMode,
  type KlexLogoVariant,
} from './klex-logo';
import { KlexLogoText, type KlexLogoTextVariant } from './klex-logo-text';

export interface KlexLogoComboProps extends HTMLAttributes<HTMLDivElement> {
  /** className applied to the logo mark */
  logoClassName?: string;
  /** className applied to the wordmark */
  textClassName?: string;
  /** className applied to the wordmark path */
  textPathClassName?: string;
  /** Height of the combined logo in px. Defaults to 32. */
  size?: number;
  /** Variant of the logo mark. Defaults to 'boxed-square'. */
  variant?: KlexLogoVariant;
  /** Color mode of the logo mark. Defaults to 'primary'. */
  colorMode?: KlexLogoColorMode;
  /** Wordmark text variant. Defaults to 'klex'. */
  textVariant?: KlexLogoTextVariant;
}

export const KlexLogoCombo: FC<KlexLogoComboProps> = ({
  className,
  logoClassName,
  textClassName,
  textPathClassName,
  size = 32,
  variant = 'boxed-square',
  colorMode = 'primary',
  textVariant = 'klex',
  style,
  ...props
}) => {
  const ariaLabels: Record<KlexLogoTextVariant, string> = {
    klex: 'Klex',
    'klex-cloud': 'Klex Cloud',
    'klex-docs': 'Klex Docs',
  };

  return (
    <div
      className={cn('flex shrink-0 items-center', className)}
      style={{ gap: size * 0.26, ...style }}
      role="img"
      aria-label={ariaLabels[textVariant]}
      data-slot="klex-logo-combo"
      {...props}
    >
      <KlexLogo
        variant={variant}
        colorMode={colorMode}
        size={size}
        className={logoClassName}
      />
      <KlexLogoText
        variant={textVariant}
        className={cn('w-auto shrink-0', textClassName)}
        pathClassName={textPathClassName}
        style={{ height: size * 0.8 }}
      />
    </div>
  );
};
