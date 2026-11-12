// The changes of the worktree the Git panel shows, in the order of
// changeGroups: a list that picks the file shown beside it on a PC, and
// cards that open a file's diff under it, one at a time, on a phone.
import { Fragment } from 'preact'
import { useId, useState } from 'preact/hooks'
import { onContext } from '../components/ContextMenu'
import { Icon } from '../components/Icon'
import { copyAndTell } from '../lib/copy'
import { totals } from '../lib/diff'
import { fileParts, type ChangeGroup, type ChangeItem } from '../lib/format'
import { DiffView } from './Diff'
import { Loading } from './rows'
import { useDiff } from './useGit'

/** A change's letter, the file's name and where it is; the letter is read out in words. */
export function FileLabel({ it }: { it: ChangeItem }) {
  const { name, dir } = fileParts(it.path)
  const sub = [dir, it.note].filter(Boolean).join(' · ')
  return (
    <>
      <span class={'gc-letter tone-' + it.tone} aria-hidden="true">
        {it.letter}
      </span>
      <span class="gc-text">
        <span class="sr-only">{it.word}</span>{' '}
        <span class="gc-name">{name}</span>
        {sub && (
          <>
            {' '}
            <span class="gc-sub">{sub}</span>
          </>
        )}
      </span>
    </>
  )
}

/** A right-click on a file's row (spec §3 #242): its diff, its path. */
export function fileContext(it: ChangeItem, onSel: (key: string) => void) {
  return onContext(it.path, () => [
    { label: 'diff 보기', icon: 'eye', onSelect: () => onSel(it.key) },
    { label: '경로 복사', icon: 'copy', onSelect: () => void copyAndTell(it.path, '경로를 복사했습니다') },
  ])
}

function Clean() {
  return (
    <div class="empty gc-empty">
      <p class="empty-title">변경 없음</p>
      <p class="empty-text">작업 트리가 깨끗합니다</p>
    </div>
  )
}

export interface ChangeListProps {
  groups: ChangeGroup[]
  /** The files changed; one staged and changed again is in two groups but counts once. */
  count: number
  sel: string | undefined
  onSel: (key: string) => void
}

export function ChangeList({ groups, count, sel, onSel }: ChangeListProps) {
  const id = useId()
  return (
    <section class="gc" aria-labelledby={id}>
      <div class="gc-head">
        <h3 id={id} class="gc-title">
          변경 {count}
        </h3>
        <span class="gc-ro">읽기 전용</span>
      </div>
      {count === 0 ? (
        <Clean />
      ) : (
        groups.map((g) => (
          <Fragment key={g.key}>
            <h4 class="gc-group">{g.label}</h4>
            <ul class="gc-list">
              {g.items.map((it) => (
                <li key={it.key}>
                  <button type="button" class="gc-file" aria-current={it.key === sel ? 'true' : undefined} title={it.path} onClick={() => onSel(it.key)} onContextMenu={fileContext(it, onSel)}>
                    <FileLabel it={it} />
                  </button>
                </li>
              ))}
            </ul>
          </Fragment>
        ))
      )}
    </section>
  )
}

export interface ChangeCardsProps {
  groups: ChangeGroup[]
  count: number
  shown: string
  tick: number
}

export function ChangeCards({ groups, count, shown, tick }: ChangeCardsProps) {
  const id = useId()
  const [open, setOpen] = useState<string | null>(null)
  // A file that is no longer changed closes.
  const item = open === null ? undefined : groups.flatMap((g) => g.items).find((it) => it.key === open)
  const d = useDiff(shown, item, tick)
  const t = totals(d.files)
  const box = id + '-diff'
  return (
    <section class="gs-card gcc" aria-labelledby={id + '-h'}>
      <div class="gcc-head">
        <h2 id={id + '-h'} class="gs-card-title">
          변경 {count}
        </h2>
        <span class="gs-pill">읽기 전용</span>
      </div>
      {count === 0 ? (
        <Clean />
      ) : (
        groups.map((g) => (
          <Fragment key={g.key}>
            <h3 class="gcc-group">{g.label}</h3>
            <ul class="gcc-list">
              {g.items.map((it) => {
                const on = it.key === item?.key
                return (
                  <li key={it.key}>
                    <button
                      type="button"
                      class="gcc-row"
                      aria-expanded={on}
                      aria-controls={on ? box : undefined}
                      onClick={() => setOpen(on ? null : it.key)}
                    >
                      <FileLabel it={it} />
                      {on && d.diff && (
                        <span class="gcc-counts mono" aria-hidden="true">
                          <span class="add">+{t.added.toLocaleString('ko-KR')}</span> <span class="del">−{t.deleted.toLocaleString('ko-KR')}</span>
                        </span>
                      )}
                      <Icon name={on ? 'chevron-down' : 'chevron-right'} size={16} class="gcc-chev" />
                    </button>
                    {on && (
                      <div id={box} class="gcc-box">
                        {d.error ? (
                          <p class="gp-error" role="alert">
                            {d.error}
                          </p>
                        ) : d.diff ? (
                          <div class="gcc-diff">
                            <DiffView key={it.key} files={d.files} truncated={d.diff.truncated} wrap={false} />
                          </div>
                        ) : (
                          <Loading />
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </Fragment>
        ))
      )}
    </section>
  )
}
