import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { useState } from 'react';

import { cn } from '../../lib/utils';

function Switch({
  className,
  size = 'default',
  onCheckedChange,
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: 'sm' | 'default';
}) {
  // The knob springs only once someone flips it: CSS animations also run when
  // an element first renders, so a switch that loads on would slide over.
  const [flipped, setFlipped] = useState(false);
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-all outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-5 data-[size=default]:w-[34px] data-[size=sm]:h-4 data-[size=sm]:w-[26px] px-px dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:bg-primary data-unchecked:bg-input dark:data-unchecked:bg-input/80 data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className,
      )}
      {...props}
      onCheckedChange={(checked, details) => {
        setFlipped(true);
        onCheckedChange?.(checked, details);
      }}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block rounded-full bg-background ring-0 group-data-[size=default]/switch:h-4 group-data-[size=sm]/switch:h-3 group-data-[size=default]/switch:w-4 group-data-[size=sm]/switch:w-3 group-data-[size=default]/switch:[--knob-w:1rem] group-data-[size=sm]/switch:[--knob-w:0.75rem] group-data-[size=default]/switch:[--knob-travel:14px] group-data-[size=sm]/switch:[--knob-travel:10px] group-data-[size=default]/switch:[--track-w:30px] group-data-[size=sm]/switch:[--track-w:22px] group-data-[size=default]/switch:data-checked:translate-x-[14px] group-data-[size=sm]/switch:data-checked:translate-x-[10px] dark:data-checked:bg-primary-foreground dark:data-unchecked:bg-foreground',
          flipped &&
            'group-data-checked/switch:animate-switch-knob-on group-data-unchecked/switch:animate-switch-knob-off',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
