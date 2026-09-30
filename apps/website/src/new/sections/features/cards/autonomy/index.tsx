import './styles.css';

import {
  type CardProps,
  FeatureCard,
  type SceneProps,
} from '../../shared/feature-card';
import { SceneBot } from '../../shared/scene-bot';

export function AutonomyCard({ playing }: CardProps) {
  return (
    <FeatureCard
      id="autonomy"
      title="Working while you’re away"
      description="Klex Bots keep working on their tasks while you’re away."
      Scene={WorkingScene}
      playing={playing}
    />
  );
}

function WorkingScene({ active }: SceneProps) {
  return (
    <div className="bento-working-scene">
      <div className="bento-day-sky" />
      <div className="bento-night-stars" />
      <div className="bento-sky-horizon">
        <div className="bento-sky-orbit">
          <span className="bento-sun" />
          <svg
            className="bento-moon"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M21 14.1A9.2 9.2 0 0 1 9.9 3a9.3 9.3 0 1 0 11.1 11.1Z" />
          </svg>
        </div>
      </div>
      <div className="bento-working-bot">
        <SceneBot active={active} activity="working" size={86} />
      </div>
    </div>
  );
}
