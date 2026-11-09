// The lines of a diff, file by file (spec §3 #136): in the Git panel and in
// the files of a commit. A long one shows its first lines until the rest is
// asked for.
import { Fragment } from 'preact'
import { useState } from 'preact/hooks'
import type { DiffFile } from '../lib/diff'
import './diff.css'

/** The lines shown at first; thousands of them make the page slow. */
export const LINE_CAP = 3000

export interface DiffViewProps {
  files: DiffFile[]
  /** The server cut it short. */
  truncated: boolean
  /** Long lines wrap (a PC), or the box scrolls sideways (a phone). */
  wrap: boolean
}

export function DiffView({ files, truncated, wrap }: DiffViewProps) {
  const [all, setAll] = useState(false)
  const shown: DiffFile[] = []
  let left = all ? Infinity : LINE_CAP
  for (const f of files) {
    if (left <= 0) break
    shown.push(f.lines.length <= left ? f : { ...f, lines: f.lines.slice(0, left) })
    left -= f.lines.length
  }
  const rest = files.reduce((n, f) => n + f.lines.length, 0) - shown.reduce((n, f) => n + f.lines.length, 0)
  const several = files.length > 1
  return (
    <div class={'dv ' + (wrap ? 'dv-wrap' : 'dv-pre')}>
      {shown.length > 0 && (
        <div class="dv-lines">
          {shown.map((f, i) => (
            <Fragment key={i}>
              {several && <FileHead f={f} />}
              {f.lines.map((l, j) => (
                <div key={j} class={'dv-line dv-' + l.kind}>
                  {l.text}
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      )}
      {rest > 0 && (
        <div class="dv-more">
          <button type="button" class="btn btn-sm" onClick={() => setAll(true)}>
            나머지 {rest}줄 보기
          </button>
        </div>
      )}
      {truncated ? (
        <p class="dv-say">변경 내용이 길어서 앞부분만 보입니다</p>
      ) : (
        files.length === 0 && <p class="dv-say">보여 줄 변경 내용이 없습니다</p>
      )}
    </div>
  )
}

function FileHead({ f }: { f: DiffFile }) {
  return (
    <div class="dv-file">
      <span class="dv-file-path">
        {f.orig && <>{f.orig} → </>}
        {f.path}
      </span>
      <span class="dv-counts" aria-hidden="true">
        <span class="dv-n-add">+{f.added}</span> <span class="dv-n-del">−{f.deleted}</span>
      </span>
      <span class="sr-only">
        {f.added}줄 추가, {f.deleted}줄 삭제
      </span>
    </div>
  )
}
