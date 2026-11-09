import { describe, expect, it } from 'vitest'
import { parseDiff, totals, unquote } from './diff'

// What git printed for these, with core.quotepath=off.
const MODIFIED = `diff --git a/internal/push/notify.go b/internal/push/notify.go
index 770984b..c78cab4 100644
--- a/internal/push/notify.go
+++ b/internal/push/notify.go
@@ -41,4 +41,5 @@ func (n *Notifier) payload(t core.Terminal, k Kind) Payload {
-    title := hostName + " · " + k.Label()
+    title := n.host + " · " + k.Label()
+    body := displayName(t)
     return Payload{
--- a/x
+++ b/x
 }
@@ -60 +62 @@
-q
\\ No newline at end of file
+q2
\\ No newline at end of file
`

const lines = (f: { lines: { kind: string; text: string }[] }) => f.lines.map((l) => `${l.kind} ${l.text}`)

describe('parseDiff', () => {
  it('reads the hunks of a file, whatever a line inside them starts with', () => {
    const [f, ...rest] = parseDiff(MODIFIED)
    expect(rest).toEqual([])
    expect(f).toMatchObject({ path: 'internal/push/notify.go', change: 'modified', binary: false, added: 4, deleted: 3 })
    expect(f.orig).toBeUndefined()
    expect(lines(f)).toEqual([
      'hunk @@ -41,4 +41,5 @@ func (n *Notifier) payload(t core.Terminal, k Kind) Payload {',
      'del -    title := hostName + " · " + k.Label()',
      'add +    title := n.host + " · " + k.Label()',
      'add +    body := displayName(t)',
      'ctx      return Payload{',
      // Lines of the file that look like the header of another.
      'del --- a/x',
      'add +++ b/x',
      'ctx  }',
      'hunk @@ -60 +62 @@',
      'del -q',
      'note 파일 끝에 줄바꿈 없음',
      'add +q2',
      'note 파일 끝에 줄바꿈 없음',
    ])
  })

  it('reads a new file, an untracked one beside it and a deleted one', () => {
    const fs = parseDiff(`diff --git a/ita.txt b/ita.txt
new file mode 100644
index 0000000..ed286a7
--- /dev/null
+++ b/ita.txt
@@ -0,0 +1 @@
+ita
diff --git a/sp ace/f.txt b/sp ace/f.txt
new file mode 100644
index 0000000..8ba3a16
--- /dev/null
+++ b/sp ace/f.txt\t
@@ -0,0 +1 @@
+n
diff --git a/README.md b/README.md
deleted file mode 100644
index 770984b..0000000
--- a/README.md
+++ /dev/null
@@ -1 +0,0 @@
-mori
`)
    expect(fs.map((f) => [f.path, f.change, f.added, f.deleted])).toEqual([
      ['ita.txt', 'added', 1, 0],
      // git marks the end of a name with a space by a tab.
      ['sp ace/f.txt', 'added', 1, 0],
      ['README.md', 'deleted', 0, 1],
    ])
  })

  it('says what there is to say of a file without lines', () => {
    const fs = parseDiff(`diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
diff --git a/empty.txt b/empty.txt
new file mode 100644
index 0000000..e69de29
diff --git a/img.bin b/img.bin
new file mode 100644
index 0000000..f584f40
Binary files /dev/null and b/img.bin differ
diff --git a/both.txt b/새 이름 파일.txt
similarity index 100%
rename from both.txt
rename to 새 이름 파일.txt
diff --git a/c.txt b/c2.txt
similarity index 90%
copy from c.txt
copy to c2.txt
--- a/c.txt
+++ b/c2.txt
@@ -1 +1 @@
-c
+c2
* Unmerged path del.txt
`)
    expect(fs.map((f) => [f.path, f.orig, f.change, f.binary, lines(f)])).toEqual([
      ['run.sh', undefined, 'modified', false, ['note 파일 권한 100644 → 100755']],
      ['empty.txt', undefined, 'added', false, ['note 빈 파일입니다']],
      ['img.bin', undefined, 'added', true, ['note 바이너리 파일입니다']],
      ['새 이름 파일.txt', 'both.txt', 'renamed', false, ['note 내용은 그대로입니다']],
      ['c2.txt', 'c.txt', 'copied', false, ['hunk @@ -1 +1 @@', 'del -c', 'add +c2']],
      ['del.txt', undefined, 'unmerged', false, ['note 아직 풀지 않은 충돌입니다']],
    ])
  })

  it('reads a combined diff of a conflict', () => {
    const [f] = parseDiff(`diff --cc a.txt
index f4c4712,ed8445c..0000000
--- a/a.txt
+++ b/a.txt
@@@ -1,3 -1,3 +1,7 @@@
  one
++<<<<<<< HEAD
 +MAIN
++=======
+ SIDE
++>>>>>>> side
  three
`)
    expect(f).toMatchObject({ path: 'a.txt', change: 'unmerged', added: 5, deleted: 0 })
    expect(lines(f)).toEqual([
      'hunk @@@ -1,3 -1,3 +1,7 @@@',
      'ctx   one',
      'add ++<<<<<<< HEAD',
      'add  +MAIN',
      'add ++=======',
      'add + SIDE',
      'add ++>>>>>>> side',
      'ctx   three',
    ])
    const [g] = parseDiff(`diff --cc b.txt
index 1,2..3
--- a/b.txt
+++ b/b.txt
@@@ -1,2 -1,1 +1,1 @@@
- gone
  kept
`)
    expect(lines(g)).toEqual(['hunk @@@ -1,2 -1,1 +1,1 @@@', 'del - gone', 'ctx   kept'])
    expect(g.deleted).toBe(1)
  })

  it('reads names git quotes', () => {
    const fs = parseDiff(`diff --git "a/we\\"ird.txt" "b/we\\"ird.txt"
index bca70f3..e94e28a 100644
--- "a/we\\"ird.txt"
+++ "b/we\\"ird.txt"
@@ -1 +1 @@
-q
+q2
diff --git "a/tab\\tname.txt" "b/tab\\tname.txt"
new file mode 100644
index 0000000..718f4d2
--- /dev/null
+++ "b/tab\\tname.txt"
@@ -0,0 +1 @@
+t
diff --git a/x.sh b/x.sh
old mode 100644
new mode 100755
diff --git "a/\\355\\225\\234 \\352\\270\\200" "b/\\355\\225\\234 \\352\\270\\200"
old mode 100644
new mode 100755
`)
    expect(fs.map((f) => f.path)).toEqual(['we"ird.txt', 'tab\tname.txt', 'x.sh', '한 글'])
  })

  it('keeps what came before a cut', () => {
    const [f] = parseDiff(`diff --git a/a b/a
--- a/a
+++ b/a
@@ -1,9 +1,9 @@
 one
-two
`)
    expect(lines(f)).toEqual(['hunk @@ -1,9 +1,9 @@', 'ctx  one', 'del -two'])
    expect(parseDiff('')).toEqual([])
  })

  it('drops the carriage return of a line from Windows', () => {
    const [f] = parseDiff('diff --git a/w.txt b/w.txt\n--- a/w.txt\n+++ b/w.txt\n@@ -1 +1 @@\n-a\r\n+b\r\n')
    expect(lines(f)).toEqual(['hunk @@ -1 +1 @@', 'del -a', 'add +b'])
  })
})

describe('unquote', () => {
  it('reads the C quoting of git', () => {
    expect(unquote('plain')).toBe('plain')
    expect(unquote('"a\\\\b\\"c\\td\\ne"')).toBe('a\\b"c\td\ne')
    expect(unquote('"\\355\\225\\234"')).toBe('한')
  })
})

describe('totals', () => {
  it('adds up the lines of every file', () => {
    const fs = parseDiff(MODIFIED + 'diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1,2 @@\n-x\n+y\n+z\n')
    expect(totals(fs)).toEqual({ added: 6, deleted: 4 })
    expect(totals([])).toEqual({ added: 0, deleted: 0 })
  })
})
