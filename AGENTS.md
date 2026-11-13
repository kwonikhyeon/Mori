# Mori

Mori is a web app over herdr-core (`hc`). It opens terminal sessions and coding agents per folder, alerts on approvals and input waits, and handles Git worktrees, from any browser, a phone included. The Go server is in `cmd/` and `internal/`. The Preact UI is in `web/`; it is built into `internal/webui/dist` and embedded in the binary.

- The design is `docs/superpowers/specs/2026-11-08-mori-design.md` (in Korean). §3 is the table of decisions, and code comments cite one as `spec §3 #N`. A new decision, or a deliberate departure from one, adds a row there.
- `make build` builds the UI, then `bin/mori`. `make test` runs the Go tests, `make test-web` the web tests (vitest), and `make vet` runs go vet.
- Tests and manual checks run on isolated cores under `.dev/test/<id>` (see `internal/hctest`), and `make test-clean` stops what they leave behind. Never touch the user's own core or the Mori they run.

## UI design system: astryx

Mori's screens follow astryx (https://github.com/meta/astryx) at commit `1e214aaf990d2d3c6ba4fa6bf86764d48e69cfbc` (spec §3 #201–#211). The package is not installed: astryx needs React 19 and StyleX, while Mori is Preact and plain CSS. Mori takes astryx's token names and scales, and its components' sizes, states and accessibility. The colours are Mori's own. Every new screen or control follows the rules below.

### Tokens

- `web/src/styles/tokens.css` holds the tokens: astryx's names and the neutral theme's structural values, with Mori's colours. `web/scripts/tokens.mjs` writes it (`cd web && npm run tokens`). Edit the script, never the CSS: `styles.test.ts` fails while the two differ.
- Each colour is one row in the script, `[name, light, dark]`. The script writes the dark value twice: once for the OS setting (`prefers-color-scheme`) and once for the choice in Settings (`:root[data-theme="dark"]`).
- The file opens with astryx's MIT notice (`/*!`), and the build keeps it. `main.tsx` imports `tokens.css` first, so the notice heads the built sheet.
- Every value comes from a token:
  - colour;
  - type: `--text-<role>-size`, `-weight` and `-leading`;
  - corners: `--radius-*`;
  - spacing: `--spacing-*`;
  - control heights: `--size-element-sm`, `-md` and `-lg` (28, 32 and 36px);
  - shadows: `--shadow-low`, `-med` and `-high`;
  - motion: `--duration-*` and `--ease-*`;
  - the focus ring: `--focus-outline-*`.
- Raw values are allowed only for:
  - 1px hairlines;
  - layout lengths that follow the content or the viewport (width, height, inset);
  - `44px` inside the phone blocks;
  - media-query widths;
  - `color-mix()` of tokens;
  - a raw `animation-delay`;
  - the reduced-motion values described under Motion.
- Token names are astryx's, verbatim (`--color-text-secondary`, `--radius-element`, `--text-label-size`), so astryx's source reads straight across.
- A role astryx lacks gets a `--mori-*` token in `tokens.mjs`, with a comment saying why. Examples are `--mori-size-touch`, `--mori-shadow-sheet`, `--mori-font-size-key` and the hover and press overlays.
- The app's own colour sets keep their names: `--term-*`, `--diff-*`, `--count-*`, `--kind-*` and `--lane-*`.
- `web/src/styles/styles.test.ts` checks these rules. When you add a rule worth keeping, add a check for it there.

### Read astryx first

Before you build or restyle a control, read the astryx component that does the same job, at the pinned commit:

- `packages/core/src/<Name>/<Name>.tsx`: the source, with its sizes, states and StyleX values.
- `docs/specs/components/<Name>/<Name>.spec.md`: the behaviour and accessibility contract.
- `packages/core/src/<Name>/<Name>.doc.mjs`: when to use it and when not to.
- `packages/core/src/theme/tokens.stylex.ts` and `packages/themes/neutral/src/neutralTheme.ts`: the token defaults and the neutral theme's overrides. The neutral theme repaints some components; for example, it gives `destructive` buttons the error-muted fill.

Clone astryx into a scratch directory outside this repository, and only read it: install, build and run nothing there. Build the control in Preact and CSS with astryx's sizes, states and ARIA. Where Mori departs on purpose, say so in a comment and cite the spec decision.

### Mori's controls and their astryx counterparts

Reuse these classes before writing new ones. A new control maps to an astryx component in the same way.

| Mori | astryx | Notes |
|---|---|---|
| `.btn` | Button, `secondary` | `--color-neutral` fill, no border. 36, 32 and 28px (`.btn`, `.btn-sm`, `.btn-xs`); 44px on a phone. |
| `.btn-primary` | Button, `primary` | One per group. |
| `.btn-ghost` | Button, `ghost` | |
| `.btn-danger` | Button, `destructive` | As the neutral theme paints it: the error-muted fill. |
| `.btn-danger-fill` | Button, `destructive` | The core paint, the error fill: for the last step of a delete, in a confirm. |
| `.btn-icon` | IconButton | A square. Give it `{...tip(name)}` (`lib/tip.ts`): its `aria-label`, and its name in the tooltip on hover or keyboard focus. |
| `.tip` (`lib/tip.ts`) | Tooltip | The page's one tooltip, for any control with `data-tip`. Inverted, above the control. A finger never opens it. |
| `.chip`, `.chip-*` | Badge | A terminal's state; see Status and counts. |
| `.count-pill`, `.tab-badge`, `.others` | Badge (a count) | |
| `.bar` | ProgressBar | |
| `.seg`, `.seg-btn` | SegmentedControl | The segments sit in the `--color-neutral` tint; the chosen one is on the surface, in semibold. |
| `.dot` | StatusDot | Always beside words that say the same thing. |
| `.banner`, `.banner-*` | Banner | |
| `.term-ask` | Banner, warning tone | The question panel; its answers are secondary buttons. |
| `.toasts`, `.toast` | Toast | Inverted colours. |
| `.empty` | EmptyState | What is missing, and the next step. |
| `.field` | Field and TextInput | |
| `.menu`, `.menu-list` | DropdownMenu | `MenuItem.group` makes a titled run, `.menu-group` with its `.menu-heading` (DropdownMenuGroup); `.menu-sep` parts the runs (DropdownMenuDivider), and `MenuItem.sep` starts a run with no heading. |
| `.ctx-menu` (`components/ContextMenu.tsx`) | ContextMenu | The same list at the pointer. A region gives `onContextMenu={onContext(label, items)}`; `ContextMenuHost` draws the one menu. |
| `.term-slash` | DropdownMenu | The slash-command list. |
| `.hostpick` | DropdownMenu trigger | A secondary button. |
| `dialog.confirm` (`components/Confirm.tsx`) | AlertDialog | No border, the high shadow. |
| `dialog.sheet` (`components/Sheet.tsx`) | Dialog on a PC, BottomSheet on a phone | The title is heading-3. |
| `.qcard`, `.pair-card` | Card | A border or a shadow, never both. |
| `.qrows` | List and Item | Rows joined in one box. |
| `.tab` | TabList | The page shown is accent and semibold. |
| `input.st-check[role="switch"]` | Switch (md) | For a setting that applies at once. |
| `.st-check`, `.fp-hidden input` | CheckboxInput | For a choice that is applied later, on submit. |
| `.pc-aside.is-over` | Drawer | The side panel, laid over the main area below 1180px (`lib/resize.ts`). |
| `.spin` | Spinner | |
| `.kbd-group`, `.kbd` | Kbd | One key cap per key, hidden from assistive technology; the control names its keys with `aria-keyshortcuts`. Inside a rounded field, give the caps the field's radius less their inset (`.pc-find`). |

### States

- **Hover:** only inside `@media (hover: hover)`, drawn as an overlay: `background-image: var(--mori-overlay-hover-image)`.
- **Fills:** use `background-color`, never the `background` shorthand, which would wipe the hover and press overlays.
- **Press, touch:** on a touch screen, `lib/press.ts` sets `data-press` on the pressed control, and `base.css` paints `--mori-overlay-pressed-image`. It covers `button`, `[role="button"]`, `a[class]` and `label[class]` by itself; a new control of those kinds needs nothing more.
- **Press, mouse:** use `:active` only inside `@media (pointer: fine)`. A mouse-pressed `.btn` scales to .98 unless motion is reduced.
- **Focus:** use `:focus-visible` with the `--focus-outline-*` tokens (2px in the accent text colour, 3px out). Inside a box that clips, draw it inset.
- **Disabled:** `:disabled` or `aria-disabled="true"`, at opacity .5. A disabled control gets no hover and no press.
- **Inputs:** an `--color-border-emphasized` border. On focus, the accent border and an inset 2px `--color-accent-muted` ring.
- **Other states:** give each new control the error, loading and empty states it can reach.

### Speech

- Send words for a screen reader through `announce(text, politeness)` in `lib/announce.ts`. Use `polite` by default and `assertive` for errors.
  - It writes into the two live regions made at startup.
  - While a modal dialog is open, it writes inside that dialog instead, because a modal makes the page behind it inert.
- `toast()` in `lib/toast.ts` already announces its text, so don't announce a toast again.
- Don't add new `aria-live` regions. The standing status lines stay as they are: the connection banner and the terminal's status line.

### Phone and type

- The phone layout is `@media (max-width: 767px)`, and the PC layout is 768px and wider. On a phone every control is at least 44×44px (`--mori-size-touch`).
- Set type with the roles: `--text-body-*`, `-label-*`, `-supporting-*`, `-large-*`, `-code-*` and `-heading-1-*` to `-heading-6-*`.
  - On a touch screen up to 1023px wide, `(pointer: coarse) and (max-width: 1023px)`, the roles take the neutral theme's mobile scale, with a 16px body. Inputs then stay at 16px, so iOS doesn't zoom.
  - Don't set phone font sizes per rule. The only exception is the terminal's quick keys (`--mori-font-size-key`).
- Supporting text (`--color-text-secondary`) must still read as live text, not as disabled.
- Dialog and sheet titles are heading-3.

### Layout

- A card has a border or a shadow, never both, and no card sits inside another.
- Dense lists join their rows in one box (`.qrows`).
- A selected row has the `--color-accent-muted` fill and no border.
- Emphasis is semibold.
- A badge is `--spacing-5` high.
- Menus and popovers have the `--color-background-popover` fill, `--shadow-low`, no border and `--spacing-1` padding.
- A group has one primary button.
- A confirm's buttons sit side by side. At 640px and narrower they stack full width, with the action above Cancel (spec #210).

### Status and counts

- A terminal's state maps to a Badge tone:

  | State | Fill | Text |
  |---|---|---|
  | blocked (waiting for approval) | `warning` | `on-warning` |
  | error | `error` | `on-error` |
  | waiting (for input) | `background-gray` | `text-gray` |
  | working | `background-blue` | `text-blue` |
  | exited, or no state | `background-gray` | `text-secondary` |

- Every status fill has its `--color-on-*` text pair.
- Never use colour alone: a dot or a badge always has words or an icon with it.
- Contrast is at least 4.5:1 for text and 3:1 for icons, lines and focus rings, in light and in dark.
- A badge shows a status or a category.
- A count that needs a person (approvals, errors, input waits) is the accent badge, in a tab's or a segmented control's end slot (`.tab-badge`, `.count-pill`).
- Counts from other hosts (`.others`) stay gray.

### Motion

- Durations and easings come from the tokens: `--duration-fast`, `-medium` and `-slow` (each with `-min` and `-max`), `--duration-exit`, and `--ease-entrance`, `-exit`, `-move` and `-standard`.
- An exit uses `--duration-exit` with `--ease-exit`. Nothing bounces.
- Dialogs rise and grow into place. On a phone, the sheet slides up from the edge.
- Reduced motion:
  - `base.css` ends every animation and transition in .01ms; the spinner alone still turns, once in 3s.
  - In `ui.css`, dialogs fade instead of rising, as astryx's layers do: at once with a mouse, and over `--duration-fast-max` with `ease-in-out` on a touch screen.
  - A new animation needs nothing more.

### Layers

- Modals are `<dialog>` elements opened with `showModal()`, through `components/Sheet.tsx` and `components/Confirm.tsx`. Use them rather than a new overlay.
- Anything else that floats takes a place in the z-index ladder, with a comment:

  | z-index | What |
  |---|---|
  | top layer | the tooltip, as a manual popover (z-index 50 where there are no popovers) |
  | 50 | toasts |
  | 30 | menus |
  | 20 | the slash-command list |
  | 10 | the commit sheet over the Git graph on a phone |
  | 5–6 | the side panel laid over the main area |
  | 4 | the panel of a Claude Code window, laid over the terminal |
  | 2–3 | terminal internals |

- Known gap: a toast shown while a modal is open sits under the modal's backdrop. astryx puts its toast viewport in the top layer with `popover="manual"`.

### Check before you finish

- Run `cd web && npm test` and `make build`.
- Look at the change:
  - at 390×844 and at 1440×900;
  - in light and in dark;
  - in each state it has: rest, hover, press, focus-visible, disabled, error, loading and empty.
- Look at it on a Mori you start yourself on an isolated core under `.dev/test/<id>`, never on the user's running Mori.
- Read the diff once more for raw values.
- Ask the user only about the visual direction, or about a deliberate departure from astryx, and one question at a time.

### Moving to a newer astryx

Move the pinned commit only on purpose:

1. Diff `packages/core/src/theme/tokens.stylex.ts` and `packages/themes/neutral/src/neutralTheme.ts` between the two commits.
2. Update `web/scripts/tokens.mjs` (the commit in its notice, and the values), then run `npm run tokens`.
3. Reread the changed specs of the components Mori follows.
4. Update spec §3 #201.
