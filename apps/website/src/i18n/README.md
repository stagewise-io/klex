# Website translations

English copy stays in components as `t('English source')` (React) or `html('English source')` (escaped HTML templates). Catalog keys must match that source exactly. Every row supplies all eleven non-English translations in the labeled `Translations` tuple order.

## Shared language preference

The canonical browser preference is the `klex-language` cookie. Values are `auto` or a supported locale code. On `klex.bot` and its subdomains, it uses `Domain=klex.bot; Path=/; Max-Age=31536000; SameSite=Lax; Secure` over HTTPS. Localhost and preview domains use host-only cookies; HTTP development omits Secure.

Resolution order: valid cookie → browser primary language and preference list → English. `auto` explicitly requests browser detection. Language query parameters are ignored and removed from old URLs. Selector changes save the cookie and reload a clean URL; there is no URL fallback when cookies are blocked.

When no valid cookie exists, a valid legacy `localStorage['klex-language']` value is migrated. Legacy storage is removed only after a successful cookie write. An existing cookie, including `auto`, always wins over old localStorage.

Cloud must read/write the same cookie contract to share this preference. No Cloud implementation is included here. The cookie is a validated UI preference, not authentication state, and is intentionally readable by JavaScript. Already-open tabs resolve changes on their next page load.

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
