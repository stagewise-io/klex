export type MovementMode = 'crawl' | 'fly' | 'hop';

// A deliberately small SVG-local track: never move the host or its layout.
export function createGlide() {
  let position = 0;
  let target = 0;
  let velocity = 0;
  let height = 0;
  let phase = 0;
  let mode: MovementMode = 'crawl';
  return {
    moveTo(next: 'left' | 'right' | number, nextMode = mode) {
      const value = next === 'left' ? -50 : next === 'right' ? 50 : next;
      if (!Number.isFinite(value)) return;
      target = (Math.max(-50, Math.min(50, value)) / 50) * 8;
      mode = nextMode;
    },
    advance(elapsed: number, reduced = false) {
      if (reduced) {
        position = target;
        velocity = 0;
        height = 0;
        return;
      }
      const steps = Math.max(1, Math.ceil(elapsed * 120));
      const dt = Math.min(0.05, Math.max(0, elapsed)) / steps;
      for (let i = 0; i < steps; i++) {
        const desired = Math.max(-16, Math.min(16, (target - position) * 5));
        velocity += (desired - velocity) * (1 - Math.exp(-12 * dt));
        position = Math.max(-8, Math.min(8, position + velocity * dt));
        if (Math.abs(target - position) < 0.01 && Math.abs(velocity) < 0.05) {
          position = target;
          velocity = 0;
        }
        phase += dt * 5;
        const lift =
          mode === 'fly'
            ? 6 + Math.sin(phase)
            : mode === 'hop'
              ? Math.abs(Math.sin(phase)) * Math.min(6, Math.abs(velocity))
              : 0;
        height += (lift - height) * (1 - Math.exp(-10 * dt));
      }
    },
    reset() {
      position = target = velocity = height = phase = 0;
      mode = 'crawl';
    },
    get moving() {
      return position !== target || Math.abs(velocity) > 0.05;
    },
    get transform() {
      return `translate(${position} ${-height})`;
    },
  };
}
