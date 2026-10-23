import './styles.css';

import { type CardProps, FeatureCard } from '../../shared/feature-card';

export function HostingCard({ playing }: CardProps) {
  return (
    <FeatureCard
      id="hosting"
      title="Hosted where you choose"
      description="Run Klex on your own infrastructure and keep your Klex Bot’s data with you."
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
        <defs>
          <linearGradient
            id="bento-mini-aluminum"
            x1="74"
            y1="63"
            x2="190"
            y2="182"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#f0f1f2" />
            <stop offset="0.45" stopColor="#d2d5d8" />
            <stop offset="1" stopColor="#aeb4ba" />
          </linearGradient>
          <linearGradient
            id="bento-mini-rim"
            x1="72"
            y1="126"
            x2="188"
            y2="126"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#8a9097" />
            <stop offset="0.5" stopColor="#d5d9dc" />
            <stop offset="1" stopColor="#757d86" />
          </linearGradient>
        </defs>
        <g transform="rotate(-9 130 122)">
          <g className="bento-hosting-cables" strokeLinecap="round">
            <path
              d="M105 66V43C105 15 67 26 67 -20V-240"
              stroke="#00000025"
              strokeWidth="8"
              transform="translate(2 3)"
            />
            <path
              d="M157 66V41C157 12 195 28 195 -20V-240"
              stroke="#00000025"
              strokeWidth="7"
              transform="translate(2 3)"
            />
            <path
              d="M105 66V43C105 15 67 26 67 -20V-240"
              stroke="#17191c"
              strokeWidth="5"
            />
            <path
              d="M105 66V43C105 15 67 26 67 -20V-240"
              stroke="#45494e"
              strokeWidth="1.2"
            />
            <path
              d="M157 66V41C157 12 195 28 195 -20V-240"
              stroke="#929a9f"
              strokeWidth="4.5"
            />
            <path
              d="M157 66V41C157 12 195 28 195 -20V-240"
              stroke="#c4cbcc"
              strokeWidth="1"
            />
          </g>
          <rect x="100" y="55" width="10" height="14" rx="3" fill="#202327" />
          <rect x="151" y="54" width="12" height="15" rx="2" fill="#858e94" />
          <g className="bento-hosting-mini">
            <rect
              x="72"
              y="66"
              width="116"
              height="121"
              rx="24"
              fill="url(#bento-mini-rim)"
            />
            <rect
              x="72"
              y="62"
              width="116"
              height="119"
              rx="24"
              fill="url(#bento-mini-aluminum)"
              stroke="#ffffff80"
              strokeWidth="0.8"
            />
            <rect
              x="75"
              y="65"
              width="110"
              height="113"
              rx="21"
              stroke="#ffffff26"
              strokeWidth="0.6"
            />
            <rect
              x="114"
              y="106"
              width="32"
              height="32"
              rx="10"
              fill="#00000020"
            />
            <rect
              x="114"
              y="105"
              width="32"
              height="32"
              rx="10"
              fill="#fafafa"
            />
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
        </g>
      </svg>
    </div>
  );
}
