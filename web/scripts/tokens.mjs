// Writes src/styles/tokens.css (run with `npm run tokens`; the CSS is
// committed): astryx's token names and scales with Mori's colours (spec §3
// #201). Each dark colour is written twice, for the OS setting and for a
// choice in Settings, from one row here, so the two never drift.
// styles.test.ts fails while tokens.css is not what this writes.
import { realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The astryx commit the names and scales come from. Move it only on purpose:
// compare packages/core/src/theme/tokens.stylex.ts and
// packages/themes/neutral/src/neutralTheme.ts between the two commits.
const NOTICE = `/*! Mori design tokens.
 * Token names, scales and structural values are adapted from astryx
 * (https://github.com/meta/astryx, commit 1e214aaf990d2d3c6ba4fa6bf86764d48e69cfbc):
 * packages/core/src/theme/tokens.stylex.ts and
 * packages/themes/neutral/src/neutralTheme.ts. Colours are Mori's own.
 *
 * MIT License
 *
 * Copyright (c) 2026 Meta Platforms, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */`

const INTRO = `/* scripts/tokens.mjs writes this file (npm run tokens): change a token
   there, not here.

   Every value the UI uses comes from here (spec §3 #201): astryx's token
   names, its spacing, size, radius, type and motion scales and its shadow
   tiers, with Mori's warm palette. Rules elsewhere name a token, never a
   value: styles.test.ts keeps them so. A role astryx has no token for is a
   --mori-* token, and the app's own sets (--term-*, --diff-*, --count-*,
   --kind-*, --lane-*) keep their names. The dark set is written twice: once
   for the OS setting, once for an explicit choice in Settings. */`

// The scales: [name, value]. [comment, null] writes a comment, ['', null] a
// blank line. A Mori-only role is a --mori-* name with a comment on why
// astryx has none.
const STRUCTURE = [
  ['/* Spacing: 4px steps, in rem. */', null],
  ['--spacing-0', '0rem'],
  ['--spacing-0-5', '0.125rem'],
  ['--spacing-1', '0.25rem'],
  ['--spacing-1-5', '0.375rem'],
  ['--spacing-2', '0.5rem'],
  ['--spacing-3', '0.75rem'],
  ['--spacing-4', '1rem'],
  ['--spacing-5', '1.25rem'],
  ['--spacing-6', '1.5rem'],
  ['--spacing-7', '1.75rem'],
  ['--spacing-8', '2rem'],
  ['--spacing-9', '2.25rem'],
  ['--spacing-10', '2.5rem'],
  ['--spacing-11', '2.75rem'],
  ['--spacing-12', '3rem'],
  ['', null],
  ['/* Control heights. A phone keeps 44px controls (styles.test.ts). */', null],
  ['--size-element-sm', '28px'],
  ['--size-element-md', '32px'],
  ['--size-element-lg', '36px'],
  ['--mori-size-touch', '44px'],
  ['--border-width', '1px'],
  ['', null],
  ['/* The focus ring. astryx draws it in --color-accent; Mori draws it in the\n     accent text colour, which keeps its contrast on the dark set too. */', null],
  ['--focus-outline-width', '2px'],
  ['--focus-outline-style', 'solid'],
  ['--focus-outline-color', 'var(--color-text-accent)'],
  ['--focus-outline-offset', '3px'],
  ['', null],
  ["/* Hover and press lay an overlay over a control's own fill, as astryx's\n     interaction overlay does: a gradient, so it sits on any background. */", null],
  ['--mori-overlay-hover-image', 'linear-gradient(var(--color-overlay-hover), var(--color-overlay-hover))'],
  ['--mori-overlay-pressed-image', 'linear-gradient(var(--color-overlay-pressed), var(--color-overlay-pressed))'],
  ['', null],
  ["/* Radii: the neutral theme's. */", null],
  ['--radius-none', '0px'],
  ['--radius-inner', '0.375rem'],
  ['--radius-element', '0.625rem'],
  ['--radius-container', '0.75rem'],
  ['--radius-page', '1.75rem'],
  ['--radius-full', '9999px'],
  ['', null],
  ["/* Motion: the neutral theme's durations and astryx's easings. A release\n     or a way out runs over --duration-exit with --ease-exit. */", null],
  ['--duration-fast-min', '95ms'],
  ['--duration-fast', '125ms'],
  ['--duration-fast-max', '165ms'],
  ['--duration-medium-min', '225ms'],
  ['--duration-medium', '300ms'],
  ['--duration-medium-max', '400ms'],
  ['--duration-slow-min', '525ms'],
  ['--duration-slow', '700ms'],
  ['--duration-slow-max', '935ms'],
  ['--duration-exit', 'var(--duration-fast)'],
  ['--ease-standard', 'cubic-bezier(0.24, 1, 0.4, 1)'],
  ['--ease-entrance', 'cubic-bezier(0.24, 1, 0.4, 1)'],
  ['--ease-move', 'cubic-bezier(0.24, 1, 0.4, 1)'],
  ['--ease-exit', 'cubic-bezier(0.3, 0, 0.6, 0.6)'],
  ['', null],
  ["/* Type: Mori's faces on astryx's scale (base 14, ratio 1.2) and roles. A\n     rule sets a role's size, weight and leading, not a number. */", null],
  ['--font-family-body', "'Inter', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', system-ui, sans-serif"],
  ['--font-family-code', "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'D2Coding', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', monospace"],
  ['--font-size-xs', '0.625rem'],
  ['--font-size-sm', '0.75rem'],
  ['--font-size-base', '0.875rem'],
  ['--font-size-lg', '1.0625rem'],
  ['--font-size-xl', '1.25rem'],
  ['--font-size-2xl', '1.5rem'],
  ['--font-weight-normal', '400'],
  ['--font-weight-medium', '500'],
  ['--font-weight-semibold', '600'],
  ['--font-weight-bold', '700'],
  ['', null],
  ["/* The phone's quick keys keep 12px on both scales: eleven share a 320px\n     row, and the touch scale's 14px would leave a word no room in its key. */", null],
  ['--mori-font-size-key', '0.75rem'],
  ['', null],
]

// Text roles: [role, size, weight, leading on a PC, leading on a touch screen].
const ROLES = [
  ['heading-1', '2xl', 'semibold', '1.3333', '1.3846'],
  ['heading-2', 'xl', 'semibold', '1.4', '1.4545'],
  ['heading-3', 'lg', 'bold', '1.4118', '1.4737'],
  ['heading-4', 'base', 'bold', '1.4286', '1.5'],
  ['heading-5', 'sm', 'semibold', '1.6667', '1.4286'],
  ['heading-6', 'xs', 'semibold', '1.6', '1.6667'],
  ['body', 'base', 'normal', '1.4286', '1.5'],
  ['large', 'lg', 'semibold', '1.4118', '1.4737'],
  ['label', 'base', 'medium', '1.4286', '1.5'],
  ['code', 'base', 'normal', '1.4286', '1.5'],
  ['supporting', 'sm', 'normal', '1.6667', '1.4286'],
]

// The neutral theme's mobile type scale, for a touch screen narrower than a
// laptop (spec §3 #202).
const TOUCH_SIZES = [
  ['--font-size-xs', '0.75rem'],
  ['--font-size-sm', '0.875rem'],
  ['--font-size-base', '1rem'],
  ['--font-size-lg', '1.1875rem'],
  ['--font-size-xl', '1.375rem'],
  ['--font-size-2xl', '1.625rem'],
]

// Colours: [name, light, dark]. [comment, null, null] opens a section. Each
// status fill comes with the ink that reads on it (on-*), and text needs
// 4.5:1 and icons, lines and rings 3:1 against their ground, light and dark.
const COLOURS = [
  ['/* Surfaces. */', null, null],
  ['--color-background-body', '#F6F5F2', '#151412'],
  ['--color-background-surface', '#FFFFFF', '#1E1D1B'],
  ['--color-background-card', '#FFFFFF', '#1E1D1B'],
  ['--color-background-popover', '#FFFFFF', '#262522'],
  ['--color-background-muted', '#F6F5F2', '#262522'],
  ['--color-background-inverted', '#1C1B19', '#ECEAE5'],
  ['--color-background-error-inverted', '#B3123A', '#C8203F'],
  ['--color-background-gray', '#ECEAE5', '#2E2C29'],
  ['--color-background-blue', '#DCE8FF', '#1F2E52'],
  ['/* Tints laid over any fill: a secondary control, a scrim, hover, press. */', null, null],
  ['--color-neutral', 'rgba(28, 27, 25, .08)', 'rgba(236, 234, 229, .10)'],
  ['--color-overlay', 'rgba(28, 27, 25, .32)', 'rgba(0, 0, 0, .5)'],
  ['--color-overlay-hover', 'rgba(28, 27, 25, .05)', 'rgba(236, 234, 229, .05)'],
  ['--color-overlay-pressed', 'rgba(28, 27, 25, .10)', 'rgba(236, 234, 229, .10)'],
  ['/* Lines. The emphasized border edges a field, a switch and a grabber. */', null, null],
  ['--color-border', '#E4E1DA', '#34322E'],
  ['--color-border-emphasized', '#C9C4BA', '#4A4843'],
  ['--color-track', '#ECEAE5', '#2E2C29'],
  ['/* Text. Hue text sits on its own background. */', null, null],
  ['--color-text-primary', '#1C1B19', '#ECEAE5'],
  ['--color-text-secondary', '#5F5B53', '#B4AFA6'],
  ['--color-text-disabled', '#A8A49C', '#6F6A62'],
  ['--color-text-accent', '#2457D6', '#8FB0FF'],
  ['--color-text-warning', '#7A4A00', '#FFC07A'],
  ['--color-text-error', '#B3123A', '#FF8FA3'],
  ['--color-text-gray', '#3D3A35', '#D6D2CA'],
  ['--color-text-blue', '#1D4FC4', '#A9C1FF'],
  ['/* Icons and status dots. */', null, null],
  ['--color-icon-primary', '#1C1B19', '#ECEAE5'],
  ['--color-icon-secondary', '#6F6A62', '#9C978E'],
  ['--color-icon-disabled', '#A8A49C', '#6F6A62'],
  ['--color-icon-accent', '#2457D6', '#8FB0FF'],
  ['--color-icon-warning', '#B26B00', '#FFB15C'],
  ['--color-icon-error', '#B3123A', '#FF6B86'],
  ['/* Accent and status fills, each with the ink that reads on it. */', null, null],
  ['--color-accent', '#2457D6', '#3D6BE0'],
  ['--color-accent-muted', '#E8EEFB', 'rgba(127, 162, 255, .16)'],
  ['--color-on-accent', '#FFFFFF', '#FFFFFF'],
  ['--color-warning', '#FFB15C', '#FFB15C'],
  ['--color-on-warning', '#1C1B19', '#1C1B19'],
  ['--color-warning-muted', '#FFF4E6', '#3A2A14'],
  ['--color-on-warning-muted', '#5C3B0E', '#FFD9A8'],
  ['--color-error', '#B3123A', '#C8203F'],
  ['--color-on-error', '#FFFFFF', '#FFFFFF'],
  ['--color-error-muted', '#FBEAEE', '#3A1620'],
  ['--color-on-error-muted', '#7A0C27', '#FFB3C1'],
  ['--color-info-muted', '#F3F6FD', '#20283A'],
  ['--color-on-info-muted', '#3D3A35', '#D6D2CA'],
  ["/* Elevation: astryx's three tiers; the dark set adds its rim of light. */", null, null],
  ['--shadow-low', '0 2px 4px rgba(28, 27, 25, .05), 0 4px 8px rgba(28, 27, 25, .10)', '0 2px 4px rgba(0, 0, 0, .25), 0 4px 8px rgba(0, 0, 0, .40), inset 0 0 0 1px rgba(255, 255, 255, .08)'],
  ['--shadow-med', '0 2px 4px rgba(28, 27, 25, .05), 0 4px 12px rgba(28, 27, 25, .10)', '0 2px 4px rgba(0, 0, 0, .35), 0 4px 12px rgba(0, 0, 0, .50), inset 0 0 0 1px rgba(255, 255, 255, .12)'],
  ['--shadow-high', '0 4px 6px rgba(28, 27, 25, .10), 0 12px 24px rgba(28, 27, 25, .15)', '0 4px 6px rgba(0, 0, 0, .50), 0 12px 24px rgba(0, 0, 0, .70), inset 0 0 0 1px rgba(255, 255, 255, .15)'],
  ["/* Mori's own roles. Text on the inverted fill: astryx turns the toast's\n     colour scheme around, Mori sets its tokens per scheme. A sheet rises\n     from the bottom, so its high shadow falls upwards. */", null, null],
  ['--mori-on-inverted', '#FFFFFF', '#1C1B19'],
  ['--mori-shadow-sheet', '0 -4px 6px rgba(28, 27, 25, .10), 0 -12px 24px rgba(28, 27, 25, .15)', '0 -4px 6px rgba(0, 0, 0, .50), 0 -12px 24px rgba(0, 0, 0, .70), inset 0 0 0 1px rgba(255, 255, 255, .15)'],
  ['/* A QR code is read off white paper, whatever the theme. */', null, null],
  ['--mori-qr-paper', '#FFFFFF', '#FFFFFF'],
  ['/* The terminal, which xterm.js paints itself (lib/xterm.ts). */', null, null],
  ['--term-bg', '#1F1E1C', '#121110'],
  ['--term-fg', '#ECEAE5', '#ECEAE5'],
  ['--term-dim', '#A8A49C', '#A8A49C'],
  ['--term-scrollbar', 'rgba(255, 255, 255, .25)', 'rgba(255, 255, 255, .25)'],
  ['/* Diffs and change counts. */', null, null],
  ['--diff-bg', '#FAF9F7', '#191816'],
  ['--diff-del-bg', '#FBE7EB', '#3A1620'],
  ['--diff-del', '#8A1230', '#FFB3C1'],
  ['--diff-add-bg', '#E6EEFF', '#1A2A4D'],
  ['--diff-add', '#1D3F8F', '#B9CCFF'],
  ['--diff-hunk', '#6F6A62', '#9C978E'],
  ['--diff-ctx', '#5F5B53', '#B4AFA6'],
  ['--count-add', '#1D4FC4', '#8FB0FF'],
  ['--count-del', '#B3123A', '#FF8FA3'],
  ["/* A changed file's letter, by kind. */", null, null],
  ['--kind-m', '#2457D6', '#8FB0FF'],
  ['--kind-u', '#5F5B53', '#B4AFA6'],
  ['--kind-r', '#8A3FC4', '#C99BF0'],
  ['--kind-a', '#0F7B6C', '#4FC2B0'],
  ['--kind-d', '#B3123A', '#FF8FA3'],
  ["/* The commit graph's lanes. */", null, null],
  ['--lane-0', '#2457D6', '#6F95F5'],
  ['--lane-1', '#8A3FC4', '#B583E8'],
  ['--lane-2', '#0F7B6C', '#3DB8A5'],
  ['--lane-3', '#5F5B53', '#A8A49C'],
  ['--lane-4', '#5E7A12', '#9BBF3A'],
]

/** A comment at an indent, its later lines lined up under its first. */
const comment = (indent, text) => indent + text.replace(/\n\s*/g, `\n${indent}   `)

function decls(rows, indent) {
  return rows.map(([name, value]) => (value === null ? (name ? comment(indent, name) : '') : `${indent}${name}: ${value};`))
}

/** Each role's size, weight and leading; on a touch screen, its leading alone. */
function roles(indent, touch) {
  return ROLES.flatMap(([role, size, weight, lead, touchLead]) =>
    touch
      ? [`${indent}--text-${role}-leading: ${touchLead};`]
      : [
          `${indent}--text-${role}-size: var(--font-size-${size});`,
          `${indent}--text-${role}-weight: var(--font-weight-${weight});`,
          `${indent}--text-${role}-leading: ${lead};`,
        ],
  )
}

/** The light or the dark colours, a blank line before each section but the first. */
function colours(indent, dark) {
  const out = []
  for (const [name, light, darkValue] of COLOURS) {
    if (light === null) {
      if (out.length) out.push('')
      out.push(comment(indent, name))
    } else out.push(`${indent}${name}: ${dark ? darkValue : light};`)
  }
  return out
}

/** The text of tokens.css. */
export function render() {
  return [
    NOTICE,
    '',
    INTRO,
    '',
    ':root {',
    ...decls(STRUCTURE, '  '),
    ...roles('  ', false),
    '}',
    '',
    "/* On a touch screen narrower than a laptop, the neutral theme's mobile type:",
    '   base 16 at ratio 1.1736 (spec §3 #202). Body text is 16px, so a field',
    '   never makes iOS zoom in, and nothing needs a phone size of its own. */',
    '@media (pointer: coarse) and (max-width: 1023px) {',
    '  :root {',
    ...TOUCH_SIZES.map(([name, value]) => `    ${name}: ${value};`),
    ...roles('    ', true),
    '  }',
    '}',
    '',
    ':root {',
    '  color-scheme: light;',
    '',
    ...colours('  ', false),
    '}',
    '',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]) {',
    '    color-scheme: dark;',
    '',
    ...colours('    ', true),
    '  }',
    '}',
    '',
    ':root[data-theme="dark"] {',
    '  color-scheme: dark;',
    '',
    ...colours('  ', true),
    '}',
    '',
  ].join('\n')
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL('../src/styles/tokens.css', import.meta.url), render())
}
