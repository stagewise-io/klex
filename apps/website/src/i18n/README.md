# Website translations

English copy stays in components as `t('English source')` (React) or `html('English source')` (escaped HTML templates). Catalog keys must match that source exactly. Every row supplies all eleven non-English translations in the labeled `Translations` tuple order.

## Editorial conventions

- Translate meaning in the context of the whole interaction, not isolated words. A careers page is a recruitment/jobs page, not an unspecified page or a personal career profile.
- Keep Klex, Klex Bot, Klex Bots, Klex Cloud, and third-party product names unchanged.
- Klex Bots work with tools and computers. Use computer/computers, not machine/machines, and use the equivalent computer terminology in translations.
- Retain established technical terms where native practitioners use them. German examples: Pull Request, PR, Commit, Review, Ticket, Deployment, Skills, Browser. Do not translate every English term mechanically, or insert English into languages where a natural local term is established.
- German marketing uses informal du/dein, not Sie/Ihr. Prefer natural sentences over literal idioms and invented Denglisch verbs.
- Translate complete sentences with named placeholders when word order varies. Do not assemble new messages from separately translated verbs, nouns, or prepositions.
- Keep code, branch names, commit subjects, email addresses, URLs, and channel identifiers unchanged. Translate surrounding UI, captions, accessibility labels, and illustrative notes.
- Legal policy text and trademark notices remain English.

`pnpm --filter @klex/website build` checks catalog types, nonempty values, and matching interpolation placeholders. `pnpm --filter @klex/website test:i18n-browser` checks the production site. These checks do not certify linguistic quality; native-speaker review is still needed.
