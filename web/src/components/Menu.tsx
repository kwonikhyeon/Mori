// A button that opens a list of actions (the WAI-ARIA menu button): the
// arrows move between the items, Escape closes and gives the focus back,
// Tab and a press elsewhere close.
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { Icon, type IconName } from './Icon'

export interface MenuItem {
  label: string
  icon?: IconName
  danger?: boolean
  /** Makes the item a checkbox that says whether it is on. */
  checked?: boolean
  onSelect: () => void
}

export interface MenuProps {
  label: string
  items: MenuItem[]
  icon?: IconName
  iconSize?: number
  buttonClass?: string
}

export function Menu({ label, items, icon = 'more', iconSize = 20, buttonClass = 'btn btn-icon btn-ghost' }: MenuProps) {
  const [open, setOpen] = useState<'first' | 'last' | null>(null)
  const id = useId()
  const box = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const entries = () => [...(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]

  useEffect(() => {
    if (!open) return
    const all = entries()
    ;(open === 'last' ? all.at(-1) : all[0])?.focus()
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  const close = () => {
    setOpen(null)
    btn.current?.focus()
  }

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    setOpen(e.key === 'ArrowUp' ? 'last' : 'first')
  }

  const onListKey = (e: KeyboardEvent) => {
    const all = entries()
    const i = all.indexOf(document.activeElement as HTMLElement)
    let next: number
    switch (e.key) {
      case 'ArrowDown': next = (i + 1) % all.length; break
      case 'ArrowUp': next = (i - 1 + all.length) % all.length; break
      case 'Home': next = 0; break
      case 'End': next = all.length - 1; break
      case 'Escape':
        e.preventDefault()
        close()
        return
      case 'Tab':
        setOpen(null)
        return
      default:
        return
    }
    e.preventDefault()
    all[next]?.focus()
  }

  // The focus goes back first, so an item may move it on (a field, a dialog).
  const pick = (it: MenuItem) => {
    close()
    it.onSelect()
  }

  return (
    <div class="menu" ref={box}>
      <button
        ref={btn}
        type="button"
        class={buttonClass}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? setOpen(null) : setOpen('first'))}
        onKeyDown={onButtonKey}
      >
        <Icon name={icon} size={iconSize} />
      </button>
      {open && (
        <div id={id} ref={list} role="menu" aria-label={label} class="menu-list" onKeyDown={onListKey}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              tabIndex={-1}
              role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={it.checked}
              class={'menu-item' + (it.danger ? ' is-danger' : '')}
              onClick={() => pick(it)}
            >
              {it.icon && <Icon name={it.icon} size={18} />}
              <span class="menu-label">{it.label}</span>
              {it.checked && <Icon name="check" size={16} class="menu-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
