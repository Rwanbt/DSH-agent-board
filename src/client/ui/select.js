/**
 * Themed dropdown shared by the toolbar, the Super Agent band and inspector.
 *
 * Native <select> popups are drawn by Chromium/the OS and cannot follow the
 * DSH look (radius, surface, coloured level dots). Options are tuples
 * [value, text, meta?]; meta.level draws the level dot, meta.hint is the
 * tooltip, and meta.describe shows it as a second line.
 *
 * Concatenated into the browser artifact by scripts/build-client.mjs.
 *
 * @module dsh-agent-board/client/ui/select
 */

/** Themed dropdown (the native <select> popup cannot follow the plugin look). */
function DabSelect({ label, value, options, onChange, title, disabled, style, className }) {
  const h = React.createElement
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const rootRef = React.useRef(null)
  const listRef = React.useRef(null)
  const current = options.find(([optionValue]) => optionValue === value) ?? options[0]
  // HTML ids must not contain spaces: the translated label ("État Task Board")
  // would break aria-activedescendant.
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'select'
  React.useEffect(() => {
    if (!open) return undefined
    const close = event => { if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    listRef.current?.focus()
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  const show = () => { setActive(Math.max(0, options.findIndex(([optionValue]) => optionValue === value))); setOpen(true) }
  const pick = index => { const option = options[index]; setOpen(false); rootRef.current?.querySelector('button')?.focus(); if (option && option[0] !== value) onChange(option[0]) }
  const onListKey = event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(options.length - 1, index + 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)) }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0) }
    else if (event.key === 'End') { event.preventDefault(); setActive(options.length - 1) }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(active) }
    else if (event.key === 'Escape' || event.key === 'Tab') { event.stopPropagation(); setOpen(false); if (event.key === 'Escape') rootRef.current?.querySelector('button')?.focus() }
  }
  const dot = meta => (typeof meta?.level === 'string' ? h('span', { className: 'dab-level-dot', 'data-level': meta.level, 'aria-hidden': 'true' }) : null)
  return h('div', { className: `dab-dd${className ? ` ${className}` : ''}`, ref: rootRef, style, 'data-value': value ?? '' },
    h('button', {
      type: 'button', className: 'dab-select', 'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-label': `${label} : ${current?.[1] ?? ''}`, title: title ?? current?.[2]?.hint ?? label, disabled,
      onClick: () => (open ? setOpen(false) : show()),
      onKeyDown: event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show() } },
    }, dot(current?.[2]), h('span', { className: 'dab-dd-text' }, current?.[1] ?? '')),
    // The list stays in the DOM while closed (hidden): assistive tech and tests
    // can read the options without opening the popover.
    h('ul', { className: 'dab-dd-pop', role: 'listbox', 'aria-label': label, tabIndex: -1, ref: listRef, onKeyDown: onListKey, hidden: !open, 'aria-activedescendant': open ? `dab-opt-${slug}-${active}` : undefined },
        options.map(([optionValue, text, meta], index) => h('li', {
          key: optionValue, id: `dab-opt-${slug}-${index}`, role: 'option', className: 'dab-dd-opt', 'aria-selected': optionValue === value, 'data-active': index === active,
          title: meta?.hint, 'data-value': optionValue,
          onPointerEnter: () => setActive(index), onClick: () => pick(index),
        }, dot(meta), h('span', { className: 'dab-dd-opt-body' }, h('span', { className: 'dab-dd-text' }, text),
          typeof meta?.hint === 'string' && meta.describe === true ? h('span', { className: 'dab-dd-hint' }, meta.hint) : null), optionValue === value ? h('span', { className: 'dab-dd-check', 'aria-hidden': 'true' }, '✓') : null))))
}

/** Level options: coloured dot + name + one-line description. */
function dabLevelOptions() {
  return DAB_AUTONOMY_LEVELS.map(level => [level, dabLevelLabel(level), { level, hint: dabLevelHint(level), describe: true }])
}
