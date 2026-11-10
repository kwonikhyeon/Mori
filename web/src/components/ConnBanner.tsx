import { connBanner } from '../lib/health'
import { useHost } from '../lib/scope'
import { Icon } from './Icon'

/** What is wrong with the server or the core of the host shown, above the content. */
export function ConnBanner({ class: cls = '' }: { class?: string }) {
  const h = useHost()
  const b = connBanner(h.conn.value, h.core.value)
  return (
    <div class={cls} role="status" aria-live="polite">
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
