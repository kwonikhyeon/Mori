// Asks before something that cannot be undone, in a modal <dialog>: the
// focus starts on 취소, and Escape, a press outside or the back key cancels.
import { useEffect, useId, useLayoutEffect, useRef } from 'preact/hooks'
import { useLayer } from './useLayer'

export interface ConfirmProps {
  open: boolean
  title: string
  text: string
  confirm: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function Confirm({ open, title, text, confirm, danger, busy, onConfirm, onCancel }: ConfirmProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  // While the action runs it cannot be called back: 취소 then would only hide what still happens.
  const cancel = () => void (busy || onCancel())
  useLayer(open, cancel, true)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    else if (!open && d.open) d.close()
  }, [open])
  // Asked something else while it is open, it starts again from 취소 before
  // another key can reach the button pressed, which may now do more.
  useLayoutEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>('[autofocus]')?.focus()
  }, [title])
  return (
    <dialog
      ref={ref}
      class="confirm"
      aria-labelledby={id + '-t'}
      aria-describedby={id + '-d'}
      onCancel={(e) => {
        e.preventDefault()
        cancel()
      }}
      onClick={(e) => {
        if (e.target === ref.current) cancel()
      }}
    >
      {open && (
        <div class="confirm-box">
          <h2 id={id + '-t'} class="confirm-title">{title}</h2>
          <p id={id + '-d'} class="confirm-text">{text}</p>
          <div class="confirm-actions">
            <button type="button" class="btn" autofocus aria-disabled={busy} onClick={cancel}>
              취소
            </button>
            <button type="button" class={danger ? 'btn btn-danger-fill' : 'btn btn-primary'} disabled={busy} onClick={onConfirm}>
              {confirm}
            </button>
          </div>
        </div>
      )}
    </dialog>
  )
}
