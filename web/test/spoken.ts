/** What is read out of an element: without what is hidden from screen readers. */
export function spoken(el: Element): string {
  const copy = el.cloneNode(true) as Element
  for (const h of copy.querySelectorAll('[aria-hidden="true"]')) h.remove()
  return copy.textContent!.replace(/\s+/g, ' ').trim()
}
