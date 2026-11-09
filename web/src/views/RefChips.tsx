// A commit's names in the graph (spec §3 #104): the branch HEAD is on, or
// HEAD alone when it is detached, then branches, remote branches and tags,
// in the order the server sends them. A row shows a few; the rest are
// counted.
import { Fragment } from 'preact'
import { Icon } from '../components/Icon'
import { tone } from '../lib/graph'
import type { LogCommit, Ref } from '../lib/types'

/** What a name is read out as, and listed as under +N. */
export function refText(r: Ref): string {
  if (r.kind === 'head') return 'HEAD (브랜치가 아닌 커밋)'
  if (r.kind === 'tag') return '태그 ' + r.name
  if (r.kind === 'remote') return '원격 ' + r.name
  return r.current ? '현재 브랜치 ' + r.name : r.name
}

function chipOf(r: Ref, lane: string, short: boolean): { cls: string; shown: string } {
  if (r.kind === 'head') return { cls: 'is-head', shown: 'HEAD' }
  if (r.kind === 'tag') return { cls: 'is-tag', shown: r.name }
  if (r.kind === 'remote') return { cls: 'is-remote ' + lane, shown: r.name }
  if (r.current) return { cls: 'is-head', shown: short ? r.name : 'HEAD → ' + r.name }
  return { cls: 'is-branch ' + lane, shown: r.name }
}

export interface RefChipsProps {
  c: LogCommit
  /** The names shown; past it they are counted. */
  max?: number
  /** Where there is little room: the branch HEAD is on by its name alone, its fill saying whose it is. */
  short?: boolean
}

export function RefChips({ c, max = 3, short = false }: RefChipsProps) {
  if (!c.refs.length) return null
  const lane = 'lane-' + tone(c.color)
  const shown = c.refs.length > max ? c.refs.slice(0, max) : c.refs
  const rest = c.refs.slice(shown.length)
  return (
    <span class="gr-chips">
      {shown.map((r, i) => {
        const { cls, shown: text } = chipOf(r, lane, short)
        // The spaces keep the names apart when read out; the flex box drops them from the layout.
        return (
          <Fragment key={r.kind + ':' + r.name}>
            {i > 0 && ' '}
            <span class={'gr-chip ' + cls} title={refText(r)}>
              {r.kind === 'tag' && <Icon name="tag" size={11} />}
              <span class="gr-chip-name" aria-hidden="true">
                {text}
              </span>
              <span class="sr-only">{refText(r)}</span>
            </span>
          </Fragment>
        )
      })}
      {rest.length > 0 && (
        <>
          {' '}
          <span class="gr-chip is-more" title={rest.map(refText).join(', ')}>
            <span aria-hidden="true">+{rest.length}</span>
            <span class="sr-only">이름표 {rest.length}개 더</span>
          </span>
        </>
      )}
    </span>
  )
}
