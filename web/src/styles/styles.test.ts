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
