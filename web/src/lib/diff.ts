// Reading the text git prints for a diff into files and the lines to show.
// A line keeps its columns of + and -; what git says about a file without
// lines is said in a note instead.

export type LineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'note'
export interface DiffLine {
  kind: LineKind
  text: string
}
export type FileChange = 'added' | 'deleted' | 'renamed' | 'copied' | 'modified' | 'unmerged'
export interface DiffFile {
  path: string
  /** The path the file had, when it was renamed or copied. */
  orig?: string
  change: FileChange
  binary: boolean
  added: number
  deleted: number
  lines: DiffLine[]
}

const NOTE = {
  eof: '파일 끝에 줄바꿈 없음',
  binary: '바이너리 파일입니다',
  empty: '빈 파일입니다',
  same: '내용은 그대로입니다',
  conflict: '아직 풀지 않은 충돌입니다',
}

interface Draft {
  file: DiffFile
  /** The columns of + and - before each line of the hunk; 0 outside one. */
  cols: number
  hunks: number
  /** A combined diff, whose file stays unmerged whatever its modes say. */
  cc: boolean
  git: [string | null, string | null]
  /** The names on the --- and +++ lines; null for /dev/null. */
  minus?: string | null
  plus?: string | null
  to?: string
  oldMode?: string
}

// "@@ -1,2 +1,3 @@ heading", or "@@@ -1 -1 +1 @@@" with one more @ for
// each parent past the first.
const HUNK = /^(@{2,}) [-+0-9, ]+? \1(?: |$)/

/** The lines added and deleted in all of them. */
export function totals(fs: DiffFile[]): { added: number; deleted: number } {
  return fs.reduce((t, f) => ({ added: t.added + f.added, deleted: t.deleted + f.deleted }), { added: 0, deleted: 0 })
}

export function parseDiff(text: string): DiffFile[] {
  const out: DiffFile[] = []
  let d: Draft | null = null
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  for (let line of lines) {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    const start = fileStart(line)
    if (start) {
      if (d) out.push(finish(d))
      d = start
      continue
    }
    if (!d || (d.cols > 0 && body(d, line))) continue
    const h = HUNK.exec(line)
    if (h) {
      d.cols = h[1].length - 1
      d.hunks++
      d.file.lines.push({ kind: 'hunk', text: line })
      continue
    }
    d.cols = 0
    header(d, line)
  }
  if (d) out.push(finish(d))
  return out
}

function draft(change: FileChange, cc: boolean, git: [string | null, string | null]): Draft {
  return { file: { path: '', change, binary: false, added: 0, deleted: 0, lines: [] }, cols: 0, hunks: 0, cc, git }
}

function fileStart(line: string): Draft | null {
  if (line.startsWith('diff --git ')) return draft('modified', false, gitNames(line.slice(11)))
  for (const p of ['diff --cc ', 'diff --combined ', '* Unmerged path ']) {
    if (!line.startsWith(p)) continue
    const name = unquote(line.slice(p.length))
    return draft('unmerged', true, [name, name])
  }
  return null
}

/** Takes a line of a hunk; false when the line is not one. */
function body(d: Draft, line: string): boolean {
  const c = line[0]
  if (c === '\\') {
    note(d.file, NOTE.eof)
    return true
  }
  // An empty line is an empty one of the file, with diff.suppressBlankEmpty.
  if (line !== '' && c !== ' ' && c !== '+' && c !== '-') return false
  const mark = line.slice(0, d.cols)
  const kind: LineKind = mark.includes('-') ? 'del' : mark.includes('+') ? 'add' : 'ctx'
  if (kind === 'add') d.file.added++
  if (kind === 'del') d.file.deleted++
  d.file.lines.push({ kind, text: line || ' '.repeat(d.cols) })
  return true
}

const HEADERS: [string, (d: Draft, v: string) => void][] = [
  ['--- ', (d, v) => (d.minus = side(v, 'a/'))],
  ['+++ ', (d, v) => (d.plus = side(v, 'b/'))],
  ['old mode ', (d, v) => (d.oldMode = v)],
  ['new mode ', (d, v) => note(d.file, `파일 권한 ${d.oldMode ?? '?'} → ${v}`)],
  ['new file mode ', (d) => d.cc || (d.file.change = 'added')],
  ['deleted file mode ', (d) => d.cc || (d.file.change = 'deleted')],
  ['rename from ', (d, v) => ((d.file.change = 'renamed'), (d.file.orig = unquote(v)))],
  ['rename to ', (d, v) => (d.to = unquote(v))],
  ['copy from ', (d, v) => ((d.file.change = 'copied'), (d.file.orig = unquote(v)))],
  ['copy to ', (d, v) => (d.to = unquote(v))],
  ['Binary files ', (d) => ((d.file.binary = true), note(d.file, NOTE.binary))],
]

function header(d: Draft, line: string) {
  const h = HEADERS.find(([p]) => line.startsWith(p))
  if (h) h[1](d, line.slice(h[0].length))
}

function finish(d: Draft): DiffFile {
  const f = d.file
  f.path = d.to ?? d.plus ?? d.minus ?? d.git[1] ?? d.git[0] ?? ''
  if (!d.hunks && !f.binary) {
    const n = { added: NOTE.empty, deleted: NOTE.empty, renamed: NOTE.same, copied: NOTE.same, unmerged: NOTE.conflict, modified: '' }[f.change]
    if (n) note(f, n)
  }
  return f
}

function note(f: DiffFile, text: string) {
  f.lines.push({ kind: 'note', text })
}

const strip = (name: string, prefix: string) => (name.startsWith(prefix) ? name.slice(prefix.length) : name)

/** The name on a --- or +++ line. git ends one that has a space with a tab. */
function side(v: string, prefix: string): string | null {
  if (v.endsWith('\t')) v = v.slice(0, -1)
  return v === '/dev/null' ? null : strip(unquote(v), prefix)
}

/** The two names of a "diff --git" line, when they can be told apart. */
function gitNames(rest: string): [string | null, string | null] {
  let a: string
  let b: string
  if (rest.startsWith('"')) {
    const end = quoteEnd(rest)
    a = rest.slice(0, end)
    b = rest.slice(end + 1)
  } else if (rest.endsWith('"') && rest.includes(' "')) {
    // A bare name has no quote in it; git would have quoted it.
    const i = rest.indexOf(' "')
    a = rest.slice(0, i)
    b = rest.slice(i + 1)
  } else {
    // Bare names with spaces split only where both halves name one file.
    const half = (rest.length - 1) / 2
    a = rest.slice(0, half)
    b = rest.slice(half + 1)
    if (rest[half] !== ' ' || a.slice(2) !== b.slice(2)) return [null, null]
  }
  return [strip(unquote(a), 'a/'), strip(unquote(b), 'b/')]
}

function quoteEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === '"') return i + 1
  }
  return s.length
}

const ESC: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** A name as git quotes it, in C's way with bytes in octal, read back. */
export function unquote(s: string): string {
  if (s.length < 2 || s[0] !== '"' || !s.endsWith('"')) return s
  const inner = s.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < inner.length; ) {
    const j = inner.indexOf('\\', i)
    bytes.push(...ENC.encode(j < 0 ? inner.slice(i) : inner.slice(i, j)))
    if (j < 0) break
    const oct = /^[0-3][0-7]{2}/.exec(inner.slice(j + 1, j + 4))
    if (oct) {
      bytes.push(parseInt(oct[0], 8))
      i = j + 4
      continue
    }
    const c = inner[j + 1] ?? ''
    bytes.push(...(c in ESC ? [ESC[c]] : ENC.encode(c)))
    i = j + 2
  }
  return DEC.decode(new Uint8Array(bytes))
}
