import { useInView } from 'motion/react';
import { type ComponentType, useRef } from 'react';

export type CardProps = { playing: boolean };
export type SceneProps = { active: boolean };

export function FeatureCard({
  id,
  title,
  description,
  Scene,
  playing,
}: CardProps & {
  id: string;
  title: string;
  description: string;
  Scene: ComponentType<SceneProps>;
}) {
  const card = useRef<HTMLElement>(null);
  const visible = useInView(card, { amount: 0.2 });
  const active = playing && visible;

  return (
    <article
      ref={card}
      className={`bento-cell bento-${id}`}
      data-playing={active}
      aria-labelledby={`bento-${id}-title`}
    >
      <div className="bento-visual" aria-hidden="true">
        <Scene active={active} />
      </div>
      <div className="bento-copy">
        <h3 id={`bento-${id}-title`}>{title}</h3>
        <p>{description}</p>
      </div>
    </article>
  );
}
