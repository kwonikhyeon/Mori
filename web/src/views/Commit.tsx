// A commit of the graph (spec §3 #110, #112): its message, who wrote it and
// when, its names and parents, and its files, each with its diff against the
// first parent. Beside the graph on a PC; on a phone in a sheet that leaves
// the rows above it to scroll and tap.
import { Fragment, type ComponentChildren } from 'preact'
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Icon } from '../components/Icon'
import { now } from '../lib/clock'
import { copyText } from '../lib/copy'
import { commitItems, fileTotals, shortHash, splitMessage, type CommitItem } from '../lib/format'
import { href, navigate, plainClick, type Route } from '../lib/router'
import { useHost } from '../lib/scope'
import { commitTime, relTime } from '../lib/time'
import { toast } from '../lib/toast'
import type { Commit } from '../lib/types'
import { DiffPane } from './Git'
import { FileLabel, fileContext } from './GitChanges'
import { RefChips } from './RefChips'
import { Loading } from './rows'
import { shownLog, useCommit, useRepo, type CommitRead, type Repo } from './useLog'

export type GraphRoute = Extract<Route, { name: 'graph' }>

export interface CommitProps {
  /** The graph's route; its c is the commit shown. */
  r: GraphRoute
  onClose: () => void
}

/** A link to another commit of the same graph, which a plain click picks as its row would. */
function commitLink(r: GraphRoute, rev: string) {
  return {
    href: href({ ...r, c: rev }),
    onClick: (e: MouseEvent) => {
      if (!plainClick(e)) return
      e.preventDefault()
      navigate({ ...r, c: rev }, { replace: true })
    },
  }
}

/** The commit and its files, and the one picked; a commit picks its first until one is. */
function useShown(r: GraphRoute) {
  const rev = r.c ?? ''
  const repo = useRepo(r.folder, r.path)
  const read = useCommit(repo.shown, rev)
  const c = read.data
  const items = useMemo(() => (c ? commitItems(c) : []), [c])
  return { rev, repo, read, c, items }
}

function CopyHash({ hash, size }: { hash: string; size: number }) {
  const copy = async () => {
    if (await copyText(hash)) toast('해시를 복사했습니다')
    else toast('복사하지 못했습니다', 'error')
  }
  return (
    <button type="button" class="btn btn-icon btn-ghost cm-copy" aria-label="전체 해시 복사" title="전체 해시 복사" onClick={copy}>
      <Icon name="copy" size={size} />
    </button>
  )
}

/** Why there is no commit to show yet, or the commit. */
function Read({ repo, read, children }: { repo: Repo; read: CommitRead; children: ComponentChildren }) {
  if (repo.state === 'loading') return <Loading />
  if (repo.state !== 'ok') return <p class="qnote">{repo.state === 'missing' ? '폴더를 찾을 수 없습니다' : '이 폴더는 git 저장소가 아닙니다'}</p>
  if (!repo.shown) return <p class="qnote">열 수 있는 워크트리가 없습니다</p>
  if (read.error)
    return (
      <p class="gp-error" role="alert">
        {read.error}
      </p>
    )
  if (!read.data) return <Loading />
  return <>{children}</>
}

function Counts({ added, deleted, class: cls }: { added: number; deleted: number; class: string }) {
  const a = added.toLocaleString('ko-KR')
  const d = deleted.toLocaleString('ko-KR')
  return (
    <span class={cls + ' mono'}>
      <span aria-hidden="true">
        <span class="add">+{a}</span> <span class="del">−{d}</span>
      </span>
      <span class="sr-only">
        {a}줄 추가, {d}줄 삭제
      </span>
    </span>
  )
}

/** A file's lines, or that a binary one has none to count. */
function FileCounts({ it }: { it: CommitItem }) {
  if (it.binary) return <span class="cm-bin">바이너리</span>
  return <Counts class="cm-counts" added={it.added} deleted={it.deleted} />
}

function FilesHead({ c, id, phone = false }: { c: Commit; id: string; phone?: boolean }) {
  const t = fileTotals(c.files)
  return (
    <div class={phone ? 'cs-files-head' : 'gc-head cm-files-head'}>
      <h3 id={id} class={phone ? 'cs-files-title' : 'gc-title'}>
        파일 {c.files.length.toLocaleString('ko-KR')}
        {c.truncated && '+'}
      </h3>
      {c.files.length > 0 && <Counts class="cm-totals" added={t.added} deleted={t.deleted} />}
    </div>
  )
}

/** What a list of files needs said under its head. */
function FilesNote({ c }: { c: Commit }) {
  if (c.parents.length < 2) return null
  return <p class="cm-note">병합 커밋입니다. 첫 부모와 비교합니다.</p>
}

function FilesFoot({ c }: { c: Commit }) {
  if (!c.files.length) return <p class="qnote">바뀐 파일이 없습니다</p>
  if (!c.truncated) return null
  return <p class="qnote">파일이 너무 많아 앞의 {c.files.length.toLocaleString('ko-KR')}개만 보입니다</p>
}

/** The rows of the graph beside it, when it shows this worktree of the same host: the commit's names and its parents' subjects. */
function useKnown(repo: Repo) {
  const h = useHost()
  const log = shownLog.value
  return log && log.host === h.id && log.path === repo.shown ? log.byHash : undefined
}

/* ---------- PC ---------- */

function Summary({ c, r, repo }: { c: Commit; r: GraphRoute; repo: Repo }) {
  const { subject, body } = splitMessage(c.message)
  const t = now.value
  const known = useKnown(repo)
  const self = known?.get(c.hash)
  const committed = c.committer !== c.author || c.committer_email !== c.email
  return (
    <section class="cm-sum" aria-label="커밋 내용">
      <h3 class="cm-subject">{subject}</h3>
      {body && <p class="cm-body">{body}</p>}
      <dl class="cm-facts">
        <dt>작성</dt>
        <dd>
          <span title={c.email}>{c.author}</span> · {commitTime(c.author_ms, t)}
        </dd>
        {committed && (
          <>
            <dt>커밋</dt>
            <dd>
              <span title={c.committer_email}>{c.committer}</span> · {commitTime(c.commit_ms, t)}
            </dd>
          </>
        )}
        {self && self.refs.length > 0 && (
          <>
            <dt>이름표</dt>
            <dd class="cm-refs">
              <RefChips c={self} max={8} />
            </dd>
          </>
        )}
        <dt>부모</dt>
        {c.parents.length ? (
          c.parents.map((p) => {
            const sub = known?.get(p)?.subject
            return (
              <dd key={p} class="cm-parent">
                <a class="mono" {...commitLink(r, p)}>
                  {shortHash(p)}
                </a>
                {sub && (
                  <>
                    {' '}
                    <span class="cm-psub">{sub}</span>
                  </>
                )}
              </dd>
            )
          })
        ) : (
          <dd>없음 (처음 커밋)</dd>
        )}
        <dt>해시</dt>
        <dd class="mono cm-full">{c.hash}</dd>
      </dl>
    </section>
  )
}

function PanelFiles({ c, items, sel, onSel }: { c: Commit; items: CommitItem[]; sel?: string; onSel: (key: string) => void }) {
  const id = useId()
  return (
    <section class="gc cm-files" aria-labelledby={id}>
      <FilesHead c={c} id={id} />
      <FilesNote c={c} />
      {items.length > 0 && (
        <ul class="gc-list">
          {items.map((it) => (
            <li key={it.key}>
              <button
                type="button"
                class="gc-file cm-file"
                aria-current={it.key === sel ? 'true' : undefined}
                title={it.path}
                onClick={() => onSel(it.key)}
                onContextMenu={fileContext(it, onSel)}
              >
                <FileLabel it={it} />{' '}
                <FileCounts it={it} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <FilesFoot c={c} />
    </section>
  )
}

/** Beside the graph on a PC, in the aside. */
export function CommitPanel({ r, onClose }: CommitProps) {
  const { rev, repo, read, c, items } = useShown(r)
  const [pick, setPick] = useState<{ rev: string; key: string }>()
  const item = (pick?.rev === rev ? items.find((x) => x.key === pick.key) : undefined) ?? items[0]
  return (
    <div class="gp cm">
      <header class="gp-head">
        <Icon name="commit" size={16} class="gp-head-icon" />
        <h2 class="gp-title">커밋</h2>
        <span class="mono cm-hash" title={rev}>
          {shortHash(rev)}
        </span>
        <CopyHash hash={rev} size={16} />
        <button type="button" class="btn btn-icon btn-ghost cm-close" aria-label="커밋 닫기" title="커밋 닫기" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </header>
      <Read repo={repo} read={read}>
        {c && (
          <>
            <div class={'gp-top' + (item ? ' has-diff' : '')}>
              <Summary c={c} r={r} repo={repo} />
              <PanelFiles c={c} items={items} sel={item?.key} onSel={(key) => setPick({ rev, key })} />
            </div>
            {item && <DiffPane shown={repo.shown} item={item} tick={0} />}
          </>
        )}
      </Read>
    </div>
  )
}

/* ---------- phone ---------- */

function SheetSummary({ c, r, repo }: { c: Commit; r: GraphRoute; repo: Repo }) {
  const { subject, body } = splitMessage(c.message)
  // Its row has room for one name; here they all are.
  const self = useKnown(repo)?.get(c.hash)
  return (
    <section class="cs-sum" aria-label="커밋 내용">
      <h3 class="cs-subject">{subject}</h3>
      {body && <p class="cs-body">{body}</p>}
      {self && self.refs.length > 0 && (
        <p class="cs-refs">
          <RefChips c={self} max={8} />
        </p>
      )}
      <p class="cs-meta">
        <span title={c.email}>{c.author}</span> · {relTime(c.author_ms, now.value)} ·{' '}
        {c.parents.length ? (
          <>
            부모{' '}
            {c.parents.map((p, i) => (
              <Fragment key={p}>
                {i > 0 && ', '}
                <a class="mono" {...commitLink(r, p)}>
                  {shortHash(p)}
                </a>
              </Fragment>
            ))}
          </>
        ) : (
          '처음 커밋'
        )}
      </p>
    </section>
  )
}

function SheetFiles({ c, items, onOpen }: { c: Commit; items: CommitItem[]; onOpen: (key: string) => void }) {
  const id = useId()
  return (
    <section class="cs-files" aria-labelledby={id}>
      <FilesHead c={c} id={id} phone />
      <FilesNote c={c} />
      {items.length > 0 && (
        <ul class="gcc-list">
          {items.map((it) => (
            <li key={it.key}>
              <button type="button" class="gcc-row cs-file" data-key={it.key} onClick={() => onOpen(it.key)}>
                <FileLabel it={it} />{' '}
                <FileCounts it={it} />
                <Icon name="chevron-right" size={16} class="gcc-chev" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <FilesFoot c={c} />
    </section>
  )
}

export interface CommitSheetProps extends CommitProps {
  /** Takes the focus when it opens: not when the rows under it are walked with the arrow keys. */
  focus?: boolean
}

/** Over the graph on a phone: the commit, then one file's diff. It leaves the rows above it to use. */
export function CommitSheet({ r, onClose, focus = true }: CommitSheetProps) {
  const { rev, repo, read, c, items } = useShown(r)
  const [open, setOpen] = useState<{ rev: string; key: string } | null>(null)
  const item = open?.rev === rev ? items.find((x) => x.key === open.key) : undefined
  const id = useId()
  const box = useRef<HTMLElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const backBtn = useRef<HTMLButtonElement>(null)
  const was = useRef<{ rev: string; key: string }>()
  useLayoutEffect(() => {
    if (focus) title.current?.focus()
    // Only when it opens: the next commits keep the focus where it is.
  }, [])
  useLayoutEffect(() => {
    // The diff's way back takes the focus, and the file it showed takes it again;
    // not when another commit closed it, picked with the keys on the rows above.
    if (item) {
      was.current = { rev, key: item.key }
      backBtn.current?.focus()
      return
    }
    const w = was.current
    was.current = undefined
    if (!w) return
    if (w.rev !== rev) {
      // Coming back to that commit shows its files, not the diff left open.
      setOpen(null)
      return
    }
    const rows = box.current?.querySelectorAll<HTMLElement>('.cs-file') ?? []
    for (const b of rows) if (b.dataset.key === w.key) b.focus()
  }, [item?.key, rev])
  const back = () => setOpen(null)
  return (
    <section
      ref={box}
      class={'cs' + (item ? ' is-diff' : '')}
      aria-labelledby={id}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        if (item) back()
        else onClose()
      }}
    >
      <div class="cs-grab" aria-hidden="true" />
      <header class="cs-head">
        {item && (
          <button ref={backBtn} type="button" class="btn btn-icon btn-ghost cs-back" aria-label="파일 목록으로" title="파일 목록으로" onClick={back}>
            <Icon name="back" size={20} />
          </button>
        )}
        <h2 id={id} ref={title} class="cs-title" tabIndex={-1}>
          커밋
        </h2>
        <span class="mono cs-hash">{shortHash(rev)}</span>
        <CopyHash hash={rev} size={18} />
        <button type="button" class="btn btn-icon btn-ghost cs-close" aria-label="커밋 닫기" title="커밋 닫기" onClick={onClose}>
          <Icon name="close" size={20} />
        </button>
      </header>
      {item ? (
        <DiffPane shown={repo.shown} item={item} tick={0} />
      ) : (
        <div class="cs-scroll">
          <Read repo={repo} read={read}>
            {c && (
              <>
                <SheetSummary c={c} r={r} repo={repo} />
                <SheetFiles c={c} items={items} onOpen={(key) => setOpen({ rev, key })} />
              </>
            )}
          </Read>
        </div>
      )}
    </section>
  )
}
