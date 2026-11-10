// What jsdom leaves out and the components use.

import { FakeCloseWatcher } from './closewatcher'

// The back key closes a menu through a CloseWatcher, as in Chrome
// (lib/backstack.ts); a test of the other path takes it away.
if (!('CloseWatcher' in globalThis)) Object.assign(globalThis, { CloseWatcher: FakeCloseWatcher })

// <dialog> is there without showModal and close. A modal dialog takes the
// focus as a browser gives it: to its autofocus element, else to itself.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
    const first = this.querySelector<HTMLElement>('[autofocus]')
    if (first) first.focus()
    else {
      if (!this.hasAttribute('tabindex')) this.tabIndex = -1
      this.focus()
    }
  }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement, value?: string) {
    if (!this.open) return
    this.removeAttribute('open')
    if (value !== undefined) this.returnValue = value
    this.dispatchEvent(new Event('close'))
  }
}
