import artwork from 'virtual:klex-static-mascots';
import type { Klex, KlexHandle } from '@klex/mascot';
import {
  Component,
  type ComponentProps,
  lazy,
  type ReactNode,
  type Ref,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

const AnimatedMascot = lazy(() => import('./runtime-mascot'));

class AnimationBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** SSR and initial hydration use the exact same cached image. */
export function ProgressiveMascot({
  snapshot,
  onReady,
  ref,
  ...props
}: Omit<ComponentProps<typeof Klex>, 'ref'> & {
  snapshot: string;
  onReady?: () => void;
  ref?: Ref<KlexHandle>;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [animate, setAnimate] = useState(false);
  const asset = artwork[snapshot];
  if (!asset) throw new Error(`Unknown mascot snapshot: ${snapshot}`);
  const size = typeof props.size === 'number' ? props.size : 66;
  const width = props.width ?? size;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    const update = () => setAnimate(visible && !motion.matches);
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          visible = true;
          update();
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(element);
    motion.addEventListener('change', update);
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', update);
    };
  }, []);
  const attach = useCallback(
    (handle: KlexHandle | null) => {
      if (typeof ref === 'function') ref(handle);
      else if (ref) ref.current = handle;
      if (handle) onReady?.();
    },
    [ref, onReady],
  );
  const fallback = (
    <span
      data-mascot-fallback=""
      style={{
        display: 'block',
        position: 'relative',
        width,
        height: size,
        flexShrink: 0,
      }}
    >
      <img
        src={asset.src}
        alt="Klex"
        width={size}
        height={size}
        style={{
          position: 'absolute',
          width: size,
          height: size,
          left: `calc(50% - ${size / 2}px)`,
          top: 0,
        }}
      />
    </span>
  );
  return (
    <span
      ref={host}
      data-progressive-mascot=""
      style={{ display: 'block', width, height: size, flexShrink: 0 }}
    >
      {animate ? (
        <AnimationBoundary fallback={fallback}>
          <Suspense fallback={fallback}>
            <AnimatedMascot {...props} ref={attach} />
          </Suspense>
        </AnimationBoundary>
      ) : (
        fallback
      )}
    </span>
  );
}
