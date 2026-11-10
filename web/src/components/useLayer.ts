// A menu, a sheet or a confirm on top of the screen: the back key closes it
// before it leaves the screen (spec §3 #199, lib/backstack.ts).
import { useEffect, useRef } from 'preact/hooks'
import { openLayer } from '../lib/backstack'

/** While open, the back key calls close; dialog: a modal <dialog>, which a browser with CloseWatcher closes itself. */
export function useLayer(open: boolean, close: () => void, dialog: boolean): void {
  const fn = useRef(close)
  fn.current = close
  useEffect(() => (open ? openLayer(() => fn.current(), dialog) : undefined), [open])
}
