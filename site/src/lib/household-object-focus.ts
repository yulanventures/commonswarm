/** Native textarea focus can reveal its caret while leaving the control clipped.
 * Keep the whole keyboard focus boundary in the Lists pane without moving focus.
 */
export function bindHouseholdObjectFocus(root: HTMLElement): () => void {
  const view = root.ownerDocument.defaultView;
  let frame = 0;
  const reveal = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches('button, input, textarea, select, a[href]') ||
        !target.matches(':focus-visible') || !view) return;
    const pane = root.closest<HTMLElement>('live-dashboard[data-kylon-shell] .dashboard__objects-view');
    if (!pane) return;
    view.cancelAnimationFrame(frame);
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      if (!target.isConnected || !root.contains(target) || root.ownerDocument.activeElement !== target ||
          !target.getClientRects().length || !pane.getClientRects().length ||
          root.closest('.dashboard__objects-view') !== pane) return;
      const paint = target.matches('[data-hh-review]') ? target.closest('label') ?? target : target;
      let left = 0, top = 0, right = view.innerWidth, bottom = view.innerHeight;
      for (let parent = paint.parentElement; parent; parent = parent.parentElement) {
        const style = view.getComputedStyle(parent), box = parent.getBoundingClientRect();
        if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
          left = Math.max(left, box.left + parent.clientLeft);
          right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth);
        }
        if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
          top = Math.max(top, box.top + parent.clientTop);
          bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight);
        }
      }
      // The Lists skin paints a 2px outline with a 2px offset; retain 1px spare.
      const box = paint.getBoundingClientRect(), gap = 5;
      const x = box.width + gap * 2 > right - left ? 0 :
        box.left - gap < left ? box.left - gap - left : Math.max(0, box.right + gap - right);
      const y = box.height + gap * 2 > bottom - top ? 0 :
        box.top - gap < top ? box.top - gap - top : Math.max(0, box.bottom + gap - bottom);
      if (x) pane.scrollLeft += x;
      if (y) pane.scrollTop += y;
    });
  };
  root.addEventListener('focusin', reveal);
  return () => { if (view) view.cancelAnimationFrame(frame); root.removeEventListener('focusin', reveal); };
}
