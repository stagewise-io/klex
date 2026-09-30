import { useEffect, useState } from 'react';

// Each illustration has its own clock, which stops outside the viewport.
export function useBeat(active: boolean, delay = 2600) {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(
      () => setBeat((value) => value + 1),
      delay,
    );
    return () => window.clearInterval(timer);
  }, [active, delay]);
  return beat;
}
