# Website Klex

`mascotMarkup(color, form)` returns a static SVG of a resting Klex for avatars in
the landing page sections and the bot card prototype. It draws the body with the
same periodic cubic B-spline and derived eye contrast as the animated landing
page characters, using `roundedPath` and `getKlexEyeColor` from
`@klex/mascot/svg` and the original Klex outline from `@klex/mascot`. It adds the
website's ground shadow, title, and sizing class around them.

Shapes use the editor's version-1 model: outline points, an eye anchor (`x`
relative to 80, `y` absolute), and a six-digit body color in a 160 × 140 frame.
This site ships the original organic Klex, ghost, rounded box, circle and soft
diamond contours. `mascotMarkup` also accepts a trusted, immutable `BodyShape`
instead of a named form. Outlines must use finite points in the shared frame,
with a face anchor inside the contour. It does not accept saved or untrusted
drawings.
