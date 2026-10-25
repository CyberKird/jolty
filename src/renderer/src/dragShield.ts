/**
 * A transparent layer over the whole window for the length of a drag. It gives the drag its cursor and keeps
 * hover effects and text selection out of the page, without restyling every element (the old `.resizing *`
 * rules made the browser recalculate the whole page when a drag started and again when it ended).
 * Returns the function that removes it.
 */
export function dragShield(cursor: 'col-resize' | 'row-resize'): () => void {
  const el = document.createElement('div')
  el.style.cssText = `position:fixed;inset:0;z-index:2147483647;cursor:${cursor}`
  document.body.appendChild(el)
  return () => el.remove()
}
