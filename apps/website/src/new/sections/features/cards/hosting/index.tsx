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
            <path
              className="bento-hosting-pear"
              transform="translate(117 105)"
              fill="#555b63"
              d="M13 7C9 7 8 10 7 14C6 17 2 20 2 24C2 29 6 32 13 32C20 32 24 29 24 25C20 25 17 22 18 19C18.5 17.5 20 16.5 21 16C20 15 19.5 14.5 19 13C18 9 17 7 13 7ZM13 5C13 2 16 0 20 0C20 3 17 5 13 5Z"
            />
            <g transform="rotate(14 163 153)">
              <rect
                x="150"
                y="141"
                width="26"
                height="26"
                rx="8"
                fill="#00000020"
              />
              <rect
                x="150"
                y="140"
                width="26"
                height="26"
                rx="8"
                fill="#fafafa"
              />
              <image
                href="/klex-avatar.svg"
                x="152"
                y="142"
                width="22"
                height="22"
              />
            </g>
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
