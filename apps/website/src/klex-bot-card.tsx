import './klex-bot-card.css';

import { motion } from 'motion/react';
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { mascotMarkup } from './mascot';
import type { MascotForm } from './mascot/presets';

export interface KlexBotIntegration {
  id: string;
  name: string;
  logoSrc?: string;
  identity: string;
  useCase: string;
}

export interface KlexBot {
  id: string;
  name: string;
  role: string;
  company: string;
  identity: string;
  /** Order is preserved, including when the necklace wraps. IDs must be unique. */
  integrations: readonly KlexBotIntegration[];
  gesture?: 'bob' | 'wobble' | 'blink' | 'tilt';
}

export interface KlexBotSelection {
  botId: string;
  integrationId: string | null;
}

export interface KlexBotCardProps {
  bot: KlexBot;
  mascot: ReactNode;
  selection: KlexBotSelection | null;
  onActivate: (selection: KlexBotSelection) => void;
  onPreview?: (selection: KlexBotSelection) => void;
  moving?: boolean;
  morphDuration?: number;
}

/** Static repository mascot; card motion is finite and reduced-motion aware. */
export function KlexCardMascot({
  color = '#2559fe',
  variant = 'classic',
}: {
  color?: string;
  variant?: MascotForm;
}) {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    // Only the repository SVG generator writes markup; identity text stays in React.
    if (host.current) host.current.innerHTML = mascotMarkup(color, variant);
  }, [color, variant]);
  return <span ref={host} className="klex-card-mascot" aria-hidden="true" />;
}

/** Controlled selection is independent of local pointer/keyboard preview. */
export function KlexBotCard({
  bot,
  mascot,
  selection,
  onActivate,
  onPreview,
  moving = false,
  morphDuration = 0,
}: KlexBotCardProps) {
  const uid = useId();
  const roleRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const role = roleRef.current!;
    const card = role.closest<HTMLElement>('.klex-bot-card')!;
    const measure = () => {
      card.style.setProperty('--role-height', `${role.offsetHeight}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(role);
    return () => observer.disconnect();
  }, []);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const active = selection?.botId === bot.id;
  const interactive = active && !moving;
  const previewId = interactive ? (hovered ?? focused) : null;
  useEffect(() => {
    onPreview?.({ botId: bot.id, integrationId: previewId });
  }, [bot.id, previewId, onPreview]);
  useEffect(() => {
    if (!interactive) {
      setHovered(null);
      setFocused(null);
    }
  }, [interactive]);
  const detail =
    bot.integrations.find((item) => item.id === previewId) ??
    bot.integrations.find(
      (item) => active && item.id === selection.integrationId,
    );

  return (
    // A single scalar morphs local geometry without layout projection transforms.
    // The fixed outer box stays anchored to its orbit slot throughout selection.
    <motion.article
      initial={false}
      animate={{ '--expansion': active ? 1 : 0 }}
      transition={{ duration: morphDuration, ease: [0.22, 1, 0.36, 1] }}
      className="klex-bot-card"
      data-active={active}
      data-expanded={active}
      data-gesture={bot.gesture ?? 'bob'}
      aria-label={`${bot.name}, ${bot.role}`}
    >
      <button
        type="button"
        className="klex-card-select"
        aria-pressed={active}
        aria-label={`Activate ${bot.name}, ${bot.role} at ${bot.company}`}
        onClick={() =>
          onActivate({
            botId: bot.id,
            integrationId: active ? selection.integrationId : null,
          })
        }
      >
        <span className="klex-card-name">{bot.name}</span>
        <span ref={roleRef} className="klex-card-role">
          {bot.role} <span>@ {bot.company}</span>
        </span>
        <span className="klex-card-avatar">{mascot}</span>
      </button>
      <ol
        className="klex-card-necklace"
        aria-label={`${bot.name} integrations`}
      >
        {bot.integrations.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              className="klex-card-connector"
              disabled={!interactive}
              aria-label={`${bot.name} in ${item.name}: preview and select demo scenario`}
              aria-pressed={active && selection.integrationId === item.id}
              data-preview={previewId === item.id}
              onPointerEnter={
                interactive
                  ? (event) => {
                      if (event.pointerType !== 'touch') setHovered(item.id);
                    }
                  : undefined
              }
              onPointerLeave={interactive ? () => setHovered(null) : undefined}
              onFocus={interactive ? () => setFocused(item.id) : undefined}
              onBlur={interactive ? () => setFocused(null) : undefined}
              onClick={
                interactive
                  ? () => onActivate({ botId: bot.id, integrationId: item.id })
                  : undefined
              }
              aria-describedby={
                active ? `${uid}-integration-${index}` : undefined
              }
            >
              {item.logoSrc ? (
                <img
                  src={item.logoSrc}
                  alt=""
                  width="32"
                  height="32"
                  draggable={false}
                />
              ) : (
                <span className="klex-card-connector-label">{item.name}</span>
              )}
            </button>
            {active && (
              <span id={`${uid}-integration-${index}`} hidden>
                Activate {bot.name} with {item.name}
              </span>
            )}
          </li>
        ))}
      </ol>
      {active && (
        <motion.div
          className="klex-card-detail"
          initial={moving && morphDuration ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: morphDuration * 0.65,
            delay: morphDuration * 0.35,
          }}
        >
          <p className="klex-card-identity">
            {detail?.identity ?? bot.identity}
          </p>
        </motion.div>
      )}
    </motion.article>
  );
}
