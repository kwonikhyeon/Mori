// Asks before something that cannot be undone, in a modal <dialog>: the
// focus starts on 취소, and Escape or a press outside cancels.
import { useEffect, useId, useRef } from 'preact/hooks'

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
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    else if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      class="confirm"
      aria-labelledby={id + '-t'}
      aria-describedby={id + '-d'}
      onCancel={(e) => {
        e.preventDefault()
        onCancel()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onCancel()
      }}
    >
      {open && (
        <div class="confirm-box">
          <h2 id={id + '-t'} class="confirm-title">{title}</h2>
          <p id={id + '-d'} class="confirm-text">{text}</p>
          <div class="confirm-actions">
            <button type="button" class="btn" autofocus onClick={onCancel}>
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
