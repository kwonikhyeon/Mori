import { connBanner } from '../lib/health'
import { useHost } from '../lib/scope'
import { Icon } from './Icon'

/**
 * What is wrong with the host shown, above the content: a linked host the hub
 * cannot reach (decision 164), else its server or its core. An unlinked host
 * says so in place of its screens.
 */
export function ConnBanner({ class: cls = '' }: { class?: string }) {
  const h = useHost()
  const problem = h.problem.value
  const b = problem ? null : connBanner(h.conn.value, h.core.value)
  return (
    <div class={cls} role="status" aria-live="polite">
      {problem === 'unreachable' && (
        <div class="banner banner-error banner-act">
          <Icon name="warning" size={16} class="banner-icon" />
          <span class="banner-text">
            <b>{h.name.value}에 닿지 못했습니다</b> · <span>마지막으로 본 목록입니다</span>
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
