import './klex-bot-roster.css';

import {
  animate,
  MotionConfig,
  type MotionValue,
  motion,
  useMotionValue,
  useTransform,
} from 'motion/react';
import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  KlexBotCard,
  type KlexBotSelection,
  KlexCardMascot,
} from './klex-bot-card';
import { botFixtures, jonathan } from './klex-bot-fixtures';

function OrbitSlot({
  index,
  angle,
  radius,
  children,
}: {
  index: number;
  angle: MotionValue<number>;
  radius: MotionValue<number>;
  children: ReactNode;
}) {
  const phase = () => ((angle.get() + index * 90) * Math.PI) / 180;
  const x = useTransform(() => -Math.cos(phase()) * radius.get());
  const y = useTransform(() => `${-Math.sin(phase()) * 16}rem`);
  return (
    <motion.div className="klex-bot-slot" style={{ x, y }}>
      {children}
    </motion.div>
  );
}

/** A single, non-null selection owns activation for the entire group. */
export function KlexBotRoster({
  children,
}: {
  children?: (selection: KlexBotSelection) => ReactNode;
}) {
  const host = useRef<HTMLElement>(null);
  const angle = useMotionValue(0);
  const radius = useMotionValue(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [pending, setPending] = useState<KlexBotSelection | null>(null);
  const [duration, setDuration] = useState(0.46);
  const [selection, setSelection] = useState<KlexBotSelection>({
    botId: jonathan.id,
    integrationId: jonathan.integrations[0].id,
  });
  const [preview, setPreview] = useState<KlexBotSelection | null>(null);
  const previewConnector = useCallback((next: KlexBotSelection) => {
    setPreview((current) =>
      next.integrationId
        ? next
        : current?.botId === next.botId
          ? null
          : current,
    );
  }, []);
  useLayoutEffect(() => {
    const element = host.current!;
    const measure = () => {
      const slot = element.querySelector<HTMLElement>('.klex-bot-slot')!;
      radius.set(
        Math.max(0, ((element.clientWidth - slot.offsetWidth) / 2) * 1.15),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const query = matchMedia('(max-width: 680px)');
    const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      setMobile(query.matches);
      setReducedMotion(motionQuery.matches);
    };
    update();
    query.addEventListener('change', update);
    motionQuery.addEventListener('change', update);
    return () => {
      observer.disconnect();
      query.removeEventListener('change', update);
      motionQuery.removeEventListener('change', update);
    };
  }, [radius]);

  useLayoutEffect(() => {
    if (!pending) return;
    const index = botFixtures.findIndex((bot) => bot.id === pending.botId);
    const current = angle.get();
    // Nearest equivalent angle, including when a new request interrupts a spin.
    const delta = ((((-index * 90 - current) % 360) + 540) % 360) - 180;
    const target = current + delta;
    const finish = () => {
      setPending(null);
    };
    if (reducedMotion || mobile || Math.abs(delta) < 0.01) {
      angle.set(target);
      finish();
      return;
    }
    const animation = animate(angle, target, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onComplete: finish,
    });
    return () => animation.stop();
  }, [pending, mobile, reducedMotion, angle, duration]);

  const activate = (next: KlexBotSelection) => {
    const bot = botFixtures.find((item) => item.id === next.botId);
    if (!bot) return;
    setSelection({
      ...next,
      integrationId: next.integrationId ?? bot.integrations[0].id,
    });
    if (next.botId === selection.botId) return;
    setPreview(null);
    const index = botFixtures.findIndex((bot) => bot.id === next.botId);
    const delta = ((((-index * 90 - angle.get()) % 360) + 540) % 360) - 180;
    setDuration(Math.abs(delta) > 90 ? 0.6 : 0.46);
    setPending(next);
  };
  const selectedBot = botFixtures.find((bot) => bot.id === selection.botId)!;
  return (
    <MotionConfig
      transition={{
        duration: reducedMotion || mobile ? 0 : duration,
        ease: [0.22, 1, 0.36, 1],
      }}
      reducedMotion={reducedMotion || mobile ? 'always' : 'never'}
    >
      <aside
        ref={host}
        className="klex-bot-roster"
        aria-label="Meet the Klex Bots"
        aria-busy={!!pending}
      >
        {botFixtures.map((bot, index) => (
          <OrbitSlot key={bot.id} index={index} angle={angle} radius={radius}>
            <KlexBotCard
              bot={bot}
              mascot={
                <KlexCardMascot color={bot.color} variant={bot.variant} />
              }
              selection={selection}
              onActivate={activate}
              onPreview={previewConnector}
              moving={!!pending && !mobile && !reducedMotion}
              morphDuration={reducedMotion || mobile ? 0 : duration}
            />
          </OrbitSlot>
        ))}
        <p className="klex-bot-roster-status" role="status">
          Active: {selectedBot.name}
          {selection.integrationId
            ? `, ${selectedBot.integrations.find((item) => item.id === selection.integrationId)?.name}`
            : ''}
        </p>
      </aside>
      {children?.(
        preview?.botId === selection.botId && preview.integrationId
          ? preview
          : selection,
      )}
    </MotionConfig>
  );
}
