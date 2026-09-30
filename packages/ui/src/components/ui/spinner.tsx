import { IconLoader6Outline18 } from '../../icons';
import { cn } from '../../lib/utils';

function Spinner({
  className,
  ...props
}: Omit<React.ComponentProps<'svg'>, 'strokeWidth'>) {
  return (
    <IconLoader6Outline18
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn('size-4 animate-spin', className)}
      {...props}
    />
  );
}

export { Spinner };
