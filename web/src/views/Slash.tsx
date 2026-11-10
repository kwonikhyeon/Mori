// The list of slash commands above the composer of a Claude Code terminal
// (spec §3 #197). It opens while a "/" at the start of the box is being
// typed, and a choice puts "/name " in the box: sending it stays the user's,
// as Enter in the box makes a new line and a command like /clear does not
// undo.

import type { JSX } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { HostApi } from '../lib/api'
import { commandsOf, insert, rank, recent, SHOWN, slashAt } from '../lib/slash'
import { errorText, toast } from '../lib/toast'
import type { CommandList, SlashCommand } from '../lib/types'

const keep = (e: Event) => e.preventDefault() // the box keeps the focus and the phone its keyboard

const SOURCE: Record<string, string> = { project: '프로젝트', user: '사용자', plugin: '플러그인' }

/** Where a command comes from, in a word; a built-in one says nothing, as most of the list is. */
export function sourceLabel(c: SlashCommand): string {
  if (c.source === 'builtin') return ''
  if (c.skill && c.source === 'project') return '프로젝트 스킬'
  if (c.skill && c.source === 'user') return '스킬'
  return SOURCE[c.source] ?? c.source
}

export interface SlashOptions {
  /** The terminal runs Claude Code. */
  on: boolean
  text: string
  /** Where the caret is; null when the box does not have the focus. */
  caret: number | null
  host: string
  addr: string
  api: HostApi
  /** The id of the list. */
  id: string
  /** Puts text in the box with the caret at caret. */
  apply: (text: string, caret: number) => void
}

export interface Slash {
  /** The list, or null while it is closed. */
  view: JSX.Element | null
  /** Takes a key of the box; true when the list used it. */
  onKeyDown: (e: KeyboardEvent) => boolean
  /** What the box tells a screen reader of the list. */
  aria: { 'aria-autocomplete'?: 'list'; 'aria-controls'?: string; 'aria-activedescendant'?: string }
}

type Got = { list: CommandList } | { error: string }

export function useSlash({ on, text, caret, host, addr, api, id, apply }: SlashOptions): Slash {
  const want = on && caret !== null ? slashAt(text, caret) : null
  // Esc closes the list until the text changes.
  const [dismissed, setDismissed] = useState<string | null>(null)
  const open = want !== null && dismissed !== text
  const typing = open ? want : null // what is typed, while the list is open
  const [got, setGot] = useState<Got | null>(null)
  const [sel, setSel] = useState({ q: '', i: 0 })

  useEffect(() => {
    if (!open) return
    let live = true
    commandsOf(host, addr, () => api.terminals.commands(addr)).then(
      (list) => live && setGot({ list }),
      (e: unknown) => live && setGot({ error: errorText(e) }),
    )
    return () => {
      live = false
    }
  }, [open, host, addr, api])

  const list = got && 'list' in got ? got.list : null
  const rows = typing && list ? rank(list.commands, typing.q, recent()) : []
  const shown = rows.slice(0, SHOWN)
  const at = want && sel.q === want.q ? Math.min(sel.i, Math.max(0, shown.length - 1)) : 0
  const option = (n: number) => `${id}-${n}`

  useEffect(() => {
    if (open && shown.length) document.getElementById(option(at))?.scrollIntoView?.({ block: 'nearest' })
  }, [open, at, want?.q])

  const choose = (c: SlashCommand) => {
    if (!want) return
    const r = insert(text, want.end, c.name)
    apply(r.text, r.caret)
    if (c.menu) toast(`/${c.name}: 보내면 터미널에 메뉴가 열립니다`)
  }

  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!typing || e.isComposing || e.keyCode === 229) return false
    if (e.key === 'Escape') {
      e.preventDefault()
      setDismissed(text)
      return true
    }
    if (!shown.length || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = shown.length
      setSel({ q: typing.q, i: (at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n })
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      choose(shown[at])
      return true
    }
    return false
  }

  if (!open) return { view: null, onKeyDown, aria: on ? { 'aria-autocomplete': 'list' } : {} }

  let note = ''
  if (!got) note = '명령 목록을 읽는 중…'
  else if ('error' in got) note = `명령 목록을 읽지 못했습니다: ${got.error}`
  else if (!rows.length) note = '맞는 명령이 없습니다'
  const view = (
    <div class="term-slash" onPointerDown={keep} onMouseDown={keep}>
      {shown.length > 0 && (
        <div class="term-slash-list" id={id} role="listbox" aria-label="슬래시 명령">
          {shown.map((c, n) => {
            const from = sourceLabel(c)
            return (
              <div
                key={c.name}
                id={option(n)}
                class="term-slash-row"
                role="option"
                aria-selected={n === at ? 'true' : 'false'}
                onClick={() => choose(c)}
              >
                <span class="term-slash-head">
                  <b class="term-slash-name">/{c.name}</b>
                  {c.aliases?.length ? <span class="term-slash-alias">({c.aliases.map((a) => '/' + a).join(' ')})</span> : null}
                  {c.hint && <span class="term-slash-hint">{c.hint}</span>}
                  {(c.menu || from) && (
                    <span class="term-slash-src">
                      {c.menu && <span class="term-slash-menu">메뉴</span>}
                      {from}
                    </span>
                  )}
                </span>
                {c.desc && <span class="term-slash-desc">{c.desc}</span>}
              </div>
            )
          })}
        </div>
      )}
      {note && <p class="term-slash-note">{note}</p>}
      {rows.length > shown.length && <p class="term-slash-note">{rows.length - shown.length}개 더 — 더 적어서 좁히세요</p>}
      {list?.partial && <p class="term-slash-note">일부만 읽었습니다 — 여기 없는 명령도 쓸 수 있습니다</p>}
    </div>
  )
  return {
    view,
    onKeyDown,
    aria: {
      'aria-autocomplete': 'list',
      'aria-controls': shown.length ? id : undefined,
      'aria-activedescendant': shown.length ? option(at) : undefined,
    },
  }
}
