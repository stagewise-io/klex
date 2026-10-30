# Versioned legal documents

The website publishes a static revision catalog and immutable Markdown sources. Browsers select the latest effective revision using their device clock; cloud consumers select using their own server clock. Nginx needs no Node service or scheduled rebuild to activate an already published future revision.

**No approved policy text ships with the initial setup.** Privacy and Terms arrays are empty and pages say unavailable. Do not treat an empty registry, a future-only registry, or the website build succeeding as legal-launch readiness.

## Source layout and authoring

- `content/legal/policies.json`: policy types and display labels. Privacy and Terms are already defined. Add new types at the end; existing slugs and order are stable.
- `content/legal/<policy>/YYYY-MM-DD.md`: one approved revision per file. The folder determines the policy; the filename determines both the revision ID and effective date.

There is no registration command or revision lock manifest. The normal website build discovers every Markdown file, validates it, computes SHA-256 over its exact bytes, and writes the hash into the generated catalog. Git history is the CI baseline.

Illustrative frontmatter (the body must be replaced with approved text before registration):

```markdown
---
title: Privacy Policy
requiresConsent: true
changeSummary: Approved summary of this revision
---

## Scope

Approved policy text goes here.
```

Rules:

- Put this example in `content/legal/privacy/2027-01-01.md`. The parent directory must match a policy slug in `policies.json`.
- Filenames must be real `YYYY-MM-DD` dates. That date becomes effective at **00:00 UTC**. Do not repeat `policy`, `revision`, or `effectiveDate` in frontmatter; those fields are derived from the path. Only one revision per policy/date is allowed.
- `requiresConsent` is optional and defaults to `false`. Use the unquoted boolean `true` for a revision whose changes require explicit user consent, or `false` otherwise. Quoted strings, numbers, null, and YAML-style `yes`/`no` are rejected. The catalog always exposes this field as a JSON boolean for every revision. It is metadata only; the cloud service must collect and record consent.
- `title` is required. `changeSummary` is optional. Unknown fields, nested YAML, duplicate keys, tags, and aliases are rejected. Quote dates.
- UTF-8 without BOM, LF line endings, no NUL bytes, nonempty body, at most 2 MiB per Markdown source. The Git attribute forces LF checkouts; validation rejects CRLF rather than normalizing source bytes. Do not run transformations or formatters over previously pushed Markdown.
- The page supplies the only H1 from `title`. Body headings start at H2. Heading IDs are deterministic (`section-scope`, then `section-scope-2` for a duplicate).
- Markdown is rendered without raw HTML, image embeds, or automatic links. Explicit HTTP(S), mailto, root/relative, and fragment links are allowed; executable/data/protocol-relative links are not. HTML is displayed as literal text, not executed.
- CI requires new revisions to have dates later than **all** existing revisions for that policy in the Git baseline, including future ones. Inserting a revision into the middle is not supported. Once pushed, fixes require a new revision.
- Rendered pages are bounded at 16 MiB and the catalog at 2 MiB. Builds reject oversized output and publish no incomplete catalog.

## Add and publish

1. Add approved Markdown in the appropriate policy folder using its effective date as the filename.
2. Commit and push the new file. No registration, generated hashes, or manifest updates are required.
3. CI validates the content and checks that existing revisions are unchanged.
4. Build and deploy the website normally. The build generates the catalog and publishes all dated pages and original Markdown.

For local preview or validation, use the ordinary website commands from the repository root:

```sh
pnpm --filter @klex/website dev
pnpm --filter @klex/website test
pnpm --filter @klex/website build
```

Publishing a future revision immediately makes its dated HTML and original Markdown public. The default URL automatically selects it when its date arrives. An open page checks again at its next effective-date boundary, at least daily, and on focus/visibility restoration. Publishing any new revision still requires building and deploying it.

The build intentionally permits empty/future-only policies so infrastructure can be prepared before approved content arrives. Before the legal launch, ensure both Privacy and Terms have approved revisions whose effective dates have arrived.

To add a DPA, append `{ "slug": "dpa", "label": "Data Processing Agreement" }` to the registry, add its Markdown, then build/deploy. Its pages are generated automatically; no page implementation is needed. The shared website footer links Privacy and Terms. Add a DPA link there when it should be discoverable from the website.

## Public routes

- `/legal/privacy`, `/legal/terms` (and optional trailing slash): client-selected effective revision.
- `/legal/privacy/YYYY-MM-DD`: fixed revision HTML, readable without JavaScript.
- `/legal/privacy/YYYY-MM-DD.md`: the exact original UTF-8 bytes, including frontmatter.
- `/legal/policies.json`: complete static catalog, newest-first per policy. Policy types with no revisions have empty arrays.

Dated pages never change their document selection. With JavaScript they indicate **Current**, **Previous version**, or **Upcoming** according to the clock and catalog. Current pages link their immediate predecessor; older/upcoming pages link the current policy when one exists and all earlier revisions. Without JavaScript they remain neutrally labeled dated revisions and show all published revisions with effective dates. Default pages have a dated-link fallback rather than claiming a build-time selection is current.

Each dated page has its own title and canonical URL plus `noindex,follow`. Empty default pages also have `noindex,follow`. All legal pages reuse the website's shared footer markup and styles for resource/company navigation, logos, and attribution, with its CTA section disabled. Policy links live in the footer rather than a duplicate navigation above the document. The footer is generated into HTML and remains available without JavaScript. Legal pages are isolated from website analytics. The HTML head loads the render-blocking stylesheet directly and initializes the system theme before body rendering, so initial styling does not depend on the application module loading. Layout supports mobile, keyboard navigation, theme changes, long hashes/links, and printing.

Load failures do not substitute another revision. Existing content stays readable as its labeled dated revision, but current status is explicitly unverified. Retry and dated links remain available. The browser checks catalog shape, ordering, URL identities and hash syntax, then checks article metadata and imports only safe elements/attributes from same-origin generated HTML. It does not treat a source hash as a hash of rendered HTML.

## JSON contract and cloud selection

The catalog has this shape (the revision list below is illustrative; the hash description is not an actual digest):

```json
{
  "schemaVersion": 1,
  "policies": {
    "privacy": [
      {
        "revision": "2027-01-01",
        "effectiveDate": "2027-01-01",
        "requiresConsent": true,
        "url": "https://klex.bot/legal/privacy/2027-01-01",
        "markdownUrl": "https://klex.bot/legal/privacy/2027-01-01.md",
        "sha256": "64 lowercase hexadecimal characters"
      }
    ],
    "terms": []
  }
}
```

No `current`, `ready`, generation time, or expiry fields are exposed. Revision URLs are fixed and never point to a default-selection page. Production links use `https://klex.bot`.

For each policy, choose the **first** entry where `effectiveDate <= serverTodayUTC`. An empty array or a list whose dates are all in the future has no effective policy. Reject unsupported schema versions, malformed/duplicate/unsorted dates, unexpected policy identities/URLs, and invalid hashes. Privacy/Terms missing from a consumer's expected catalog is an error, not consent to skip the requirement.

Revalidate the catalog at least before notices/acceptances that depend on it and across effective-date boundaries. Do not retain a selected revision indefinitely or use a stale cached response after a network failure as proof of currency. Validate response status/MIME and impose timeout/body limits. The source download's hash is **SHA-256 over the original decoded HTTP entity bytes**; do not trim, parse/re-serialize frontmatter, convert line endings, add/remove a BOM, or hash the rendered HTML.

Read `requiresConsent` from the selected effective revision, not from a future entry. A `true` flag signals that the consumer should obtain explicit consent to that revision; it does not mean consent has already been obtained. The flag does not alter date-based selection. Persist the policy type, exact revision, effective date, consent requirement, stable URL, and SHA-256 when recording a notice or acceptance. This catalog supplies document identities; it does not implement consent, acceptance records, notices, or a legal compliance determination.

Hashes prove consistency with this catalog, not authenticity against someone who can replace both catalog and files. TLS, reviewed publication, protected Git history, and retained acceptance identities remain essential. A wrong browser clock can select the wrong default revision; the cloud's server clock is authoritative for its decisions. There is no CORS requirement for server-to-server cloud requests.

## Nginx serving

Deploy the **entire** website build directory as an atomic release. Merge the following into your existing server configuration; the document root must already point at that release's `dist` directory:

```nginx
location = /legal {
    return 404;
}

location ^~ /legal/ {
    # No SPA/homepage fallback for missing JSON, Markdown, or dated pages.
    try_files $uri $uri/index.html =404;
    types {
        text/html html;
        application/json json;
        text/markdown md;
    }
    default_type application/octet-stream;
    etag on;
    add_header Cache-Control "no-cache" always;
    add_header X-Content-Type-Options "nosniff" always;
}
```

`no-cache` permits storage but requires revalidation. Apply equivalent settings at any CDN/proxy/service worker; do not silently turn the catalog or HTML into long-lived immutable cache entries. Fingerprinted JS/CSS assets may retain their normal immutable caching. Preserve byte-exact Markdown responses, correct MIME types, GET/HEAD behavior, HTTPS, and real 404s for unknown revisions. Compression is fine when decoding yields the original bytes.

Nginx `add_header` directives can override inherited header sets: retain the deployment's existing security headers explicitly if required. Validate the actual merged configuration with `nginx -t`; this repository does not own the production nginx configuration.

## Integrity and deployment safety

The `Legal Revision Integrity` workflow runs on **every branch push** and on pull requests. It validates candidate Markdown, then compares the actual source bytes with the trusted Git baseline: the target branch's base SHA for PRs and `github.event.before` for pushes. A new branch with an all-zero previous-push SHA is compared against the default branch instead. Full Git history is fetched; an unresolved baseline fails closed. A baseline predating the legal directory allows the first rollout.

It rejects edits to body/frontmatter/whitespace, deletions, renames, symlink replacements, registry schema downgrades, policy identity removal/reordering, and date insertion. Hashes are generated output, not an editable CI baseline. Drafts can change before their first push; after pushing, add a new dated file instead. Push checks compare history on that branch; PR checks additionally protect the target branch's policies. This is not a global archive of every revision ever pushed to every deleted branch.

Require **Legal Revision Integrity** in protected-branch rules, disallow force pushes/history rewrites, and review changes to the checker, CI workflow, registry, and Git attributes. Those repository settings are manual; editing a workflow does not enable branch protection.

There are no manual pre-release or bootstrap commands. Deploy only a reviewed commit that passed required CI, and deploy its complete build atomically. **CI does not prevent deploying an older artifact.** To roll back application code, rebuild it while retaining the latest legal sources/catalog; do not roll back published legal history. Deployment access and this restriction must be enforced in the production deployment process, which this repository does not own.

Carry forward previously published fingerprinted JS/CSS/font assets into each new release, or serve a retained content-addressed asset directory, so old HTML and open browser pages remain functional. Retain original sources and release artifacts independently for audit.

### Launch/deployment checklist

1. Supply and approve real Privacy/Terms text with effective dates that have arrived.
2. Push the Markdown and require passing CI. Review future dates and public upcoming text. Hashes appear automatically in the build's catalog.
3. Enable required CI/branch protection. Deploy only passing commits; configure atomic releases and artifact retention, and preserve legal history during application rollbacks.
4. On the actual HTTPS deployment, verify JSON and original Markdown MIME/cache headers, GET/HEAD, slash/no-slash pages, real 404s for nonexistent legal routes, and SHA-256 of downloaded source bytes.
5. Verify latest/older/upcoming states, source downloads, no-JavaScript dated reading/fallback, print, mobile, themes, and focus/keyboard behavior. Check no analytics requests occur on legal pages.
6. Confirm cloud UTC selection, revalidation/failure handling, and retained exact revision/hash when recording notices/acceptance.

## Verification

```sh
pnpm --filter @klex/website test:legal
# Also run the full website suite; unrelated pre-existing failures must be triaged separately.
pnpm --filter @klex/website test
node --test scripts/check-legal-revisions.test.mjs
pnpm --filter @klex/website typecheck
pnpm --filter @klex/website build
pnpm --filter @klex/website test:legal-browser
# Requires a running Docker daemon; starts a loopback-only disposable nginx container.
pnpm --filter @klex/website test:legal-nginx
pnpm format
pnpm format:check
git diff --check
```

The browser smoke test uses isolated synthetic policy fixtures, never production legal sources. It also holds application scripts back on development and production pages to check initial stylesheet application, system theme, mobile layout, and visible static content. Install the pinned Playwright Chromium once with `pnpm --filter @klex/website exec playwright install chromium` if unavailable. The nginx smoke test extracts the exact configuration example from this guide and exercises synthetic generated artifacts in `nginx:1.28.0-alpine`, including MIME/cache/GET/HEAD, revalidation, real 404s despite a general SPA fallback, and source hashes. Production nginx behavior and approved wording must still be checked in the deployment environment.
