import { connBanner } from '../lib/health'
import { useHost } from '../lib/scope'
import { Icon } from './Icon'

interface Props {
  class?: string
  /** A list of the host is shown below, greyed while the hub cannot reach it. */
  list?: boolean
}

/**
 * What is wrong with the host shown, above the content: a linked host the hub
 * cannot reach (decision 164), else its server or its core. An unlinked host
 * says so in place of its screens.
 */
export function ConnBanner({ class: cls = '', list = false }: Props) {
  const h = useHost()
  const problem = h.problem.value
  const b = problem ? null : connBanner(h.conn.value, h.core.value)
  const why = !list ? '다시 연결하는 중입니다' : h.ready.value ? '마지막으로 본 목록입니다' : '아직 받은 목록이 없습니다'
  return (
    <div class={cls} role="status" aria-live="polite">
      {problem === 'unreachable' && (
        <div class="banner banner-error banner-act">
          <Icon name="warning" size={16} class="banner-icon" />
          <span class="banner-text">
            <b>{h.name.value}에 닿지 못했습니다</b> ·{' '}
            <span>{why}</span>
          </span>
          <button type="button" class="btn btn-sm" onClick={() => h.retry()}>
            다시 시도
          </button>
        </div>
      )}
      {b && (
        <div class={`banner banner-${b.kind}`}>
          <Icon name={b.kind === 'error' ? 'warning' : 'refresh'} size={16} class={b.kind === 'error' ? 'banner-icon' : 'banner-icon spin'} />
          <span class="banner-text">
            <b>{b.title}</b> <span>{b.detail}</span>
          </span>
        </div>
      )}
    </div>
  )
}
