// A folder's commit graph (spec §3 #104–#112, #128): the commits of every
// branch, or those HEAD reaches, one row each with the lines the server laid
// out. Picking a row shows the commit beside the graph on a PC (the aside
// Shell puts it in) and in a sheet over it on a phone. It only reads.
import { Component, Fragment } from 'preact'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { ConnBanner } from '../components/ConnBanner'
import { onContext } from '../components/ContextMenu'
import { Icon, type IconName } from '../components/Icon'
import { Segmented } from '../components/Segmented'
import { now } from '../lib/clock'
import { copyAndTell } from '../lib/copy'
import { shortHash, shortPath } from '../lib/format'
import { geom, graphWidth, isHead, laneX, PC, PHONE, rowPaths, tone, type Geom } from '../lib/graph'
import { parseHash, plainClick } from '../lib/router'
import { useHost } from '../lib/scope'
import { commitTime, dayClock, relTime } from '../lib/time'
import type { LogCommit } from '../lib/types'
import { CommitSheet } from './Commit'
import { FetchButton } from './Git'
import { RefChips } from './RefChips'
import { Loading, type Variant } from './rows'
import { graphFrom, LOG_MAX, shownLog, useLog, useRepo, type LogData, type Repo } from './useLog'
import './graph.css'

export interface GraphScreenProps {
  variant: Variant
  folder: string
  /** The worktree whose HEAD is marked; the folder's own when it is not one of them. */
  path?: string
  /** Only the commits HEAD reaches. */
  head: boolean
  /** The commit picked. */
  c?: string
  /** Where 뒤로 goes on a phone; the host's folders unless given. */
  back?: string
}

/** An element's inner width, followed as it changes; 0 until it is there. */
function useWidth(): [(el: HTMLElement | null) => void, number] {
  const [w, setW] = useState(0)
  const ro = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect()
    ro.current = null
    if (!el) return
    setW(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    ro.current = new ResizeObserver(() => setW(el.clientWidth))
    ro.current.observe(el)
  }, [])
  return [ref, w]
}

interface RowProps {
  c: LogCommit
  i: number
  g: Geom
  svgW: number
  sel: boolean
  /** The row Tab reaches; the others are reached with the arrow keys. */
  tab: boolean
  when: string
  /** The time in full, for a PC's date column. */
  at?: string
  to: string
  variant: Variant
}

const ROW_PROPS: (keyof RowProps)[] = ['c', 'i', 'g', 'svgW', 'sel', 'tab', 'when', 'at', 'to', 'variant']

/** A commit's row. A row draws again only when what it shows changes, for a log may have 2000 of them. */
class Row extends Component<RowProps> {
  shouldComponentUpdate(next: RowProps) {
    return ROW_PROPS.some((k) => next[k] !== this.props[k])
  }

  render() {
    const { c, i, g, svgW, sel, tab, when, at, to, variant } = this.props
    const lane = 'lane-' + tone(c.color)
    const hash = <span class="mono gr-hash">{shortHash(c.hash)}</span>
    // As in VS Code Git Graph: HEAD's commit hollow and its subject in semibold, a merge's subject quieter (spec §3 #246).
    const cls = 'gr-row' + (isHead(c) ? ' is-head' : '') + (c.parents.length > 1 ? ' is-merge' : '')
    return (
      <li class="gr-li">
        <a class={cls} href={to} aria-current={sel ? 'true' : undefined} tabIndex={tab ? 0 : -1} data-i={i} data-hash={c.hash}>
          <svg class="gr-svg" width={svgW} height={g.h} viewBox={`0 0 ${svgW} ${g.h}`} aria-hidden="true" focusable="false">
            {rowPaths(c, g).map((p, k) => (
              // Under each line a wider one in the background's colour, so a line crossing another cuts it.
              <Fragment key={k}>
                <path class="gr-shadow" d={p.d} />
                <path class={'gr-edge lane-' + p.tone} d={p.d} />
              </Fragment>
            ))}
            <circle class={'gr-dot ' + lane} cx={laneX(c.lane, g.w)} cy={g.h / 2} r={g.r} />
          </svg>
          {variant === 'pc' ? (
            <>
              <span class="gr-desc">
                <RefChips c={c} />
                {c.refs.length > 0 && ' '}
                <span class="gr-subject" title={c.subject}>
                  {c.subject}
                </span>
              </span>{' '}
              <span class="gr-when" title={at}>
                {when}
              </span>{' '}
              <span class="gr-author" title={c.author}>
                {c.author}
              </span>{' '}
              {hash}
            </>
          ) : (
            <span class="gr-text">
              <span class="gr-subject">{c.subject}</span>{' '}
              <span class="gr-meta">
                <RefChips c={c} max={1} />
                {c.refs.length > 0 && ' '}
                {hash} <span class="gr-when">{when}</span>
              </span>
            </span>
          )}
        </a>
      </li>
    )
  }
}

function Empty({ icon, title, text }: { icon: IconName; title: string; text?: string }) {
  return (
    <div class="empty gr-empty">
      <span class="empty-icon">
        <Icon name={icon} size={24} />
      </span>
      <p class="empty-title">{title}</p>
      {text && <p class="empty-text">{text}</p>}
    </div>
  )
}

/** Why there is no list to show, if there is not. */
function Missing({ repo, log }: { repo: Repo; log: LogData }) {
  if (repo.state === 'loading') return <Loading />
  if (repo.state !== 'ok') return <Empty icon="git" title={repo.state === 'missing' ? '폴더를 찾을 수 없습니다' : '이 폴더는 git 저장소가 아닙니다'} />
  if (!repo.shown) return <p class="qnote">열 수 있는 워크트리가 없습니다</p>
  if (!log.data)
    return log.error ? (
      <p class="gp-error" role="alert">
        {log.error}
      </p>
    ) : (
      <Loading />
    )
  return <Empty icon="commit" title="아직 커밋이 없습니다" text="첫 커밋을 만들면 여기에 보입니다." />
}

/** How many there are, and whether older ones can be read (spec §3 #107, #128). */
function Foot({ log }: { log: LogData }) {
  const data = log.data!
  const n = data.commits.length
  const count = `커밋 ${n.toLocaleString('ko-KR')}개`
  return (
    <div class="gr-foot">
      {log.error && (
        <p class="gr-foot-error" role="alert">
          {log.error}
        </p>
      )}
      {!data.more ? (
        <p>{count} · 처음 커밋까지 모두 보입니다</p>
      ) : n >= LOG_MAX ? (
        <p>{count} · 더 오래된 커밋은 터미널에서 보세요</p>
      ) : (
        <>
          <p>{count}</p>
          <button type="button" class="btn btn-sm gr-more" disabled={log.pending} onClick={log.more}>
            {log.pending ? '불러오는 중' : '더 불러오기'}
          </button>
        </>
      )}
    </div>
  )
}

/** Back to the session or the Git screen the graph was opened from on a PC, else to the folder's Git; only on the same host. */
function BackLink({ folder, path }: { folder: string; path?: string }) {
  const h = useHost()
  const from = graphFrom.value
  const to = from && from.host === h.id && from.folder === folder ? from.href : h.href({ name: 'git', folder, path })
  return (
    <a class="btn btn-sm gr-back" href={to}>
      <Icon name="back" size={15} />
      {parseHash(to).name === 'terminal' ? '작업 화면으로' : 'Git 화면으로'}
    </a>
  )
}

export function GraphScreen({ variant, folder, path, head, c, back }: GraphScreenProps) {
  const h = useHost()
  const repo = useRepo(folder, path)
  const log = useLog(repo.shown, head)
  const data = log.data
  const commits = data?.commits ?? []
  const byHash = useMemo(() => new Map((data?.commits ?? []).map((x) => [x.hash, x])), [data])

  // The commit beside the graph reads its names and its parents' subjects from here.
  useLayoutEffect(() => {
    shownLog.value = repo.shown && data ? { host: h.id, path: repo.shown, byHash } : null
  }, [repo.shown, byHash, h])
  useEffect(
    () => () => {
      shownLog.value = null
    },
    [],
  )

  const list = useRef<HTMLOListElement | null>(null)
  const [measure, rowW] = useWidth()
  const listRef = useCallback(
    (el: HTMLOListElement | null) => {
      list.current = el
      measure(el)
    },
    [measure],
  )
  const lanes = Math.max(1, data?.width ?? 1)
  const size = variant === 'pc' ? PC : PHONE
  const g = useMemo(() => geom(size, lanes, rowW), [size, lanes, rowW])
  const svgW = graphWidth(lanes, g.w, rowW)

  const rowOf = (hash: string) => list.current?.querySelector<HTMLElement>(`a[data-hash="${hash}"]`) ?? null
  const byKey = useRef(false)
  const pick = (hash: string, key: boolean) => {
    byKey.current = key
    h.go({ name: 'graph', folder, path, head, c: hash }, { replace: true })
  }
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>('a.gr-row')
    if (!a || !plainClick(e)) return
    e.preventDefault()
    pick(a.dataset.hash!, false)
  }
  // A right-click on a commit's row (spec §3 #242): it, its hash, its subject.
  const menu = onContext('커밋', (e) => {
    const a = (e.target as Element).closest<HTMLElement>('a.gr-row')
    const x = a ? commits[Number(a.dataset.i)] : undefined
    if (!x) return []
    return [
      { label: '커밋 보기', icon: 'commit', onSelect: () => pick(x.hash, false) },
      { label: '해시 복사', icon: 'copy', sep: true, onSelect: () => void copyAndTell(x.hash, '해시를 복사했습니다') },
      { label: '짧은 해시 복사', icon: 'copy', onSelect: () => void copyAndTell(shortHash(x.hash), '해시를 복사했습니다') },
      { label: '제목 복사', icon: 'copy', onSelect: () => void copyAndTell(x.subject, '제목을 복사했습니다') },
    ]
  })
  const onKey = (e: KeyboardEvent) => {
    const a = (e.target as Element).closest<HTMLElement>('a.gr-row')
    if (!a || e.altKey || e.ctrlKey || e.metaKey) return
    const i = Number(a.dataset.i)
    const last = commits.length - 1
    const to = { ArrowDown: Math.min(last, i + 1), ArrowUp: Math.max(0, i - 1), Home: 0, End: last }[e.key]
    if (to === undefined) return
    e.preventDefault()
    if (to === i) return
    list.current?.querySelector<HTMLElement>(`a[data-i="${to}"]`)?.focus()
    pick(commits[to].hash, true)
  }

  // The commit picked comes into view once, when it is there to show.
  const scrolled = useRef('')
  useEffect(() => {
    if (!c) {
      scrolled.current = ''
      return
    }
    if (scrolled.current === c) return
    const a = rowOf(c)
    if (!a) return
    scrolled.current = c
    a.scrollIntoView?.({ block: 'nearest' })
  }, [c, data])

  // Closing the commit gives the focus back to its row, when it went with the commit.
  const lastC = useRef(c)
  useEffect(() => {
    const was = lastC.current
    lastC.current = c
    if (c || !was) return
    const at = document.activeElement
    if (at && at !== document.body) return
    rowOf(was)?.focus()
  }, [c])

  const t = now.value
  const tabAt = c && byHash.has(c) ? c : commits[0]?.hash
  const to = (hash: string) => h.href({ name: 'graph', folder, path, head, c: hash })
  const pc = variant === 'pc'
  const rows = commits.length > 0 && (
    <ol class="gr-list" aria-label="커밋" ref={listRef} onClick={onClick} onKeyDown={onKey} onContextMenu={menu}>
      {commits.map((x, i) => (
        <Row
          key={x.hash}
          c={x}
          i={i}
          g={g}
          svgW={svgW}
          sel={x.hash === c}
          tab={x.hash === tabAt}
          when={pc ? dayClock(x.time_ms, t) : relTime(x.time_ms, t)}
          at={pc ? commitTime(x.time_ms, t) : undefined}
          to={to(x.hash)}
          variant={variant}
        />
      ))}
    </ol>
  )
  const scope = (
    <Segmented
      label="보기 범위"
      items={[
        { value: 'all', label: '모든 브랜치' },
        { value: 'head', label: 'HEAD만' },
      ]}
      value={head ? 'head' : 'all'}
      onChange={(v) => h.go({ name: 'graph', folder, path, head: v === 'head', c }, { replace: true })}
    />
  )
  const refresh = (cls: string, size: number) => (
    <button type="button" class={'btn btn-icon ' + cls} aria-label="새로 고침" title="새로 고침" disabled={!repo.shown} onClick={log.refresh}>
      <Icon name="refresh" size={size} />
    </button>
  )
  const f = repo.f

  if (variant === 'pc') {
    const sub = f ? [f.name, repo.shown && shortPath(repo.shown), '보기만 합니다'].filter(Boolean).join(' · ') : ''
    return (
      <div class="gs gs-pc gr">
        <header class="gs-head">
          <div class="gs-titles">
            <h1>Git 그래프</h1>
            {sub && <p class="gs-sub">{sub}</p>}
          </div>
          <div class="gr-tools">
            {scope}
            <FetchButton path={repo.shown} onDone={log.refresh} />
            {refresh('btn-sm gr-refresh', 16)}
            <BackLink folder={folder} path={path} />
          </div>
        </header>
        {rows ? (
          <>
            {/* The columns of VS Code Git Graph's table, each row's lined up under them (spec §3 #246). */}
            <div class="gr-scroll" style={{ '--gr-graph': `${svgW}px` }}>
              <div class="gr-cols" aria-hidden="true">
                <span>그래프</span>
                <span>설명</span>
                <span class="gr-col-when">날짜</span>
                <span class="gr-col-author">작성자</span>
                <span>커밋</span>
              </div>
              {rows}
            </div>
            <Foot log={log} />
          </>
        ) : (
          <Missing repo={repo} log={log} />
        )}
      </div>
    )
  }

  const n = data?.commits.length
  const sub = f ? [f.name, n !== undefined && `커밋 ${n.toLocaleString('ko-KR')}개`, '보기만 합니다'].filter(Boolean).join(' · ') : ''
  return (
    <div class={'gs gs-phone gr' + (c ? ' has-sheet' : '')}>
      <header class="gs-head">
        <a class="btn btn-icon btn-ghost gs-back" href={back ?? h.href({ name: 'folders' })} aria-label="뒤로">
          <Icon name="back" size={22} />
        </a>
        <div class="gs-titles">
          <h1>Git 그래프</h1>
          {sub && <p class="gs-sub">{sub}</p>}
        </div>
        {refresh('btn-ghost gp-refresh', 20)}
      </header>
      <ConnBanner class="gs-banner" />
      <div class="gr-scope">
        {scope}
        <FetchButton path={repo.shown} onDone={log.refresh} />
      </div>
      <div class="gr-scroll">
        {rows ? (
          <>
            <div class="gr-card">{rows}</div>
            <Foot log={log} />
          </>
        ) : (
          <Missing repo={repo} log={log} />
        )}
      </div>
      {c && (
        <CommitSheet
          r={{ name: 'graph', folder, path, head, c, host: h.id || undefined }}
          focus={!byKey.current}
          onClose={() => h.go({ name: 'graph', folder, path, head }, { replace: true })}
        />
      )}
    </div>
  )
}
