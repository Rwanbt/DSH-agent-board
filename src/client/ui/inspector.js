/**
 * Agent inspector shell: a RIGHT-SIDE DRAWER on a wide panel and a BOTTOM SHEET
 * on a narrow one.
 *
 * The content stays `DabAgentPreview` (ui/preview.js): the same facts, the same
 * "open session" action, the same acknowledgement semantics. This module only
 * owns presentation and focus: it overlays the grid instead of shrinking it,
 * traps Tab, closes on Escape and on the scrim, and restores focus to the card
 * that opened it. It never navigates by itself.
 *
 * @module dsh-agent-board/client/ui/inspector
 */

const DAB_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function DabInspector({ node, parent, role, taskState, onOpen, onSelect, onClose, openError, onDismiss, dismissed, narrow }) {
  const h = React.createElement
  const panelRef = React.useRef(null)
  const restoreRef = React.useRef(null)
  const closeRef = React.useRef(onClose)
  closeRef.current = onClose

  React.useEffect(() => {
    restoreRef.current = typeof document !== 'undefined' ? document.activeElement : null
    const panel = panelRef.current
    const first = panel?.querySelector(DAB_FOCUSABLE)
    // Defer one frame: the panel is mounted, the browser has laid it out.
    const handle = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => { try { first?.focus?.({ preventScroll: true }) } catch { first?.focus?.() } })
      : null
    const onKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current?.()
        return
      }
      if (event.key !== 'Tab' || panel === null || panel === undefined) return
      const items = [...panel.querySelectorAll(DAB_FOCUSABLE)].filter(element => element.offsetParent !== null || element === document.activeElement)
      if (items.length === 0) return
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === firstItem || !panel.contains(document.activeElement))) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && (document.activeElement === lastItem || !panel.contains(document.activeElement))) {
        event.preventDefault()
        firstItem.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (handle !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
      const back = restoreRef.current
      if (back !== null && back !== undefined && back.isConnected !== false && typeof back.focus === 'function') {
        try { back.focus({ preventScroll: true }) } catch { try { back.focus() } catch { /* detached */ } }
      } else {
        // The inspected card acknowledged itself out of the active filter: focus
        // the nearest remaining card (then a filter chip, then the search) instead
        // of dropping focus on <body>. Order matters: querySelector with a list
        // would return whichever control comes first in the document.
        const fallback = document.querySelector('.dab-gcard') ?? document.querySelector('.dab-chip-btn') ?? document.querySelector('.dab-search input')
        try { fallback?.focus?.({ preventScroll: true }) } catch { /* headless */ }
      }
    }
    // Mount-only: the identity of the callbacks must never re-run the focus dance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return h('div', { className: 'dab-insp-overlay', 'data-narrow': narrow === true ? 'true' : 'false' },
    h('div', { className: 'dab-insp-scrim', 'aria-hidden': 'true', onClick: () => closeRef.current?.() }),
    h('div', {
      className: 'dab-insp-panel',
      ref: panelRef,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': `${dabT('inspectorTitle')} — ${node.title}`,
      'data-inspector-for': node.id,
    },
    h('span', { className: 'dab-insp-grip', 'aria-hidden': 'true' }),
    h('div', { className: 'dab-insp-body' },
      h(DabAgentPreview, {
        node, parent, role, taskState, onOpen, onSelect, onClose, openError, onDismiss, dismissed,
      }))))
}
