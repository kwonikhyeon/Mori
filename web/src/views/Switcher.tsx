// 세션 이동 (spec §3 #198): ⌘P or Ctrl+P, or the PC header's button, opens
// every session of the hosts the page can reach, to open one by a part of its
// name, its program, its folder or its host.

import { useEffect, useId, useState } from 'preact/hooks'
import { Chip } from '../components/Chip'
import { Sheet, SheetHead } from '../components/Sheet'
import { now } from '../lib/clock'
import { chip } from '../lib/format'
import { isApple } from '../lib/platform'
import { href, route } from '../lib/router'
import { allScopes } from '../lib/scope'
import { closeSwitcher, entriesOf, filterEntries, isAt, spotOf, switcherOpen, type Entry } from '../lib/switcher'
import './switcher.css'

/** Kept out of the host's frame, so switching hosts does not make it again; a new screen closes it. */
export function Switcher() {
  const id = useId()
  const at = href(route.value)
  useEffect(() => {
    closeSwitcher()
  }, [at])
  return (
    <Sheet open={switcherOpen.value} labelledBy={id} onClose={closeSwitcher} class="qs">
      <SwitchList id={id} />
    </Sheet>
  )
}

const keep = (e: Event) => e.preventDefault() // the field keeps the focus

function SwitchList({ id }: { id: string }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<{ q: string; i: number } | null>(null)
  const r = route.value
  const here = spotOf(r)
  const all = entriesOf(allScopes.value, now.value)
  const shown = filterEntries(all, q)
  // The first session that is not the one on the screen.
  const first = Math.max(0, shown.findIndex((e) => !isAt(e, here)))
  const i = sel && sel.q === q ? Math.min(sel.i, shown.length - 1) : first
  const list = `${id}-list`
  const option = (n: number) => `${id}-${n}`

  useEffect(() => {
    if (shown.length) document.getElementById(option(i))?.scrollIntoView?.({ block: 'nearest' })
  }, [i, q])

  const open = (e: Entry) => {
    closeSwitcher()
    e.s.go({ name: 'terminal', addr: e.t.address, git: r.name === 'terminal' && r.git })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229 || e.altKey || e.ctrlKey || e.metaKey || !shown.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = shown.length
      setSel({ q, i: (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n })
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      open(shown[i])
    }
  }

  const apple = isApple()
  return (
    <>
      <SheetHead id={id} title="세션 이동" onClose={closeSwitcher} />
      <div class="qs-field">
        <input
          class="input qs-input"
          type="text"
          role="combobox"
          aria-label="세션 찾기"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={list}
          aria-activedescendant={shown.length ? option(i) : undefined}
          placeholder="이름, 프로그램, 폴더, 호스트"
          autofocus
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          enterkeyhint="go"
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div class="sheet-body qs-body">
        {shown.length ? (
          <div id={list} role="listbox" aria-label="세션" class="qs-list" onMouseDown={keep}>
            {shown.map((e, n) => (
              <div
                key={e.s.id + '\u0000' + e.t.address}
                id={option(n)}
                role="option"
                aria-selected={n === i ? 'true' : 'false'}
                class={'qs-row' + (e.group === 'finished' ? ' is-finished' : '')}
                onClick={() => open(e)}
              >
                <span class="qs-main">
                  <span class="qs-title">{e.title}</span>
                  <span class="qs-sub">{e.sub}</span>
                </span>
                <span class="qs-end">
                  {isAt(e, here) && <span class="qs-here">보는 중</span>}
                  <Chip info={chip(e.t)} />
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p class="qs-note" role="status">
            {all.length ? '맞는 세션이 없습니다' : '열 수 있는 세션이 없습니다'}
          </p>
        )}
      </div>
      <footer class="qs-foot" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> 고르기
        </span>
        <span>
          <kbd>{apple ? '↵' : 'Enter'}</kbd> 열기
        </span>
        <span>
          <kbd>{apple ? '⌥⇧↓' : 'Alt+Shift+↓'}</kbd> 다음 승인 대기
        </span>
      </footer>
    </>
  )
}
