# Website Klex

Adapted from the cloud repository's `apps/frontend/src/components/klex.tsx`,
`klex/{presets,glide,idle,gaze,geometry,emotes,eyes}.ts(x)`, and
`packages/avatar/src/index.ts`. Latest source reviewed: `origin/jakob` at
`141a6fc` (2026-09-21), including its activity, working, laptop, and controller
implementations. The cloud source is not modified.

The website has a vanilla TypeScript/Vite boundary. This module uses SVG and one
requestAnimationFrame controller instead of importing React, GSAP, Motion, or the
avatar editor. It retains the original Klex outline, periodic cubic B-spline,
sole-anchored head rig, derived eye contrast, masked happy eyes, closed blink lids,
seeded idle timing, and contour-limited gaze. `hello()` plays the cloud's
2.2-second happy nod without stacking reactions. Default behavior remains grounded
breathing and nods in the rig. The hero family gives Harry grounded
breathing, Sarah a sideways glance and wink, Pip short typing-like nods, and Momo
a 3.8-second drift with a held nearby position before settling. Excursions use
slot-relative percentages (at most 5% horizontally and 7% vertically), inside
fixed, separated slots, on deterministic staggered clocks. Hover and focus play
individual glance, wiggle, typing and lift reactions; native button activation
plays a jump, turn, head wiggle or flight burst respectively. Rig gestures blend
from the current pose and travel starts from the current transform, so repeated
interaction interrupts without stacking. There are no speech bubbles.

The hero and capability activities mount animated instances. Pause, document visibility, intersection,
and live reduced-motion changes control its clock. Reduced motion uses a static
happy expression for hello. `dispose()` releases the frame, observer and listeners;
the page calls it on teardown and Vite disposal. Hosts must call it before removal.

The editor's version-1 model stores outline points, an eye anchor (`x` relative to
80, `y` absolute), and a six-digit body color in a 160 × 140 frame. This site ships
the original organic Klex, rounded box, circle and soft diamond contours. Each
uses its own eye anchor and measured gaze clearance. Identity colors and forms
are shared by the hero, demo and onboarding avatars. It does not accept saved or untrusted drawings,
persist avatars, or bundle the editor's geometry dependencies.

Geometry, deterministic idle and controller lifecycle checks run in Node with
DOM-facing interfaces mocked. The family has also been checked in Chromium at
desktop and mobile widths for ambient motion, pointer/keyboard activation,
stable layout and live reduced-motion changes. Reduced motion freezes the
constellation; activation can briefly change the eye expression. Family timers
and animations stop offscreen or when the page is hidden and are disposed on teardown.

## Opt-in standalone controls

Existing positional arguments and methods remain compatible. Both `mascotMarkup`
and `mountMascot` also accept a trusted, immutable `BodyShape` instead of a named
form; pass the same shape to both. Outlines must use finite points in the shared
frame, with a face anchor inside the contour. This is not a saved-drawing parser.

- `setActivity('idle' | 'sleeping' | 'working' | 'note-taking')`: sleeping closes the eyes and
  breathes slowly. Working alternates seeded reading, typing bursts, and thinking
  glances, with a shape-aware laptop. Note-taking uses the same seeded phases and
  prop lifecycle with a blank sheet and irregular pencil strokes. Travel and emotes
  suppress the activity, which resumes afterward. Pausing freezes phases and props together.
- `setExpression('neutral' | 'happy' | 'sleepy' | 'focused' | 'surprised')`:
  persistent masked eyes, retained after temporary hello/typing expressions.
- `lookAt(x, y)` / `clearGaze()`: local gaze offsets, limited to ±12 SVG units
  before contour fitting. Emotes temporarily take precedence.
- Additional emotes: `wink`, `look-left`, `look-up`, `look-down`, `nod`, and
  `headshake`. `cancelEmote()` restores the base expression and activity.
- `moveTo('left' | 'right' | number, 'crawl' | 'fly' | 'hop')`: numbers clamp to
  -50…50, mapped onto ±8 SVG units inside the existing avatar. Fly retains a
  gentle hover up to 7 units; hop uses small lifts while travelling. A new target
  preserves velocity, and omitted modes retain the last choice. The host and
  existing hero travel animations are untouched. Commands do not unpause a
  paused website mascot. `reset()` clears activity, expression, gaze, and travel.

Reduced motion uses static activity poses and immediate destinations
without lift, prop bob, pencil strokes, or a running frame. New decorations are hidden from
assistive technology; the SVG retains its existing accessible name. Callers must
provide separate accessible status text if activities convey real agent status.

Cloud's GSAP deformation engine, Motion spring, React components, server status
polling, drawing editor/storage, speech, emoji extras, and full reaction catalog
are intentionally excluded. Travel is bounded within the website avatar rather
than using Cloud's resizable track. No cloud runtime or dependency was added.
