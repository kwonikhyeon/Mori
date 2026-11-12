// A button that opens a list of actions (the WAI-ARIA menu button): the
// arrows move between the items, Escape and the back key close and give
// the focus back, Tab and a press elsewhere close. ContextMenu opens the
// same list at the pointer.
import { Fragment, type ComponentChildren, type JSX, type Ref } from 'preact'
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { Icon, type IconName } from './Icon'
import { useLayer } from './useLayer'

export interface MenuItem {
  /** Tells apart items of one label; the label unless given. */
  key?: string
  label: string
  icon?: IconName
  danger?: boolean
  /** Makes the item a checkbox that says whether it is on, or one choice of the radio items. */
  checked?: boolean
  /** The heading of the run of items it belongs to (astryx DropdownMenuGroup); a line parts the runs. */
  group?: string
  /** Starts a run with no heading: a line before it (astryx DropdownMenuDivider). */
  sep?: boolean
  onSelect: () => void
}

/** Items in runs of one group, in their order. */
function runs(items: MenuItem[]): { group?: string; items: MenuItem[] }[] {
  const out: { group?: string; items: MenuItem[] }[] = []
  for (const it of items) {
    const last = out.at(-1)
    if (last && last.group === it.group && !it.sep) last.items.push(it)
    else out.push({ group: it.group, items: [it] })
  }
  return out
}

export interface MenuListProps {
  id: string
  label: string
  items: MenuItem[]
  /** The checked items are one choice of many, not each on or off. */
  radio?: boolean
  /** The item the focus starts on. */
  start: 'first' | 'last'
  /** Closes it; back says whether the focus goes back to where the menu came from. */
  onClose: (back: boolean) => void
  class?: string
  style?: JSX.CSSProperties
  listRef?: Ref<HTMLDivElement>
}

/**
 * The open list of a menu, its button's (Menu) or the pointer's
 * (ContextMenu): the arrows move between the items, Escape and the back key
 * close it and give the focus back, Tab closes it.
 */
export function MenuList({ id, label, items, radio = false, start, onClose, class: cls = 'menu-list', style, listRef }: MenuListProps) {
  const own = useRef<HTMLDivElement | null>(null)
  const entries = () => [...(own.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]

  useEffect(() => {
    const all = entries()
    ;(start === 'last' ? all.at(-1) : all[0])?.focus()
  }, [])
  useLayer(true, () => onClose(true), false)

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
        onClose(true)
        return
      case 'Tab':
        onClose(false)
        return
      default:
        return
    }
    e.preventDefault()
    all[next]?.focus()
  }

  // The focus goes back first, so an item may move it on (a field, a dialog).
  const pick = (it: MenuItem) => {
    onClose(true)
    it.onSelect()
  }

  const row = (it: MenuItem) => (
    <button
      key={it.key ?? it.label}
      type="button"
      tabIndex={-1}
      role={it.checked === undefined ? 'menuitem' : radio ? 'menuitemradio' : 'menuitemcheckbox'}
      aria-checked={it.checked}
      class={'menu-item' + (it.danger ? ' is-danger' : '')}
      onClick={() => pick(it)}
    >
      {it.icon && <Icon name={it.icon} size={18} />}
      <span class="menu-label">{it.label}</span>
      {it.checked && <Icon name="check" size={16} class="menu-check" />}
    </button>
  )

  return (
    <div
      id={id}
      ref={(el) => {
        own.current = el
        if (typeof listRef === 'function') listRef(el)
        else if (listRef) listRef.current = el
      }}
      role="menu"
      aria-label={label}
      class={cls}
      style={style}
      onKeyDown={onListKey}
    >
      {/* A titled run is a group its heading names; the heading and the line are no stops for the arrows. */}
      {runs(items).map((r, i) => (
        <Fragment key={`${i}:${r.group ?? ''}`}>
          {i > 0 && <div role="separator" class="menu-sep" />}
          {r.group ? (
            <div role="group" aria-labelledby={`${id}-g${i}`} class="menu-group">
              <div id={`${id}-g${i}`} class="menu-heading">
                {r.group}
              </div>
              {r.items.map(row)}
            </div>
          ) : (
            r.items.map(row)
          )}
        </Fragment>
      ))}
    </div>
  )
}

export interface MenuProps {
  label: string
  items: MenuItem[]
  icon?: IconName
  iconSize?: number
  buttonClass?: string
  /** What the button shows in place of the icon; label still names it. */
  trigger?: ComponentChildren
  /** The checked items are one choice of many, not each on or off. */
  radio?: boolean
}

export function Menu({ label, items, icon = 'more', iconSize = 20, buttonClass = 'btn btn-icon btn-ghost', trigger, radio = false }: MenuProps) {
  const [open, setOpen] = useState<'first' | 'last' | null>(null)
  const id = useId()
  const box = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  const close = (back: boolean) => {
    setOpen(null)
    if (back) btn.current?.focus()
  }

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    setOpen(e.key === 'ArrowUp' ? 'last' : 'first')
  }

  return (
    <div class="menu" ref={box}>
      <button
        ref={btn}
        type="button"
        class={buttonClass}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={!!open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? setOpen(null) : setOpen('first'))}
        onKeyDown={onButtonKey}
      >
        {trigger ?? <Icon name={icon} size={iconSize} />}
      </button>
      {open && <MenuList id={id} label={label} items={items} radio={radio} start={open} onClose={close} />}
    </div>
  )
}
