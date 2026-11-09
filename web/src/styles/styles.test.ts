import { describe, expect, it } from 'vitest'

const sheets = import.meta.glob<string>('../**/*.css', { query: '?raw', import: 'default', eager: true })

/** Each rule as its selector and its declarations, comments left out. */
function rules(css: string): [string, string][] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim().replace(/\s+/g, ' '), m[2]])
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
})
