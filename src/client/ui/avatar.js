/**
 * AgentAvatar: the approved mascot (or a neutral grey mark), a separate status
 * dot and an optional Task Board state chip.
 *
 * Client module concatenated into the browser artifact by
 * scripts/build-client.mjs: everything here is global to the bundle. It uses
 * React.createElement only — no JSX and no HTML string sink: an SVG data URI is
 * only ever assigned to an `<img>` `src`. The role never carries a status
 * colour: the dot is a distinct element driven by `data-tone`.
 *
 * The wrapper owns the accessible name (`role="img"` + composed aria-label);
 * the `<img>` is decorative (`alt=""`). `decorative` renders `aria-hidden`.
 * Size flows to CSS through the `--dab-avatar-size` custom property. There is no
 * animation by default; any pulse a stylesheet adds must be disabled under
 * `prefers-reduced-motion` (styles.js owns that rule).
 *
 * @module dsh-agent-board/client/ui/avatar
 */

/** Injected data-URI map. The bundle defines AGENT_BOT_ASSETS before this file. */
function dabAvatarSources(props) {
  if (Object.prototype.hasOwnProperty.call(props, 'sources')) return props.sources ?? null
  if (typeof AGENT_BOT_ASSETS !== 'undefined') return AGENT_BOT_ASSETS
  return null
}

/**
 * Neutral grey identity mark used when the role is unknown or the asset source
 * is missing. Deliberately NOT one of the 15 mascot silhouettes: a plain person
 * glyph, so an unknown agent is never given a guessed role.
 */
function dabAvatarGenericMark(h) {
  return h('svg', {
    className: 'dab-avatar-generic',
    viewBox: '0 0 24 24',
    width: '60%',
    height: '60%',
    'aria-hidden': 'true',
    focusable: 'false',
  },
  h('circle', { key: 'head', cx: 12, cy: 8.5, r: 3.6, fill: '#7E8B9C' }),
  h('path', {
    key: 'body',
    d: 'M4.6 20.2c1.2-4.2 4.1-6.4 7.4-6.4s6.2 2.2 7.4 6.4',
    fill: 'none',
    stroke: '#7E8B9C',
    strokeWidth: 2.4,
    strokeLinecap: 'round',
  }))
}

/** Compose the accessible name from the pure model's structured parts. */
function dabAvatarAltText(model) {
  const parts = []
  for (const part of model.altParts) {
    const text = part.labelKey !== undefined ? dabT(part.labelKey) : part.text
    if (typeof text === 'string' && text.trim() !== '' && !parts.includes(text)) parts.push(text)
  }
  // No declared name and no readable status: name the element without guessing
  // a role. `agent` is a generic label owned by strings.js.
  if (parts.length === 0) parts.push(dabT('agent'))
  return parts.join(' — ')
}

/**
 * @param {object} props
 * @param {string|object|null} [props.role] declared role/name
 * @param {string|null} [props.name]
 * @param {string|null} [props.status] one of the board's EXISTING statuses
 * @param {string|null} [props.taskState] Task Board workflow state (separate)
 * @param {number} [props.size] rendered size in px (CSS variable)
 * @param {'full'|'compact'|'auto'} [props.variant]
 * @param {'crown'|'bolt'} [props.emblem]
 * @param {boolean} [props.selected]
 * @param {boolean} [props.decorative]
 * @returns {object} React element
 */
function DabAgentAvatar(props) {
  const h = React.createElement
  const model = dabAgentAvatarModel({
    role: props.role,
    name: props.name,
    status: props.status,
    taskState: props.taskState,
    size: props.size,
    variant: props.variant,
    emblem: props.emblem,
    sources: dabAvatarSources(props),
  })
  const decorative = props.decorative === true
  const selected = props.selected === true
  const label = dabAvatarAltText(model)

  const children = []
  if (model.src !== null) {
    children.push(h('img', {
      key: 'image',
      className: 'dab-avatar-img',
      src: model.src,
      alt: '',
      width: model.size,
      height: model.size,
      draggable: false,
      decoding: 'async',
    }))
  } else {
    children.push(h('span', { key: 'generic', className: 'dab-avatar-fallback' }, dabAvatarGenericMark(h)))
  }
  // The status dot is separate from the mascot: role colour is identity, the dot
  // is the runtime status tone. Its colour is a stylesheet decision (data-tone).
  children.push(h('span', {
    key: 'status',
    className: 'dab-avatar-dot',
    'data-tone': model.tone,
    title: dabT(model.toneLabelKey),
    'aria-hidden': 'true',
  }))
  if (model.taskTone !== null) {
    const taskLabel = dabT(model.taskToneLabelKey)
    children.push(h('span', {
      key: 'task',
      className: 'dab-avatar-task',
      'data-tone': model.taskTone,
      title: `${dabT('task')} · ${taskLabel}`,
    }, taskLabel))
  }

  const attributes = {
    className: 'dab-avatar',
    'data-role': model.roleId ?? 'generic',
    'data-tone': model.tone,
    'data-variant': model.variant,
    'data-selected': selected ? 'true' : 'false',
    'data-size': String(model.size),
    style: { '--dab-avatar-size': `${model.size}px` },
  }
  if (model.emblem !== null) attributes['data-emblem'] = model.emblem
  if (decorative) {
    attributes['aria-hidden'] = 'true'
  } else {
    attributes.role = 'img'
    attributes['aria-label'] = label
  }
  return h('span', attributes, children)
}
