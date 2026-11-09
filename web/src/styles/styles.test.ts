import { describe, expect, it } from 'vitest'

const sheets = import.meta.glob<string>('../**/*.css', { query: '?raw', import: 'default', eager: true })

/** Each rule as its selector and its declarations, comments left out. */
function rules(css: string): [string, string][] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim().replace(/\s+/g, ' '), m[2]])
}

/** The rules in a sheet's phone blocks, by each selector of a list. */
function phoneRules(css: string): Map<string, string> {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = new Map<string, string>()
  for (const m of src.matchAll(/@media \(max-width: 767px\) \{/g)) {
    const start = m.index + m[0].length
    let end = start
    for (let depth = 1; depth > 0; end++) depth += src[end] === '{' ? 1 : src[end] === '}' ? -1 : 0
    for (const [sel, body] of rules(src.slice(start, end - 1))) {
      for (const one of sel.split(',')) out.set(one.trim(), (out.get(one.trim()) ?? '') + body)
    }
  }
  return out
}

describe('the stylesheets', () => {
  // Tests leave stylesheets empty, unless asked for as text (css in vite.config.ts).
  it('are all read, as they are', () => {
    expect(Object.keys(sheets).length).toBeGreaterThan(10)
    expect(sheets['./base.css']).toContain('.sr-only {')
    expect(rules(sheets['../views/settings.css']).map(([sel]) => sel)).toContain('.st-scroll')
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
})
