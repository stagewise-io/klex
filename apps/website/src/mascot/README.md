# Website Klex

Adapted from the cloud repository's `apps/frontend/src/components/klex.tsx`,
`klex/{presets,glide,idle,gaze,geometry,emotes,eyes}.ts(x)`, and
`packages/avatar/src/index.ts`. The cloud source is not modified.

The website has a vanilla TypeScript/Vite boundary. This module uses SVG and one
requestAnimationFrame controller instead of importing React, GSAP, Motion, or the
avatar editor. It retains the original Klex outline, periodic cubic B-spline,
sole-anchored head rig, derived eye contrast, masked happy eyes, closed blink lids,
randomized idle timing, and contour-limited gaze. `hello()` plays the cloud's
2.2-second happy nod without stacking reactions. Movement is deliberately limited
to grounded breathing and nods; there is no travel track or decorative extras.

Only the hero mounts an animated instance. Pause, document visibility, intersection,
and live reduced-motion changes control its clock. Reduced motion uses a static
happy expression for hello. `dispose()` releases the frame, observer and listeners;
the page calls it on teardown and Vite disposal. Hosts must call it before removal.

The editor's version-1 model stores outline points, an eye anchor (`x` relative to
80, `y` absolute), and a six-digit body color in a 160 × 140 frame. This site ships
only the Klex preset and Peach color; it does not accept saved or untrusted drawings,
persist avatars, or bundle the editor's geometry dependencies.

No browser or screenshot validation is used for this integration. Geometry and
controller lifecycle checks run in Node with DOM-facing interfaces mocked.
