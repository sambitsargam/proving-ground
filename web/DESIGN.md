# Design

Sleek, premium and quiet: a midnight-black page, electric cobalt for the brand, and acid lime only where money is safe. Think high-end security hardware, not a crypto casino. Restraint is what makes it premium: lots of black space, few accents, and every glow earned.

The style sample at `/` shows everything below. Screenshots are in [design/](design/).

## Tokens

All of them live in [src/styles/tokens.css](src/styles/tokens.css). Nothing else defines a color, glow, radius or spacing value.

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#05060A` | Page background |
| `--surface` | `#0B0D14` | Cards |
| `--surface-2` | `#11141D` | Raised elements inside cards |
| `--border` | `#1C2130` | 1px hairlines |
| `--text` | `#F2F4F8` | Body and headings |
| `--text-muted` | `#8A93A6` | Secondary text |
| `--text-faint` | `#4A5263` | Decoration only. Never for words |
| `--cobalt` | `#2F5BFF` | Primary buttons, focus rings, rails |
| `--cobalt-soft` | `#6E8BFF` | Cobalt text and links |
| `--lime` | `#C6FF1A` | Money is safe: attack stopped, payment within mandate, tests passing |
| `--threat` | `#FF3D6E` | The attacker, and what the jailbroken agent tried to do. Never decoration |
| `--amber` | `#FFB020` | Parked, waiting for the owner |
| `--glow-cobalt` | `0 0 24px rgba(47,91,255,.35)` | The active control only |
| `--glow-lime` | `0 0 24px rgba(198,255,26,.30)` | The layer that stopped an attack only |
| `--radius-card` | `14px` | Cards |
| `--radius-pill` | `999px` | Buttons, status labels, badge |
| `--space-1` … `--space-12` | 8px to 96px | Everything is on an 8px grid |

The badge SVG spells out token values as hex, because it has to render on its own in other teams' READMEs.

## Contrast

Ratios against each background, computed with the WCAG formula. Body text needs 4.5:1.

| Text token | on `--bg` | on `--surface` | on `--surface-2` | Verdict |
| --- | --- | --- | --- | --- |
| `--text` | 18.4 | 17.6 | 16.7 | Pass |
| `--text-muted` | 6.6 | 6.3 | 6.0 | Pass |
| `--cobalt-soft` | 6.6 | 6.3 | 6.0 | Pass |
| `--lime` | 17.1 | 16.4 | 15.5 | Pass |
| `--amber` | 11.1 | 10.6 | 10.1 | Pass |
| `--threat` | 5.9 | 5.7 | 5.4 | Pass |
| `--cobalt` | 3.9 | 3.8 | 3.6 | Fails for text. Fills and rings only |
| `--text-faint` | 2.6 | 2.5 | 2.3 | Fails. Decoration only |

`--text` on a `--cobalt` button is 4.7:1, which passes.

## Type

| Role | Family | Size |
| --- | --- | --- |
| Display | Space Grotesk, 600, letter-spacing -0.02em | Hero 44px on a phone to 88px on desktop |
| Body | Inter | 17px, line height 1.6 |
| Mono | JetBrains Mono | Account IDs, reason codes, transaction hashes, the attack log |

All three are OFL-licensed and self-hosted from npm packages, with `font-display: swap`. The page makes no font requests to anyone else.

## Meaning, not decoration

- **Every verdict has a word and an icon.** Color is never the only signal.
- **Lime, threat and amber keep fixed meanings.** Lime is not a brand color, and red never decorates.
- **One glow per view.** It marks the layer that made the call, or the control in focus.

## Components

| Component | Where it is used |
| --- | --- |
| Button: primary (cobalt), ghost (hairline), disabled | Calls to action |
| Card | Counters, layer explainer, decision panel |
| Status label: icon, word and color | Every verdict |
| Pipeline: each layer's verdict top to bottom | Arena decision panel, attempt pages |
| Chat message: the attacker's edged in threat | Arena |
| Attack log: mono, verdict colored | Landing page, arena |
| Table: hairline rows, mono numbers | Leaderboard |
| Badge: black pill, cobalt border, lime check | Leaderboard, READMEs |
| Vault mark: flat cube, cobalt edges, lime ring | Header, footer, closing call to action |
| Chips, search, tabs, toasts | Suite filters, code tabs, copy and share confirmations |

## Motion

- Transitions take 150 to 250ms with an ease-out curve. Entrances (words, reveals, pages) take 400 to 800ms on the same curve.
- The pipeline reveals its steps 180ms apart, and the deciding layer's glow builds once.
- **Anatomy of an attack** is the signature: attack A01 replayed as you scroll, the request breaking on the contract line. Below 960px or with reduced motion it shows every stage at once.
- Only three things move without being asked to: the hero's grid floor drifting, the attack ticker, and the live dot's slow ping. Nothing bounces or flashes.
- Motion is CSS plus small hooks in `src/lib/motion.ts` (in view, scroll progress, count up, magnetic), with no animation library.
- With `prefers-reduced-motion`, every animation and transition is off, and states change instantly. The phone screenshot was taken that way.

## Accessibility

- Semantic HTML throughout: one `h1`, a section heading for each block, a real `table` with a caption, and a `role="log"` attack log.
- Focus shows as a 2px cobalt ring with a 3px offset, on every interactive element.
- Checked at 375px wide: the page is exactly as wide as the screen, with no horizontal scroll. On a phone the attack log keeps the attack, the verdict and the reason.

## Still to come

- **The 3D vault hero**, built with react-three-fiber. It loads after first paint, with a pre-rendered poster on phones and as the fallback.
- **The screens:** landing page, arena, attempt pages and leaderboard, built from these parts.
- **Sample data:** the counters and leaderboard rows here are samples. The log and transaction come from the live testnet run.
