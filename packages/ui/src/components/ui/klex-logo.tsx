import type { FC, HTMLAttributes } from 'react';

import { cn } from '../../lib/utils';

export type KlexLogoVariant = 'free-standing' | 'boxed-square' | 'boxed-round';
export type KlexLogoColorMode = 'primary' | 'monochrome';

export interface KlexLogoProps extends HTMLAttributes<HTMLDivElement> {
  /** Visual style of the logo mark. Defaults to 'boxed-square'. */
  variant?: KlexLogoVariant;
  /** Color scheme. Defaults to 'primary'. */
  colorMode?: KlexLogoColorMode;
  /** Width of the logo in px (height is derived via aspect-square). Defaults to 32. */
  size?: number;
}

interface IconColors {
  box?: string;
  body: string;
  eyes: string;
}

const colorMap: Record<
  KlexLogoVariant,
  Record<KlexLogoColorMode, IconColors>
> = {
  'free-standing': {
    primary: { body: 'fill-primary', eyes: 'fill-base-50' },
    monochrome: {
      body: 'fill-base-950 dark:fill-base-50',
      eyes: 'fill-base-50 dark:fill-base-950',
    },
  },
  'boxed-square': {
    primary: { box: 'bg-primary', body: 'fill-base-50', eyes: 'fill-primary' },
    monochrome: {
      box: 'bg-base-950 dark:bg-base-50',
      body: 'fill-base-50 dark:fill-base-950',
      eyes: 'fill-base-950 dark:fill-base-50',
    },
  },
  'boxed-round': {
    primary: { box: 'bg-primary', body: 'fill-base-50', eyes: 'fill-primary' },
    monochrome: {
      box: 'bg-base-950 dark:bg-base-50',
      body: 'fill-base-50 dark:fill-base-950',
      eyes: 'fill-base-950 dark:fill-base-50',
    },
  },
};

const variantClass: Record<KlexLogoVariant, string> = {
  'free-standing': '',
  'boxed-square': 'rounded-[30%]',
  'boxed-round': 'rounded-full',
};

const GHOST_PATH =
  'M96.9692 39.5294C97.6935 19.2487 85.675 0 64.2162 0C38.2397 0 30.5897 17.281 28.075 36.1412C21.2985 86.9647 5.23535 89.5529 5.23535 92.9412C5.23535 94.6582 9.94124 101.176 26.4118 94.1176C33.2509 91.1866 38.8849 98.2481 44.0589 98.8235C49.5595 99.4353 52.7928 96.7746 58.1766 95.2941C64.3687 93.5913 70.0597 100 74.6472 100C90.4589 100 95.8398 71.153 96.9692 39.5294Z';

interface KlexLogoIconProps {
  className?: string;
  bodyClassName?: string;
  eyesClassName?: string;
}

const KlexLogoIcon: FC<KlexLogoIconProps> = ({
  className,
  bodyClassName,
  eyesClassName,
}) => (
  <svg
    viewBox="-2 -2 104 104"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={cn('size-full aspect-square', className)}
    aria-hidden="true"
    data-slot="klex-logo-icon"
  >
    <path className={bodyClassName} d={GHOST_PATH} />
    <ellipse
      className={eyesClassName}
      cx="64.0589"
      cy="35.2942"
      rx="4.70588"
      ry="7.05883"
    />
    <ellipse
      className={eyesClassName}
      cx="80.5294"
      cy="35.2942"
      rx="4.70588"
      ry="7.05883"
    />
  </svg>
);

export const KlexLogo: FC<KlexLogoProps> = ({
  variant = 'boxed-square',
  colorMode = 'primary',
  size = 32,
  className,
  style,
  ...props
}) => {
  const colors = colorMap[variant][colorMode];
  const isBoxed = variant !== 'free-standing';

  if (!isBoxed) {
    return (
      <div
        className={cn('aspect-square shrink-0', className)}
        style={{ width: size, ...style }}
        role="img"
        aria-label="Klex"
        data-slot="klex-logo"
        {...props}
      >
        <KlexLogoIcon bodyClassName={colors.body} eyesClassName={colors.eyes} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex aspect-square shrink-0 items-center justify-center',
        variantClass[variant],
        colors.box,
        className,
      )}
      style={{ width: size, ...style }}
      role="img"
      aria-label="Klex"
      data-slot="klex-logo"
      {...props}
    >
      <KlexLogoIcon
        className="size-[50%]"
        bodyClassName={colors.body}
        eyesClassName={colors.eyes}
      />
    </div>
  );
};
