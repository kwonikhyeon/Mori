// The folder screen: every registered folder with its terminals, the live
// ones newest first and the finished ones last; 기타 holds the rest.
import { Icon } from '../components/Icon'
import { now } from '../lib/clock'
import { appName, branchOf, finishedLine, place, shortPath } from '../lib/format'
import { groupByFolder, type FolderGroup } from '../lib/queue'
import { useHost } from '../lib/scope'
import type { HostStore } from '../lib/store'
import type { FolderView, TerminalView } from '../lib/types'
import { ListFrame, Loading, TermRow, type ListProps } from './rows'
import './lists.css'

function sub(h: HostStore, t: TerminalView, f: FolderView | null): string {
  if (t.state === 'finished') return finishedLine(t, h.presets.value, now.value)
  const app = appName(t, h.presets.value)
  if (!f) return `${app} · ${place(t, h.folders.value)}`
  const b = branchOf(t, f)
  return b ? `${app} · ${b}` : app
}

function FolderSection({ g, p }: { g: FolderGroup; p: ListProps }) {
  const h = useHost()
  const f = g.folder
  const id = `f-${p.variant}-${f ? f.id : 'rest'}`
  return (
    <section class="fsec" aria-labelledby={id}>
      <div class="fsec-head">
        <Icon name="folder" size={18} class="fsec-icon" />
        <div class="fsec-name">
          <h2 id={id}>{f ? f.name : '기타'}</h2>
          {f ? <span class="fsec-path mono">{shortPath(f.path)}</span> : <span class="fsec-path">다른 컴퓨터나 등록되지 않은 폴더</span>}
        </div>
        {f?.repo && (
          <a class="btn btn-sm" href={h.href({ name: 'git', folder: f.id })} aria-label={`${f.name} Git 보기`}>
            <Icon name="git" size={15} />
            Git
          </a>
        )}
        {f && (
          <a class="btn btn-sm" href={h.href({ name: 'new', folder: f.id })} aria-label={`${f.name}에서 새 세션`}>
            <Icon name="plus" size={15} />새 세션
          </a>
        )}
      </div>
      {g.items.length > 0 ? (
        <ul class="qrows qrows-joined">
          {g.items.map((t) => (
            <TermRow key={t.address} t={t} p={p} sub={sub(h, t, f)} />
          ))}
        </ul>
      ) : (
        <p class="fsec-none">세션 없음</p>
      )}
    </section>
  )
}

function EmptyFolders() {
  const h = useHost()
  return (
    <div class="empty">
      <span class="empty-icon">
        <Icon name="folder" size={26} />
      </span>
      <p class="empty-title">등록된 폴더가 없습니다</p>
      <p class="empty-text">새 세션에서 폴더를 고르면 여기에 생깁니다.</p>
      <a class="btn btn-primary" href={h.href({ name: 'new' })}>
        <Icon name="plus" stroke={2} />새 세션
      </a>
    </div>
  )
}

export function FolderList(p: ListProps) {
  const h = useHost()
  if (!h.ready.value) return <Loading />
  const groups = groupByFolder(h.terminals.value.values(), h.folders.value)
  return (
    <ListFrame class={`fv fv-${p.variant}`}>
      {groups.length === 0 ? <EmptyFolders /> : groups.map((g) => <FolderSection key={g.folder?.id ?? ''} g={g} p={p} />)}
    </ListFrame>
  )
}
