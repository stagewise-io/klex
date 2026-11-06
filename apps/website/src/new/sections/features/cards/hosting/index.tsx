import './styles.css';

import { t } from '@/i18n';

import { type CardProps, FeatureCard } from '../../shared/feature-card';
import deskUrl from './desk.svg?url';

export function HostingCard({ playing }: CardProps) {
  return (
    <FeatureCard
      id="hosting"
      title={t('Hosted where you choose')}
      description={t(
        "Run Klex Bots in our Klex Cloud - or on your own infrastructure, keeping all your Klex Bot's data with you.",
      )}
      Scene={HostingScene}
      playing={playing}
    />
  );
}

function HostingScene() {
  return (
    <div className="bento-hosting-scene">
      <svg
        className="bento-hosting-desk"
        viewBox="0 0 260 230"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
        aria-hidden="true"
      >
        <g transform="rotate(-9 130 122)">
          <image href={deskUrl} x="0" y="-250" width="260" height="480" />
          <image
            href="/klex-avatar.svg"
            x="116.5"
            y="107.5"
            width="27"
            height="27"
          />
          <circle
            className="bento-hosting-status-glow"
            cx="164"
            cy="183"
            r="4"
            fill="#a0e3bd"
          />
          <circle
            className="bento-hosting-status"
            cx="164"
            cy="183"
            r="1.5"
            fill="#c0ffdb"
          />
        </g>
      </svg>
    </div>
  );
}
