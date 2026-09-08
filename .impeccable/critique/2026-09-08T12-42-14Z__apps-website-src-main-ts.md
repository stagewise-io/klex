---
target: Klex landing page
total_score: 19
max_score: 36
na_heuristics: 7
p0_count: 0
p1_count: 3
target_identity: "file:/Users/glenntows/.stagewise/worktrees/f355ebfd8a93/tripled-profile/apps/website/src/main.ts"
target_fingerprint: "sha256:5d469c271e23992f0b7d0c9a3c4cc3399608ce969a008f2c3b0c7f735f4449d7"
target_path: /Users/glenntows/.stagewise/worktrees/f355ebfd8a93/tripled-profile/apps/website/src/main.ts
timestamp: 2026-09-08T12-42-14Z
slug: apps-website-src-main-ts
---
# Klex Website Critique

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 3 | Copy confirmation exists, but clipboard failure has no honest error state. |
| 2 | Match System / Real World | 2 | The page assumes users understand MCP and shell syntax without context. |
| 3 | User Control and Freedom | 3 | Platform selection is reversible and navigation is straightforward. |
| 4 | Consistency and Standards | 2 | The installer controls feel assembled from mismatched segmented-control and command-field patterns. |
| 5 | Error Prevention | 2 | OS detection is useful, but a wrong detection is unexplained and copy failure can still appear successful. |
| 6 | Recognition Rather Than Recall | 2 | The icon-only copy action and truncated mobile command reduce immediate clarity. |
| 7 | Flexibility and Efficiency | n/a | This is a single-action marketing surface rather than a recurring operational workflow. |
| 8 | Aesthetic and Minimalist Design | 2 | It is sparse, but not resolved; weak composition is being mistaken for minimalism. |
| 9 | Error Recovery | 1 | There is no visible failure or recovery path for clipboard or installation problems. |
| 10 | Help and Documentation | 2 | Documentation is linked globally, but the install action has no contextual support. |
| **Total** | | **19/36** | **Acceptable, but a substantial redesign is required** |

## Design Specificity Verdict

The logo and Fraunces headline provide some Klex character, but the page is otherwise category-interchangeable. Nothing visual communicates durable identity, multiple channels, local operation, or the helpful-robot north star. The install control looks added after the hero was composed rather than designed as the hero’s primary action.

The CLI detector returned 0 findings for `apps/website/src/main.ts`. The injected browser detector also reported no anti-patterns. Mechanical checks do not capture the composition, persuasion, responsive ergonomics, and product-specificity failures visible here.

## Overall Impression

The page is clean but unresolved. It has one oversized claim, one generic sentence, and a cramped installation widget floating in a large empty canvas. The biggest opportunity is to make installation the deliberate focal action while giving the page one unmistakably Klex-specific visual or proof element.

## What’s Working

- The core action is immediate and requires no scroll.
- Platform detection reduces friction while remaining manually switchable.
- Theme behavior and typography remain coherent.

## Priority Issues

### [P1] The mobile installer is mechanically cramped

Use a single compact platform trigger beside or inside the command field, or a full-width selector below it on mobile. Preserve 44px touch targets and let the command occupy most of the row. Suggested command: `$impeccable adapt`.

### [P1] The hero has no product-specific evidence

Add one compact proof mechanism rather than more prose: a visual conversation/workflow showing one Klex identity acting across familiar channels, or a concise message-to-work-to-result sequence. Suggested command: `$impeccable bolder`.

### [P1] The composition lacks a strong action hierarchy

Reduce the headline footprint, unify platform and command controls into one intentional installation module, and connect the value statement to the action through spacing. Suggested command: `$impeccable layout`.

### [P2] Failure states are dishonest or absent

Verify copy success, expose a brief inline failure message, keep the command selectable, and avoid claiming success when the fallback returns false. Suggested command: `$impeccable harden`.

### [P2] The footer has disproportionate visual weight

Keep the required attribution, but reduce it to one quiet inline footer phrase and rebalance it against product/legal/social information. Suggested command: `$impeccable quieter`.

## Cognitive Load

Two checklist failures produce moderate cognitive load. Grouping fails because the platform selector and command field read as separate competing controls. Visual hierarchy fails because the largest element is the claim while the useful install action is visually secondary.

## Persona Red Flags

- **Jordan:** MCP is unexplained, the claim lacks concrete work examples, the copy icon has no visible label, and installation guidance stops at a command.
- **Riley:** Clipboard failure can report success, OS detection has no explicit explanation, and failed installation has no recovery route.
- **Casey:** Mobile platform targets are too short, the command is truncated, and the compressed row requires precise interaction.

## Minor Observations

- Header links are undersized and faint on mobile.
- The headline still overpowers the useful content.
- Desktop installer width feels arbitrary rather than aligned to the copy measure.
- The footer credit adds editorial styling without product value.
- Dark mode makes the muted installer feel even less actionable.

## Questions to Consider

- Should the first viewport sell installation speed or demonstrate what Klex does?
- What single artifact could prove “digital coworker” without another paragraph?
- Is Stagewise attribution intended as a quiet credit or visible co-brand?
