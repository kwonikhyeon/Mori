// A commit's names in the graph (spec §3 #104, #246), drawn as VS Code Git
// Graph draws them: a box with the commit's lane colour behind its icon, the
// branch HEAD is on bordered in that colour and its name in semibold. A
// remote branch at the same commit as the local one of its name joins that
// box ("main | origin"). The order is the server's: HEAD alone when it is
// detached, then branches, remote branches and tags. A row shows a few; the
// rest are counted.
import { Fragment } from 'preact'
import { Icon, type IconName } from '../components/Icon'
import { tone } from '../lib/graph'
import type { LogCommit, Ref } from '../lib/types'

/** What a name is read out as, and listed as under +N. */
export function refText(r: Ref): string {
  if (r.kind === 'head') return 'HEAD (브랜치가 아닌 커밋)'
  if (r.kind === 'tag') return '태그 ' + r.name
  if (r.kind === 'remote') return '원격 ' + r.name
  return r.current ? '현재 브랜치 ' + r.name : r.name
}

/** A box: a name, and the remotes whose branch of the same name is at the same commit. */
interface Label {
  r: Ref
  remotes: string[]
}

/** The names as boxes: a remote branch goes into its local branch's box when both are here. */
export function labels(refs: Ref[]): Label[] {
  const out: Label[] = []
  const local = new Map<string, Label>()
  for (const r of refs) {
    const slash = r.name.indexOf('/')
    const mine = r.kind === 'remote' && slash > 0 ? local.get(r.name.slice(slash + 1)) : undefined
    if (mine) {
      mine.remotes.push(r.name.slice(0, slash))
      continue
    }
    const l = { r, remotes: [] }
    if (r.kind === 'branch') local.set(r.name, l)
    out.push(l)
  }
  return out
}

const labelText = (l: Label) => [refText(l.r), ...l.remotes.map((o) => `원격 ${o}/${l.r.name}`)].join(', ')

function look(r: Ref): { cls: string; icon: IconName; shown: string } {
  if (r.kind === 'head') return { cls: 'is-current', icon: 'commit', shown: 'HEAD' }
  if (r.kind === 'tag') return { cls: 'is-tag', icon: 'tag', shown: r.name }
  if (r.kind === 'remote') return { cls: 'is-remote', icon: 'git', shown: r.name }
  return { cls: r.current ? 'is-current' : 'is-branch', icon: 'git', shown: r.name }
}

export interface RefChipsProps {
  c: LogCommit
  /** The boxes shown; past it they are counted. */
  max?: number
}

export function RefChips({ c, max = 3 }: RefChipsProps) {
  if (!c.refs.length) return null
  const lane = 'lane-' + tone(c.color)
  const all = labels(c.refs)
  const shown = all.slice(0, max)
  const rest = all.slice(shown.length)
  return (
    <span class="gr-chips">
      {shown.map((l, i) => {
        const { cls, icon, shown: name } = look(l.r)
        const text = labelText(l)
        // The spaces keep the names apart when read out; the flex box drops them from the layout.
        return (
          <Fragment key={l.r.kind + ':' + l.r.name}>
            {i > 0 && ' '}
            <span class={`gr-chip ${cls} ${lane}`} title={text}>
              <span class="gr-chip-icon">
                <Icon name={icon} size={12} stroke={2.2} />
              </span>
              <span class="gr-chip-name" aria-hidden="true">
                {name}
              </span>
              {l.remotes.map((o) => (
                <span key={o} class="gr-chip-remote" aria-hidden="true">
                  {o}
                </span>
              ))}
              <span class="sr-only">{text}</span>
            </span>
          </Fragment>
        )
      })}
      {rest.length > 0 && (
        <>
          {' '}
          <span class="gr-chip is-more" title={rest.map(labelText).join(', ')}>
            <span aria-hidden="true">+{rest.length}</span>
            <span class="sr-only">이름표 {rest.length}개 더</span>
          </span>
        </>
      )}
    </span>
  )
}
