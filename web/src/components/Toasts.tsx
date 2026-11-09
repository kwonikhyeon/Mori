import { dismiss, toasts } from '../lib/toast'
import { Icon } from './Icon'

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast toast-${t.kind}`}>
          <span class="toast-text">{t.text}</span>
          <button type="button" class="toast-close" aria-label="알림 닫기" onClick={() => dismiss(t.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
