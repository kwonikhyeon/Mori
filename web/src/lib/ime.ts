// ⌘/Ctrl+Enter sends a field (spec §3 #180), also on a syllable still being
// composed. A Korean IME holds the last syllable until its composition ends,
// so the key comes with isComposing or keyCode 229, and sending then would
// leave that syllable out. The press is remembered and the send runs once the
// composition has ended, if that comes soon: a compositionend much later is
// something else. Safari ends the composition before the keydown, so a press
// right after an end sends as well.

import { useMemo, useRef } from 'preact/hooks'

/** How long after the press the end of its composition may come. */
const SOON = 1000
/** How long before the press an end counts as the press's own (Safari). */
const JUST = 50

type Key = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'isComposing' | 'keyCode'>

/** What a keydown means to a field that sends with ⌘/Ctrl+Enter. */
export function chordKey(e: Key): 'send' | 'later' | null {
  const enter = e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter'
  if (!enter || !(e.metaKey || e.ctrlKey)) return null
  return e.isComposing || e.keyCode === 229 ? 'later' : 'send'
}

export type Field = HTMLTextAreaElement | HTMLInputElement

export interface ChordSubmit {
  onKeyDown: (e: KeyboardEvent) => void
  onCompositionEnd: (e: CompositionEvent) => void
}

/** The handlers of a field that sends with ⌘/Ctrl+Enter; send reads the field when it runs. */
export function chordSubmit(send: (field: Field) => void, now: () => number = Date.now): ChordSubmit {
  let pressed = -Infinity
  let ended = -Infinity
  let field: Field | null = null
  // after the input event that puts the syllable in
  const soon = () => setTimeout(() => field && send(field), 0)
  return {
    onKeyDown(e) {
      const k = chordKey(e)
      if (!k) return
      field = e.currentTarget as Field
      if (k === 'send') {
        e.preventDefault()
        send(field)
      } else if (now() - ended <= JUST) {
        ended = -Infinity
        soon()
      } else {
        pressed = now()
      }
    },
    onCompositionEnd(e) {
      if (now() - pressed > SOON) {
        ended = now()
        return
      }
      field = e.currentTarget as Field
      pressed = ended = -Infinity
      soon()
    },
  }
}

/** chordSubmit for a component: send is the one of the newest render. */
export function useChordSubmit(send: (field: Field) => void): ChordSubmit {
  const latest = useRef(send)
  latest.current = send
  return useMemo(() => chordSubmit((f) => latest.current(f)), [])
}
