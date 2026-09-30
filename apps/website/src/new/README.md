# Homepage structure

The website's root `index.html` serves this page at `/`. `main.ts` sets the section order and mounts each section. Page-wide styles, theme handling, and navigation stay in this directory.

Each directory under `sections/` owns its section markup, behavior, and CSS:

- `hero/`: bot introduction and interactive team
- `workflow/`: a viewport-height story with a step list on the left and vertically moving illustrations on the right. Next advances after the current scene finishes; the headings are a progress display. Replay instantly restores actors to their entry positions and starts the current scene again. Start over below the list resets all scenes and actors. Page scrolling stays free and does not skip unfinished scenes. `actors.tsx` keeps one persistent Klex per character on the moving screen stack. Scene markers in `stage.tsx` send them between screens using the Klex movement rig; Monica returns to her original Slack marker after briefing Kristine. `useStepPlayback`/`usePlay` keep completed scenes mounted until an explicit reset.
- `slack/`: conversation, typing sequence, and composer
- `linear/`: issue story and dialog; `preview.tsx` serves the development-only `/new/linear-issue/` preview
- `build/`: code animation, careers preview, and opening the pull request on GitHub
- `pull-request/`: Jeff tests the preview, reports a bug on the pull request, and Jonathan fixes it
- `report/`: Monica reports back in Slack
- `coworkers/`: a comparison table covering accounts, teamwork, and learning for personal assistants and Klex Bots, between the workflow and feature summary
- `features/`: animated feature bento summarizing the preceding sections, with a shared Klex Bot rig for its illustrations
- `guides-faq/`: centered company guides and a responsive FAQ accordion, between trust and the feature bento
- `trust/`: Stagewise's bot roles, a simplified drawing of the first office from reference photos, and the ownership, isolation, and update guarantees, with a Trust Center link. `office.ts` projects the room and furniture into a static SVG; its coordinates keep desks and future occupants in the same space.
- `footer/`: closing call to action and links

Changes to an existing section should stay in its directory. `main.ts` only needs an edit when the page gains, removes, or reorders a section. The earlier homepage remains at `/old/`, with `old/index.html` loading `src/main.ts`. The mascot implementation in `src/mascot/` and shapes in `src/shared/` are also used by that page and the development demos.

The feature bento at `/#features` places the feature cards around Klex Bots in the center and collapses to a single column on mobile. Each feature has an illustration, a title, and a description. Animations pause offscreen, in background tabs, and when reduced motion is enabled.

Each bento card owns its component, copy, animation, and CSS under `features/cards/<name>/`. See [the bento structure](./sections/features/README.md) for file ownership and parallel editing.
