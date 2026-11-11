import { dismiss, toasts } from '../lib/toast'
import { Icon } from './Icon'

// The stack is no live region, as astryx's toast viewport is none: a region
// made with its words is not read everywhere, so lib/toast.ts speaks each
// note through lib/announce.ts. While it holds notes it is a landmark, so a
// screen reader can find the close buttons.
export function Toasts() {
  const list = toasts.value
  return (
    <div class="toasts" role={list.length ? 'region' : undefined} aria-label={list.length ? '알림' : undefined}>
      {list.map((t) => (
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
