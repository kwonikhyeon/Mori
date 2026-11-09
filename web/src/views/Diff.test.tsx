import { cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDiff } from '../lib/diff'
import { DiffView } from './Diff'

const ONE = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 keep
-old
+new
`

const TWO =
  ONE +
  `diff --git a/old.md b/new.md
similarity index 90%
rename from old.md
rename to new.md
--- a/old.md
+++ b/new.md
@@ -3 +3,2 @@
-x
+y
+z
`

/** A file of n added lines. */
const big = (name: string, n: number) =>
  `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${n} @@\n` +
  Array.from({ length: n }, (_, i) => `+${i}\n`).join('')

const shown = (c: Element) => [...c.querySelectorAll('.dv-line')].map((l) => `${l.className.replace('dv-line dv-', '')} ${l.textContent}`)

/** Each file's header: its path, the counts as seen and as read out. */
const heads = (c: Element) =>
  [...c.querySelectorAll('.dv-file')].map((h) => [
    h.querySelector('.dv-file-path')!.textContent,
    h.querySelector('.dv-counts')!.textContent,
    h.querySelector('.sr-only')!.textContent,
  ])

afterEach(cleanup)

describe('DiffView', () => {
  it('shows the lines of one file without a header', () => {
    const { container } = render(<DiffView files={parseDiff(ONE)} truncated={false} wrap />)
    expect(shown(container)).toEqual(['hunk @@ -1,2 +1,2 @@', 'ctx  keep', 'del -old', 'add +new'])
    expect(container.querySelector('.dv-file')).toBeNull()
    expect(container.querySelector('.dv')!.classList.contains('dv-wrap')).toBe(true)
  })

  it('heads each file when there are several', () => {
    const { container } = render(<DiffView files={parseDiff(TWO)} truncated={false} wrap={false} />)
    expect(heads(container)).toEqual([
      ['a.txt', '+1 −1', '1줄 추가, 1줄 삭제'],
      ['old.md → new.md', '+2 −1', '2줄 추가, 1줄 삭제'],
    ])
    expect(container.querySelector('.dv')!.classList.contains('dv-pre')).toBe(true)
  })

  it('says when there is nothing, and when the rest was cut', () => {
    render(<DiffView files={[]} truncated={false} wrap />)
    expect(screen.getByText('보여 줄 변경 내용이 없습니다')).toBeTruthy()
    cleanup()
    render(<DiffView files={parseDiff(ONE)} truncated wrap />)
    expect(screen.getByText('변경 내용이 길어서 앞부분만 보입니다')).toBeTruthy()
  })

  it('shows the first 3000 lines until asked for the rest', () => {
    const { container } = render(<DiffView files={parseDiff(big('a', 2000) + big('b', 1500))} truncated={false} wrap />)
    // The hunk lines count too: 1 + 2000 in a, and 999 of b's 1501.
    expect(container.querySelectorAll('.dv-line')).toHaveLength(3000)
    expect(container.querySelectorAll('.dv-file')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '나머지 502줄 보기' }))
    expect(container.querySelectorAll('.dv-line')).toHaveLength(3502)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('heads only the files it shows', () => {
    const { container } = render(<DiffView files={parseDiff(big('a', 3500) + big('b', 1))} truncated={false} wrap />)
    expect(heads(container)).toEqual([['a', '+3500 −0', '3500줄 추가, 0줄 삭제']])
    expect(screen.getByRole('button', { name: '나머지 503줄 보기' })).toBeTruthy()
  })
})
