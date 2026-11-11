/**
 * Pointer/keyboard arbitration for agent cards (pure, timer-injected).
 *
 *   single click  -> after `delay` ms without a second click: onSelect(id)
 *   double click  -> cancels the pending single action, onOpen(id) exactly once
 *   Enter         -> onOpen(id)        Space -> onSelect(id)
 *
 * A second `open` for the same id inside `openGuardMs` is dropped, so a
 * dblclick event racing a keyboard Enter or a duplicated dblclick never opens
 * the session twice.
 *
 * @module dsh-agent-board/board/interaction
 */

export const CLICK_DELAY_MS = 250
export const OPEN_GUARD_MS = 800

export function createClickArbiter({
  onSelect,
  onOpen,
  delay = CLICK_DELAY_MS,
  openGuardMs = OPEN_GUARD_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = handle => clearTimeout(handle),
  now = () => Date.now(),
} = {}) {
  let pending = null
  let lastOpen = { id: null, at: -Infinity }

  const cancel = () => {
    if (pending !== null) {
      clearTimer(pending.handle)
      pending = null
    }
  }

  const open = id => {
    cancel()
    const at = now()
    if (lastOpen.id === id && at - lastOpen.at < openGuardMs) return false
    lastOpen = { id, at }
    onOpen?.(id)
    return true
  }

  return {
    click(id, detail = 1) {
      // detail >= 2 is the second click of a double click: wait for dblclick.
      if (detail >= 2) { cancel(); return }
      cancel()
      const handle = setTimer(() => {
        pending = null
        onSelect?.(id)
      }, delay)
      pending = { id, handle }
    },
    doubleClick(id) {
      return open(id)
    },
    /**
     * Immediate selection (inspection), without the single-click delay. Used by
     * the cockpit cards, whose keyboard contract is: Enter/Space = inspect, and
     * opening a session requires the explicit "open" button.
     */
    select(id) {
      cancel()
      onSelect?.(id)
    },
    key(id, key) {
      if (key === 'Enter') { open(id); return true }
      if (key === ' ' || key === 'Spacebar') { cancel(); onSelect?.(id); return true }
      return false
    },
    open,
    cancel,
    get pendingId() { return pending?.id ?? null },
  }
}
