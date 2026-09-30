import './styles.css';

import { useInView } from 'motion/react';
import { useRef } from 'react';

import type { CardProps, SceneProps } from '../../shared/feature-card';
import { SceneBot } from '../../shared/scene-bot';
import { useBeat } from '../../shared/use-beat';

export function ProductCard({ playing }: CardProps) {
  const card = useRef<HTMLElement>(null);
  const visible = useInView(card, { amount: 0.2 });
  const active = playing && visible;
  return (
    <article
      ref={card}
      className="bento-cell bento-product"
      data-playing={active}
      aria-label="Klex Bots, your team of digital coworkers"
    >
      <span className="bento-product-label">
        Your team of digital coworkers
      </span>
      <p className="bento-product-title">Klex Bots</p>
      <div className="bento-product-scene" aria-hidden="true">
        <ProductScene active={active} />
      </div>
    </article>
  );
}

function ProductScene({ active }: SceneProps) {
  const beat = useBeat(active, 2800);
  const bots = ['kristine', 'jonathan', 'monica', 'jeff'] as const;
  return (
    <div className="bento-family">
      <div className="bento-family-floor" />
      {bots.map((bot, index) => (
        <div key={bot} className={`bento-family-bot bento-family-bot-${index}`}>
          <SceneBot
            active={active}
            bot={bot}
            beat={Math.floor((beat + index) / 4)}
            reaction={index % 2 ? 'hello' : 'happy-nod'}
            size={58}
          />
        </div>
      ))}
      <div className="bento-family-klex">
        <SceneBot active={active} beat={beat} reaction="happy-nod" size={112} />
      </div>
    </div>
  );
}
