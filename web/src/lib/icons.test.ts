import { describe, expect, it } from 'vitest'
import html from '../../index.html?raw'
import manifest from '../../public/manifest.json?raw'
import sw from '../../public/sw.js?raw'
import script from '../../scripts/icons.mjs?raw'
import shell from '../views/Shell.tsx?raw'

// The app icons' names carry their version, as an installed app takes a new
// icon only from a new URL and Windows keeps a shortcut's icon by its path
// (spec §3 #239): what the pages name is what public/icons holds.
const files = Object.keys(import.meta.glob('../../public/icons/*')).map((p) => p.slice(p.lastIndexOf('/') + 1))
const named = (src: string) => [...src.matchAll(/\/icons\/([\w.-]+)/g)].map((m) => m[1])
const version = /const VERSION = (\d+)/.exec(script)?.[1]

describe('the app icons', () => {
  it('are named with the version scripts/icons.mjs draws', () => {
    expect(version).toBeTruthy()
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(f).toMatch(new RegExp(`-v${version}\\.png$`))
  })

  it('are all there that the pages name, and none they do not', () => {
    const refs = new Set([html, manifest, sw, shell].flatMap(named))
    expect([...refs].filter((r) => !files.includes(r))).toEqual([])
    expect(files.filter((f) => !refs.has(f))).toEqual([])
    // the manifest's three and the touch icon
    expect(named(manifest)).toHaveLength(3)
    expect(named(html)).toContain(`apple-touch-icon-v${version}.png`)
  })
})
