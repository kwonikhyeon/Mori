import { describe, expect, it } from 'vitest'
import { render } from '../../scripts/tokens.mjs'

const sheets = import.meta.glob<string>('../**/*.css', { query: '?raw', import: 'default', eager: true })
const tokens = sheets['./tokens.css']

/** A sheet without its comments, each blanked to spaces so the places hold. */
function strip(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
}

/** Each rule as its selector, its declarations and where it starts. */
function rules(css: string): [string, string, number][] {
  return [...strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim().replace(/\s+/g, ' '), m[2], m.index + m[1].length - m[1].trimStart().length])
}

/** Where the blocks of the at-rules a pattern finds run, inside their braces. */
function blocks(css: string, at: RegExp): [number, number][] {
  const src = strip(css)
  return [...src.matchAll(at)].map((m) => {
    const start = m.index + m[0].length
    let end = start
    for (let depth = 1; depth > 0; end++) depth += src[end] === '{' ? 1 : src[end] === '}' ? -1 : 0
    return [start, end - 1]
  })
}

/** The rules in a sheet's phone blocks, by each selector of a list. */
function phoneRules(css: string): Map<string, string> {
  const src = strip(css)
  const out = new Map<string, string>()
  for (const [start, end] of blocks(css, /@media \(max-width: 767px\) \{/g)) {
    for (const [sel, body] of rules(src.slice(start, end))) {
      for (const one of sel.split(',')) out.set(one.trim(), (out.get(one.trim()) ?? '') + body)
    }
  }
  return out
}

type Declaration = { file: string; sel: string; prop: string; value: string; at: number }

/** Each declaration of the sheets but tokens.css whose property a pattern finds. */
function declarations(props: RegExp): Declaration[] {
  return Object.entries(sheets)
    .filter(([file]) => file !== './tokens.css')
    .flatMap(([file, css]) =>
      rules(css).flatMap(([sel, body, at]) =>
        [...body.matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)].filter((d) => props.test(d[1])).map((d) => ({ file, sel, prop: d[1], value: d[2].trim(), at })),
      ),
    )
}

/** A value without its var() and env() calls, so a token's name is not read as a value. */
const bare = (value: string) => value.replace(/(var|env)\((?:[^()]|\([^()]*\))*\)/g, '')

/** Whether a declaration sits inside one of its sheet's at-rules a pattern finds. */
const inside = (d: Declaration, at: RegExp) => blocks(sheets[d.file], at).some(([a, b]) => a <= d.at && d.at < b)

const show = (d: Declaration) => `${d.file} ${d.sel} { ${d.prop}: ${d.value} }`

describe('the stylesheets', () => {
  // Tests leave stylesheets empty, unless asked for as text (css in vite.config.ts).
  it('are all read, as they are', () => {
    expect(Object.keys(sheets).length).toBeGreaterThan(10)
    expect(sheets['./base.css']).toContain('.sr-only {')
    expect(rules(sheets['../views/settings.css']).map(([sel]) => sel)).toContain('.st-scroll')
    expect(tokens).toContain('--color-accent:')
  })

  // A text only read out is placed against the nearest positioned box (see .sr-only in base.css).
  it('position every box that scrolls, so a text read out stays inside it', () => {
    const loose = Object.entries(sheets).flatMap(([file, css]) =>
      rules(css)
        .filter(([, body]) => /overflow(-[xy])?:\s*(auto|scroll)/.test(body) && !/position:/.test(body))
        .map(([sel]) => `${file} ${sel}`),
    )
    expect(loose).toEqual([])
  })

  // A text read out stands where it would, below the app for the page's own
  // regions: its 1 px box takes its pixel back, or the page grows a pixel past
  // the view and scrolls, and WebKit draws a scroll bar beside the app.
  it('keep a text read out from growing the page by its pixel', () => {
    expect(rules(sheets['./base.css']).find(([sel]) => sel === '.sr-only')?.[1]).toMatch(/margin: -1px;/)
  })

  // A finger needs 44 px on a phone (the plan's touch targets).
  it('give the small buttons, the segments and the toast close 44 px on a phone', () => {
    const phone = phoneRules(sheets['./ui.css'])
    for (const sel of ['.btn', '.btn-sm', '.btn-xs', '.seg-btn', '.toast-close']) expect(phone.get(sel), sel).toMatch(/height: 44px/)
    for (const sel of ['.btn-icon', '.btn-icon.btn-sm', '.toast-close']) expect(phone.get(sel), sel).toMatch(/width: 44px/)
  })

  // A row of a Claude Code window's list is pressed with a thumb (pickers design §6.5);
  // its keys are .btn-sm, above.
  it('make a picker row a touch target on a phone', () => {
    expect(phoneRules(sheets['../views/terminal.css']).get('.term-pick-row')).toMatch(/min-height: 44px/)
  })

  // Claude Code's status band lies over the terminal's rows it stands for,
  // at the picker panel's layer (claude-input design §3.3, spec §3 #223).
  it('lay the status band over the terminal', () => {
    const css = new Map(rules(sheets['../views/terminal.css']).map(([sel, body]) => [sel, body]))
    expect(css.get('.term-cover')).toMatch(/position: absolute;/)
    expect(css.get('.term-cover')).toMatch(/z-index: 4;/)
    // what the band covers beyond its sheet reads as the terminal's own blank rows
    expect(css.get('.term-cover')).toMatch(/background-color: var\(--term-bg\);/)
    expect(css.get('.term-cover')).toMatch(/justify-content: flex-end;/)
    // the rows the cover takes reach below the stage, which does not scroll to them (spec §3 #228)
    expect(css.get('.term-scroll.is-tall')).toMatch(/overflow-y: hidden;/)
    // the sheet, as tall as what it shows, at the foot of the band
    expect(css.get('.term-cover-sheet')).toMatch(/background-color: var\(--color-background-surface\);/)
    // a row of chips scrolls sideways rather than wrap into the rows below
    expect(css.get('.term-cover-row')).toMatch(/overflow-x: auto;/)
    expect(css.get('.term-cover-row')).toMatch(/white-space: nowrap;/)
    // on a phone the sheet takes the dock's rounded top, and the dock gives it up
    expect(css.get('.term-phone .term-cover-sheet')).toMatch(/border-radius: var\(--radius-container\) var\(--radius-container\) 0 0;/)
    expect(css.get('.term-phone .term-cover-sheet')).toMatch(/border-top: 0;/)
    expect(css.get('.term-dock.is-joined')).toMatch(/border-radius: 0;/)
    // a hairline, inset, parts the status from the keys below it
    expect(css.get('.term-dock.is-joined::before')).toMatch(/height: 1px;/)
    expect(css.get('.term-dock.is-joined::before')).toMatch(/background-color: var\(--color-border\);/)
    // the phone's mode button is a finger's height
    expect(phoneRules(sheets['../views/terminal.css']).get('.term-cover-mode')).toMatch(/min-height: 44px/)
  })

  // The send box starts at the height of its button and grows with its text,
  // the button staying at its foot (spec §3 #222).
  it('start the send box at the height of its button', () => {
    const css = new Map(rules(sheets['../views/terminal.css']).map(([sel, body]) => [sel, body]))
    expect(css.get('textarea.term-send-input')).toMatch(/min-height: var\(--size-element-lg\);/)
    expect(css.get('textarea.term-send-input')).toMatch(/padding: var\(--spacing-1-5\) var\(--spacing-3\);/)
    expect(css.get('.term-phone textarea.term-send-input')).toMatch(/min-height: var\(--mori-size-touch\);/)
    expect(css.get('.term-phone textarea.term-send-input')).toMatch(/padding: var\(--spacing-2\) var\(--spacing-3\);/)
    expect(css.get('.term-phone .term-send-btn')).toMatch(/height: var\(--mori-size-touch\);/)
    expect(css.get('.term-send')).toMatch(/align-items: flex-end;/)
    // a hint as long as the box wide stays one line, as the box sizes to it too
    expect(css.get('textarea.term-send-input::placeholder')).toMatch(/white-space: nowrap;/)
  })

  // A Claude Code window's panel lies over the terminal: one that took the
  // terminal's rows would have Claude Code draw its list cut short (pickers
  // design §14 #44). Its place in the z-index ladder is 4.
  it('lay the picker panel over the terminal, which keeps its size', () => {
    const css = new Map(rules(sheets['../views/terminal.css']).map(([sel, body]) => [sel, body]))
    expect(css.get('.term-pick')).toMatch(/position: absolute;/)
    expect(css.get('.term-pick')).toMatch(/z-index: 4;/)
    expect(css.get('.term-pick')).toMatch(/background-color: var\(--color-background-surface\);/)
    for (const [sel, body] of css) if (/\.term-pick$/.test(sel) && sel !== '.term-pick') expect(body, sel).not.toMatch(/position: (?:static|relative)|background-color: transparent/)
  })

  // A row's label and the line below it wrap, where a list's row elsewhere
  // ends in "…": a permission's scope must read whole on a phone (pickers design §14 #41).
  it("let a picker row's label wrap, so a permission's scope shows whole", () => {
    const css = new Map<string, string>()
    for (const [sel, body] of rules(sheets['../views/terminal.css']))
      for (const one of sel.split(',')) css.set(one.trim(), (css.get(one.trim()) ?? '') + body)
    for (const sel of ['.term-pick-row .qrow-title', '.term-pick-row .qrow-sub']) {
      expect(css.get(sel), sel).toMatch(/white-space: normal;/)
      expect(css.get(sel), sel).toMatch(/overflow-wrap: anywhere;/)
    }
  })

  // With a window's list in a phone's approval bar, Esc is the one key left of
  // four: it shares the row of 거절하고 지시, at a finger's height.
  it("give Esc the row of 거절하고 지시 when a phone's approval bar holds a list", () => {
    const css = new Map(rules(sheets['../views/terminal.css']).map(([sel, body]) => [sel, body]))
    expect(css.get('.term-ask-grid.is-pick .term-ask-reject')).toMatch(/grid-column: 2 \/ -1;/)
    expect(css.get('.term-ask-grid.is-pick .term-ask-key')).toMatch(/height: var\(--mori-size-touch\);/)
  })

  // A column that wraps is as wide as its widest part (a row's title that does
  // not wrap, say), and its stretched parts run past its edge: a rule that turns
  // a wrapping row into a column says flex-wrap itself (the phone's approval bar).
  it('keep a row they turn into a column from wrapping, so its parts stay inside it', () => {
    const all = Object.entries(sheets).flatMap(([file, css]) => rules(css).map(([sel, body]) => ({ file, sel, body })))
    const wraps = all.filter((r) => /flex-wrap:\s*wrap/.test(r.body)).flatMap((r) => r.sel.split(',').map((s) => ({ s: s.trim(), r })))
    const loose = all.flatMap((r) =>
      /flex-direction:\s*column/.test(r.body) && !/flex-wrap:/.test(r.body)
        ? r.sel
            .split(',')
            .map((s) => s.trim())
            .filter((s) => wraps.some((w) => w.r !== r && (s === w.s || s.endsWith(' ' + w.s))))
            .map((s) => `${r.file} ${s}`)
        : [],
    )
    expect(loose).toEqual([])
  })
})

// Installed with window controls overlay, the PC header is the window's title
// bar (spec §3 #232): it drags the window, what is pressed in it does not, and
// it keeps clear of the window's own controls on either side.
describe('the title bar', () => {
  it('drags the window but not from its controls, and keeps clear of the window buttons', () => {
    const css = sheets['../views/shell.css']
    const [[start, end]] = blocks(css, /@media \(display-mode: window-controls-overlay\) \{/g)
    const wco = new Map(rules(css.slice(start, end)).map(([sel, body]) => [sel, body]))
    expect(wco.get('.pc-head')).toMatch(/app-region: drag;/)
    expect(wco.get('.pc-head')).toMatch(/--pc-head-start: max\(var\(--spacing-4\), calc\(env\(titlebar-area-x/)
    expect(wco.get('.pc-head')).toMatch(/padding-left: var\(--pc-head-start\);/)
    expect(wco.get('.pc-head')).toMatch(/padding-right: calc\(100vw - env\(titlebar-area-x/)
    expect(wco.get('.pc-head :is(a, button, .menu-list)')).toMatch(/app-region: no-drag;/)
  })

  // A maximized Windows window's title bar is 26 px, too low for astryx's sm
  // with room around it: the bar is 40 px, or the title bar if higher (spec §3 #233).
  it('is 40 px or the title bar, its controls astryx sm', () => {
    const css = sheets['../views/shell.css']
    const [[start, end]] = blocks(css, /@media \(display-mode: window-controls-overlay\) \{/g)
    const wco = new Map(rules(css.slice(start, end)).map(([sel, body]) => [sel, body]))
    expect(wco.get('.pc-head')).toMatch(
      /[^-]height: max\(env\(titlebar-area-height, var\(--size-element-lg\)\), calc\(var\(--size-element-sm\) \+ 2 \* var\(--spacing-1-5\)\)\);/,
    )
    expect(wco.get('.pc-head :is(.btn-sm, .hostpick)')).toMatch(/[^-]height: var\(--size-element-sm\);/)
    expect(wco.get('.pc-head .btn-icon.btn-sm')).toMatch(/width: var\(--size-element-sm\);/)
    expect(wco.get('.pc-head .pc-find')).toMatch(/--pc-find-h: var\(--size-element-sm\);/)
  })

  // The key caps sit as far from the field's right edge as from its top and
  // bottom, and their corners share the field's centres (spec §3 #236).
  it('rounds the key caps with the field', () => {
    const css = sheets['../views/shell.css']
    const [[start, end]] = blocks(css, /@media \(display-mode: window-controls-overlay\) \{/g)
    const plain = new Map(rules(css).filter(([, , at]) => at < start || at >= end).map(([sel, body]) => [sel, body]))
    const find = plain.get('.pc-find')!
    expect(find).toMatch(/--pc-find-inset: calc\(\(var\(--pc-find-h\) - var\(--spacing-5\)\) \/ 2\);/)
    expect(find).toMatch(/[^-]height: var\(--pc-find-h\);/)
    expect(find).toMatch(/padding: 0 calc\(var\(--pc-find-inset\) - var\(--border-width\)\) 0 /)
    expect(find).toMatch(/border-radius: var\(--radius-element\);/)
    expect(plain.get('.pc-find .kbd')).toMatch(/border-radius: calc\(var\(--radius-element\) - var\(--pc-find-inset\)\);/)
    expect(rules(sheets['./ui.css']).find(([sel]) => sel === '.kbd')?.[1]).toMatch(/[^-]height: var\(--spacing-5\);/)
  })

  // The field starts where the main area does: the sidebar's width, then the
  // header's gap as wide as the sidebar's handle (spec §3 #235).
  it('starts the field over the main area', () => {
    const css = sheets['../views/shell.css']
    const [[start, end]] = blocks(css, /@media \(display-mode: window-controls-overlay\) \{/g)
    const plain = new Map(rules(css).filter(([, , at]) => at < start || at >= end).map(([sel, body]) => [sel, body]))
    expect(plain.get('.pc-head')).toMatch(/[^-]gap: var\(--spacing-4\);/)
    expect(rules(sheets['./ui.css']).find(([sel]) => sel === '.splitter')?.[1]).toMatch(/width: 16px;/)
    expect(plain.get('.pc-head.has-side')).toMatch(/grid-template-columns: var\(--pc-side\) minmax\(0, 360px\)/)
    const wco = new Map(rules(css.slice(start, end)).map(([sel, body]) => [sel, body]))
    expect(wco.get('.pc-head.has-side')).toMatch(/grid-template-columns: calc\(var\(--pc-side\) \+ var\(--spacing-4\) - var\(--pc-head-start\)\)/)
  })
})

// The astryx guideline (AGENTS.md, spec §3 #201): every value comes from tokens.css.
describe('the stylesheets, after astryx', () => {
  // One row of the script gives a colour's light and both dark copies.
  it('keep tokens.css as scripts/tokens.mjs writes it (npm run tokens)', () => {
    expect(tokens).toBe(render())
  })

  // A mix of tokens (color-mix) is still theirs, as astryx's indicators mix theirs.
  it('take every colour from tokens.css', () => {
    const raw = declarations(/./).filter(
      (d) => /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|lab|lch)\(/i.test(d.value) || /\b(white|black|red|green|blue|gray|grey|silver|yellow|orange|purple|pink)\b/i.test(bare(d.value)),
    )
    expect(raw.map(show)).toEqual([])
  })

  it('use only the variables tokens.css or the sheet itself defines', () => {
    const defined = new Set([...strip(tokens).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
    // Set from a script: the visual viewport's height (lib/viewport.ts).
    defined.add('--app-h')
    // Set from a script: the sidebar's drawn width, for the PC header (Shell.tsx).
    defined.add('--pc-side')
    const missing = Object.entries(sheets).flatMap(([file, css]) => {
      const own = new Set([...strip(css).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
      return [...strip(css).matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]).filter((v) => !defined.has(v) && !own.has(v)).map((v) => `${file} ${v}`)
    })
    expect(missing).toEqual([])
  })

  it('give type and corners by token: size, weight, leading and radius', () => {
    const raw = declarations(/^(font-size|font-weight|line-height|border(-[\w]+)*-radius)$/).filter(
      (d) => !/var\(/.test(d.value) && !['0', '1', 'inherit', 'normal'].includes(d.value) && !(d.file === './fonts.css' && d.sel === '@font-face'),
    )
    expect(raw.map(show)).toEqual([])
  })

  it('space by token: padding, margin and gap', () => {
    // A layout length may follow the viewport; 1 px is a hairline.
    const raw = declarations(/^(padding|margin|gap|row-gap|column-gap)(-[\w]+)*$/).filter((d) =>
      [...bare(d.value).matchAll(/(-?\d*\.?\d+)(px|rem|em)\b/g)].some((m) => !['0', '1', '-1'].includes(m[1])),
    )
    expect(raw.map(show)).toEqual([])
  })

  it('move by token: durations and easings', () => {
    // Reduced motion ends a move at once (.01ms) but for astryx's spinner, which turns once in 3s.
    const durations = declarations(/^(transition|animation)(-duration)?$/).filter((d) =>
      [...d.value.matchAll(/(?<![\w-])(\d*\.?\d+m?s)\b/g)].some((m) => !['0s', '0ms', '.01ms'].includes(m[1]) && !(d.file === './base.css' && m[1] === '3s')),
    )
    expect(durations.map(show)).toEqual([])
    // A curve is an --ease-* token, or linear for a turn that keeps its pace. Reduced
    // motion on a touch screen fades on Core Animation's easeInOut, as astryx's does.
    const fade = /@media \(prefers-reduced-motion: reduce\) and \(pointer: coarse\) \{/g
    const curves = declarations(/^(transition|animation)(-timing-function)?$/).filter(
      (d) => /cubic-bezier\(|steps\(|\bease(-in|-out)?(?![\w-])/.test(bare(d.value)) || (/\bease-in-out(?![\w-])/.test(bare(d.value)) && !inside(d, fade)),
    )
    expect(curves.map(show)).toEqual([])
  })

  // A touch screen keeps :hover after a tap; a hover state only where a pointer can hover.
  it('hover only where a pointer can hover', () => {
    const loose = Object.entries(sheets).flatMap(([file, css]) => {
      const hover = blocks(css, /@media[^{]*\(hover:\s*hover\)[^{]*\{/g)
      return rules(css)
        .filter(([sel, , at]) => sel.includes(':hover') && !hover.some(([a, b]) => a <= at && at < b))
        .map(([sel]) => `${file} ${sel}`)
    })
    expect(loose).toEqual([])
  })

  // On a touch screen :active paints on the touch and outlives a scroll; lib/press.ts
  // writes data-press there instead, as astryx's press feedback does.
  it('press with :active only where the pointer is fine', () => {
    const loose = Object.entries(sheets).flatMap(([file, css]) => {
      const fine = blocks(css, /@media[^{]*\(pointer:\s*fine\)[^{]*\{/g)
      return rules(css)
        .filter(([sel, , at]) => sel.includes(':active') && !fine.some(([a, b]) => a <= at && at < b))
        .map(([sel]) => `${file} ${sel}`)
    })
    expect(loose).toEqual([])
    expect(rules(sheets['./base.css']).find(([sel]) => sel === '[data-press]')?.[1]).toMatch(/background-image: var\(--mori-overlay-pressed-image\)/)
  })

  // A background shorthand would wipe the hover and press overlays (background-image).
  it('set a fill as background-color, never by the shorthand', () => {
    expect(declarations(/^background$/).map(show)).toEqual([])
  })

  // astryx's disabled state: the control at half its strength, whatever it is.
  it('dim a disabled control to .5', () => {
    const off = declarations(/^opacity$/).filter((d) => /:disabled|\[aria-disabled="true"\]/.test(d.sel.replace(/:not\([^)]*\)/g, '')))
    expect(off.length).toBeGreaterThan(0)
    expect(off.filter((d) => !/^0?\.5$/.test(d.value)).map(show)).toEqual([])
  })
})
