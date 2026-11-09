// A modal panel for a choice that takes more than a menu: from the bottom
// on a phone, in the middle on a PC. Like Confirm it is a <dialog>, so
// the focus stays inside and goes back where it was; Escape, a press
// outside and 닫기 close it.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { Icon } from './Icon'

export interface SheetProps {
  open: boolean
  /** The id SheetHead gives its title. */
  labelledBy: string
  onClose: () => void
  class?: string
  /** Made only while open, so each opening starts afresh. */
  children: ComponentChildren
}

export function Sheet({ open, labelledBy, onClose, class: cls, children }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null)
  // A press that starts on a field and ends outside is a text selection,
  // not a press outside.
  const outside = useRef(false)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    else if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      class={'sheet' + (cls ? ' ' + cls : '')}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onPointerDown={(e) => {
        outside.current = e.target === ref.current
      }}
      onClick={(e) => {
        if (e.target === ref.current && outside.current) onClose()
        outside.current = false
      }}
    >
      {open && <div class="sheet-box">{children}</div>}
    </dialog>
  )
}

export interface SheetHeadProps {
  id: string
  title: string
  onClose: () => void
  /** A step back inside the sheet, with what it goes back to. */
  back?: { label: string; onClick: () => void }
}

export function SheetHead({ id, title, onClose, back }: SheetHeadProps) {
  return (
    <header class={'sheet-head' + (back ? ' has-back' : '')}>
      {back && (
        <button type="button" class="btn btn-icon btn-ghost" aria-label={back.label} onClick={back.onClick}>
          <Icon name="back" size={20} />
        </button>
      )}
      <h2 id={id} class="sheet-title" tabIndex={-1}>
        {title}
      </h2>
      <button type="button" class="btn btn-icon btn-ghost" aria-label="닫기" onClick={onClose}>
        <Icon name="close" size={20} />
      </button>
    </header>
  )
}
