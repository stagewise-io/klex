# Feature bento

Each card owns its copy, illustration, animation, and styles in one directory:

```text
features/
  cards/
    tools/          # Right where work happens
    identity/       # Their own accounts in your tools
    collaboration/  # Teamwork comes naturally
    permissions/    # Set permissions for each Klex Bot
    product/        # Center Klex Bots card
    autonomy/       # Working while you're away
    memory/         # Learns how you work
    hosting/        # Hosted where you choose
  shared/
    feature-card.tsx # Common frame, headings, and viewport visibility
    scene-bot.tsx    # Shared Klex rig wrapper and emote playback
    use-beat.ts      # Animation clock that pauses when inactive
  bento.tsx         # Card order, mounting, and page-wide motion state
  features.css      # Grid, breakpoints, common frame, and motion rules
  index.ts          # Section wrapper and mount point
```

Every card directory contains `index.tsx` and `styles.css`. To change a card,
edit those two files. Its exported card component supplies its own title,
description, and scene to the shared `FeatureCard`. The center product card
owns its custom frame. Cards do not import other cards.

Keep card-specific responsive rules and keyframes in its `styles.css`, with
selectors and animation names unique to that card. Grid placement and the
overall responsive arrangement belong in `features.css`; ordering belongs
in `bento.tsx`. Shared styles load before card styles.

Scenes receive `active`. Pause timers and animation playback when it is false,
resume when it becomes true, and clean up on unmount. The grid handles background
tabs and reduced motion; the shared frame handles viewport visibility. Render a
useful static illustration when animation never starts.

For parallel work, assign one card directory per task. Changes to `shared/`,
`bento.tsx`, or `features.css` affect multiple cards and should be coordinated.
