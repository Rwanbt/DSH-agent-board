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

// ============================================================ Super Agent cockpit
/**
 * Inspector tabs of the Super Agent (contract §7). They are PRESENTATIONAL:
 * every value is read from the v2 payload, every missing field renders an
 * explicit "non disponible" with its reason, and every mutation leaves through
 * a callback (the store owns the HTTP routes). No write is ever implied by a
 * render; the dry-run is a GET and renders its result without applying it.
 */

const DAB_SUPER_TABS = Object.freeze([
  ['overview', 'superTabOverview'],
  ['projects', 'superTabProjects'],
  ['directives', 'superTabDirectives'],
  ['settings', 'superTabSettings'],
])

const DAB_SUPER_LIST_LIMIT = 10
const DAB_SUPER_PROJECT_LIMIT = 20

function dabSaObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function dabSaList(value) {
  return Array.isArray(value) ? value.filter(entry => entry !== null && typeof entry === 'object') : []
}

function dabSaBound(list, limit = DAB_SUPER_LIST_LIMIT) {
  const rows = Array.isArray(list) ? list : []
  const bound = Number.isFinite(limit) && limit > 0 ? limit : DAB_SUPER_LIST_LIMIT
  return { shown: rows.slice(0, bound), extra: Math.max(0, rows.length - bound) }
}

function dabSaExtraNode(h, extra) {
  return extra > 0 ? h('div', { className: 'dab-sa-more' }, `+${extra}`) : null
}

function dabSaReason(h, reason, className = 'dab-sa-unavailable') {
  return h('div', { className, role: 'note' },
    h('span', { className: 'dab-sa-unavailable-label' }, dabT('superNotAvailable')),
    typeof reason === 'string' && reason !== '' ? h('span', { className: 'dab-sa-unavailable-reason' }, ` — ${reason}`) : null)
}

function dabSaSection(h, key, title, ...children) {
  return h('section', { key, className: 'dab-sa-section', 'data-section': key },
    h('h3', { className: 'dab-sa-section-title' }, title),
    ...children.filter(child => child !== null && child !== undefined && child !== false))
}

function dabSaMoment(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return null
  try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') } catch { return null }
}

function dabAllProjectsConfirmValid(text) {
  return String(text ?? '').trim() === 'ALL_PROJECTS'
}

/** All-projects confirmation is a pure component so it can be tested alone. */
function DabAllProjectsConfirm({ confirmText = '', onChange, onConfirm, onCancel, busy }) {
  const h = React.createElement
  const valid = dabAllProjectsConfirmValid(confirmText)
  return h('div', { className: 'dab-sa-confirm', role: 'group', 'aria-label': dabT('superAllProjectsConfirmTitle') },
    h('div', { className: 'dab-sa-confirm-hint' }, dabT('superAllProjectsConfirmHint')),
    h('label', { className: 'dab-sa-field' },
      h('span', { className: 'dab-sa-field-label' }, dabT('superAllProjectsConfirmPlaceholder')),
      h('input', {
        className: 'dab-input dab-sa-confirm-input',
        type: 'text',
        value: confirmText,
        placeholder: 'ALL_PROJECTS',
        'aria-label': dabT('superAllProjectsConfirmPlaceholder'),
        onChange: event => onChange?.(event?.target?.value ?? ''),
      })),
    h('div', { className: 'dab-sa-confirm-actions' },
      h('button', {
        type: 'button', className: 'dab-btn', 'data-danger': 'true', 'data-testid': 'dab-all-projects-confirm',
        disabled: busy === true || !valid, onClick: () => { if (valid) onConfirm?.('ALL_PROJECTS') },
      }, dabT('superAllProjectsConfirm')),
      h('button', { type: 'button', className: 'dab-btn', 'data-variant': 'ghost', disabled: busy === true, onClick: onCancel }, dabT('cancel'))))
}

/** Decision inbox: only REAL pending decisions, never an implied answer. */
function DabSuperagentDecisions({ superagent, filter = 'decisions', onFilter, onAnswer, busy }) {
  const h = React.createElement
  const groups = dabDecisionGroups(superagent?.decisions)
  const active = filter === 'approvals' ? 'approvals' : 'decisions'
  const list = active === 'approvals' ? groups.approvals : groups.pending
  return h('div', { className: 'dab-sa-inbox', 'data-filter': active },
    h('div', { className: 'dab-sa-inbox-head' },
      h('h3', { className: 'dab-sa-section-title' }, dabT('superDecisions')),
      groups.pending.length > 0
        ? h('span', { className: 'dab-sa-decisions-count', 'aria-label': dabT('superDecisionsPending', { n: groups.pending.length }) }, String(groups.pending.length))
        : null),
    h('div', { className: 'dab-sa-filter', role: 'group', 'aria-label': dabT('superDecisionFilterLabel') },
      h('button', {
        type: 'button', className: 'dab-btn', 'data-filter': 'decisions',
        'aria-pressed': active === 'decisions' ? 'true' : 'false',
        onClick: () => onFilter?.('decisions'),
      }, `${dabT('superDecisionFilterDecisions')} (${groups.pending.length})`),
      h('button', {
        type: 'button', className: 'dab-btn', 'data-filter': 'approvals',
        'aria-pressed': active === 'approvals' ? 'true' : 'false',
        onClick: () => onFilter?.('approvals'),
      }, `${dabT('superDecisionFilterApprovals')} (${groups.approvals.length})`)),
    list.length === 0
      ? h('div', { className: 'dab-sa-empty' },
        h('div', null, active === 'approvals' ? dabT('superNoApproval') : dabT('superNoDecision')),
        h('div', { className: 'dab-muted' }, dabT('superDecisionSilence')))
      : h('ul', { className: 'dab-sa-decisions' }, list.map(decision => {
        const options = dabSaList(decision.options)
        const taskIds = Array.isArray(decision.taskIds) ? decision.taskIds.map(String) : []
        const scope = [typeof decision.projectId === 'string' && decision.projectId !== '' ? decision.projectId : null,
          taskIds.length > 0 ? taskIds.join(', ') : null].filter(Boolean).join(' · ')
        return h('li', {
          key: String(decision.id), className: 'dab-sa-decision',
          'data-kind': typeof decision.kind === 'string' ? decision.kind : 'unknown',
          'data-decision-id': String(decision.id),
        },
        h('div', { className: 'dab-sa-decision-head' },
          h('span', { className: 'dab-tag' }, String(decision.kind ?? '?')),
          h('span', { className: 'dab-sa-decision-title' }, String(decision.title ?? dabT('superNotAvailable')))),
        h('dl', { className: 'dab-sa-dl' },
          h('dt', null, dabT('superDecisionProposal')), h('dd', null, String(decision.context ?? decision.action ?? dabT('superNotAvailable'))),
          h('dt', null, dabT('superDecisionScope')), h('dd', null, scope === '' ? dabT('superNotAvailable') : scope),
          h('dt', null, dabT('superDecisionRisk')), h('dd', null, String(decision.risk ?? dabT('superNotAvailable'))),
          h('dt', null, dabT('superDecisionImpact')), h('dd', null, String(decision.impact ?? decision.expectedEffect ?? dabT('superNotAvailable'))),
          h('dt', null, dabT('superDecisionExpires')),
          h('dd', null, dabSaMoment(decision.expiresAt) ?? dabT('superDecisionNoExpiry'))),
        typeof decision.recommendation === 'string' && decision.recommendation !== ''
          ? h('div', { className: 'dab-sa-recommendation' }, `${dabT('superDecisionRecommendation')} : ${decision.recommendation}`)
          : null,
        options.length > 0
          ? h('div', { className: 'dab-sa-options', role: 'group', 'aria-label': dabT('superDecisionOptions') },
            options.map(option => h('button', {
              key: String(option.id), type: 'button', className: 'dab-btn dab-sa-option',
              'data-option-id': String(option.id),
              title: typeof option.effect === 'string' ? option.effect : undefined,
              disabled: busy === true,
              onClick: () => onAnswer?.(decision.id, option.id),
            }, String(option.label ?? option.id))))
          : dabSaReason(h, 'options_missing'))
      })),
    h('div', { className: 'dab-muted' }, dabT('superDecisionSilence')))
}

/** Vue d'ensemble: objective, steps, factual result, capabilities, incidents. */
function DabSuperagentOverview({ superagent, mandate, capabilities, host, context, onOpenDetail, onAnswer, decisionFilter, onDecisionFilter, busy }) {
  const h = React.createElement
  const facts = dabSuperagentFacts(superagent, mandate, context)
  const plan = facts.plan ?? {}
  const objectives = dabSaList(plan.objectives)
  const nextActions = dabSaList(plan.nextActions)
  const activity = facts.activity
  const steps = dabSaBound([...activity].reverse(), 6)
  const lastCycle = facts.lastCycle
  const incidents = []
  if (facts.runtime?.available === false && typeof facts.runtime.reason === 'string') incidents.push(`${dabT('superOverviewRuntime')} : ${facts.runtime.reason}`)
  if (lastCycle !== null && typeof lastCycle.outcome === 'string' && /refus|fail|error|blocked/i.test(lastCycle.outcome)) {
    incidents.push(`${lastCycle.outcome}${typeof lastCycle.reason === 'string' ? ` — ${lastCycle.reason}` : ''}`)
  }
  const urgent = facts.pendingDecisions.filter(decision => decision.urgency === 'urgent')
  if (urgent.length > 0) incidents.push(dabT('superOverviewUrgentIncident', { n: urgent.length }))
  for (const entry of activity.slice(-20)) {
    if (typeof entry.kind === 'string' && /incident|error|blocked/i.test(entry.kind)) incidents.push(String(entry.summary ?? entry.kind))
  }
  const recommendationRows = [
    ...nextActions.slice(0, 3).map(action => `${dabT('superOverviewNextAction')} : ${String(action.action ?? '?')}${typeof action.rationale === 'string' ? ` — ${action.rationale}` : ''}`),
    ...facts.pendingDecisions.slice(0, 2).map(decision => `${dabT('superOverviewDecision')} : ${String(decision.title ?? decision.id)}`),
  ]
  const journal = dabSaBound(activity.slice(-20), 4)

  return h('div', { className: 'dab-sa-tab dab-sa-overview' },
    dabSaSection(h, 'objective', dabT('superOverviewObjective'),
      objectives.length === 0
        ? (typeof plan.idleReason === 'string' && plan.idleReason !== ''
          ? h('div', { className: 'dab-muted' }, `${dabT('superNoObjective')} — ${plan.idleReason}`)
          : dabSaReason(h, facts.available ? 'objective_not_published' : 'superagent_not_published'))
        : h('ul', { className: 'dab-sa-list' }, dabSaBound(objectives, 2).shown.map(objective => h('li', { key: String(objective.id) },
          h('span', { className: 'dab-sa-list-title' }, String(objective.title ?? objective.id)),
          h('span', { className: 'dab-tag' }, String(objective.status ?? '?')),
          typeof objective.source === 'string' ? h('span', { className: 'dab-muted' }, ` · ${objective.source}`) : null)))),
    dabSaSection(h, 'steps', dabT('superOverviewSteps'),
      steps.shown.length === 0
        ? dabSaReason(h, facts.available ? 'activity_not_published' : 'superagent_not_published')
        : h('ol', { className: 'dab-sa-steps' }, steps.shown.map(entry => h('li', { key: `${entry.at}-${entry.kind}` },
          h('span', { className: 'dab-sa-step-time' }, dabSaMoment(entry.at) ?? ''), h('span', { className: 'dab-grow' }, String(entry.summary ?? entry.kind ?? '?')),
          typeof entry.kind === 'string' ? h('span', { className: 'dab-tag' }, entry.kind) : null))),
      dabSaExtraNode(h, steps.extra)),
    dabSaSection(h, 'result', dabT('superOverviewResult'),
      lastCycle === null
        ? h('div', { className: 'dab-muted' }, dabT('superNoCycle'))
        : h('dl', { className: 'dab-sa-dl' },
          h('dt', null, dabT('superOverviewOutcome')), h('dd', null, String(lastCycle.outcome ?? dabT('superNotAvailable'))),
          h('dt', null, dabT('superReason')), h('dd', null, String(lastCycle.reason ?? dabT('superNotAvailable'))),
          h('dt', null, dabT('superOverviewProposals')), h('dd', null, String(lastCycle.proposals ?? 0)),
          h('dt', null, dabT('superOverviewApplied')), h('dd', null, String(lastCycle.applied ?? 0)),
          h('dt', null, dabT('superOverviewAt')), h('dd', null, dabSaMoment(lastCycle.at) ?? dabT('superNotAvailable')),
          h('dt', null, dabT('superOverviewDuration')), h('dd', null, `${Number(lastCycle.durationMs) || 0} ms`))),
    dabSaSection(h, 'capabilities', dabT('superOverviewCapabilities'),
      dabCapabilityMatrix(h, capabilities, null, context)),
    dabSaSection(h, 'incidents', dabT('superOverviewIncidents'),
      incidents.length === 0
        ? h('div', { className: 'dab-muted' }, dabT('superNoIncidents'))
        : h('ul', { className: 'dab-sa-list dab-sa-incidents' }, incidents.slice(0, 5).map((text, index) => h('li', { key: `i-${index}` }, text)))),
    dabSaSection(h, 'recommendations', dabT('superOverviewRecommendations'),
      recommendationRows.length === 0
        ? h('div', { className: 'dab-muted' }, dabT('superNoRecommendations'))
        : h('ul', { className: 'dab-sa-list' }, recommendationRows.map((text, index) => h('li', { key: `r-${index}` }, text)))),
    dabSaSection(h, 'journal', dabT('superOverviewJournal'),
      journal.shown.length === 0
        ? h('div', { className: 'dab-muted' }, dabT('superNoJournal'))
        : h('ul', { className: 'dab-sa-journal' }, journal.shown.map(entry => h('li', { key: `${entry.at}-${entry.kind}` },
          h('span', { className: 'dab-sa-step-time' }, dabSaMoment(entry.at) ?? ''), String(entry.summary ?? entry.kind ?? '?')))),
      dabSaExtraNode(h, journal.extra)),
    h(DabSuperagentDecisions, { superagent, filter: decisionFilter, onFilter: onDecisionFilter, onAnswer, busy }),
    typeof onOpenDetail === 'function'
      ? h('button', { type: 'button', className: 'dab-btn dab-sa-open-detail', onClick: onOpenDetail }, dabT('superOpenDetail'))
      : null)
}

/** Projets: real portfolio, per-project policy, scope, Simuler (dry-run). */
function DabSuperagentProjects({
  superagent, mandate, host, context, dryRun, dryRunBusy, busy,
  onToggleProject, onSetProjectLevel, onSetProjectPriority, onConfirmAllProjects, onDryRun, scopeConfirmOpen,
}) {
  const h = React.createElement
  const [confirming, setConfirming] = React.useState(false)
  const [confirmText, setConfirmText] = React.useState('')
  const rows = dabProjectPolicyRows(host, superagent, mandate)
  const bound = dabSaBound(rows, DAB_SUPER_PROJECT_LIMIT)
  const scopeMode = typeof mandate?.scopeMode === 'string' ? mandate.scopeMode : null
  const selectedCount = rows.filter(row => row.selected).length
  const scopeLabel = scopeMode === 'all'
    ? dabT('superScopeAll')
    : scopeMode === 'selected' ? dabT('superScopeSelected', { n: selectedCount }) : dabT('superScopeNone')
  const confirmOpen = confirming || scopeConfirmOpen === true
  const dry = dabSaObject(dryRun)
  const dryUnavailable = dry !== null && typeof dry.unavailable === 'string' ? dry.unavailable : null
  const dryProjects = dabSaList(dry?.projects)
  const dryCandidates = dabSaList(dry?.candidates)
  const dryActions = dabSaList(dry?.actions)
  const dryBlocks = dabSaList(dry?.blocks)

  return h('div', { className: 'dab-sa-tab dab-sa-projects' },
    h('div', { className: 'dab-sa-scope-row' },
      h('span', { className: 'dab-sa-scope', 'data-scope': scopeMode ?? 'none' }, `${dabT('superScope')} : ${scopeLabel}`),
      h('button', {
        type: 'button', className: 'dab-btn dab-sa-all-projects',
        'aria-expanded': confirmOpen ? 'true' : 'false',
        onClick: () => setConfirming(value => !value),
      }, dabT('superAllProjects'))),
    confirmOpen
      ? h(DabAllProjectsConfirm, {
        confirmText,
        busy,
        onChange: value => setConfirmText(value),
        onCancel: () => { setConfirming(false); setConfirmText('') },
        onConfirm: text => onConfirmAllProjects?.(text),
      })
      : null,
    rows.length === 0
      ? dabSaReason(h, factsPortfolioReason(host, superagent))
      : h('ul', { className: 'dab-sa-projects-list' }, bound.shown.map(row => h('li', {
        key: row.id, className: 'dab-sa-project',
        'data-project-id': row.id, 'data-enabled': row.enabled ? 'true' : 'false', 'data-selected': row.selected ? 'true' : 'false',
      },
      h('div', { className: 'dab-sa-project-head' },
        h('span', { className: 'dab-sa-project-title' }, row.title),
        h('span', { className: 'dab-tag', 'data-scope': row.selected ? 'in' : 'out' }, row.selected ? dabT('superProjectInScope') : dabT('superProjectOutOfScope'))),
      h('div', { className: 'dab-sa-project-controls' },
        h('button', {
          type: 'button', className: 'dab-sa-toggle', role: 'switch',
          'aria-checked': row.enabled ? 'true' : 'false',
          'aria-label': `${row.enabled ? dabT('superProjectDisable') : dabT('superProjectEnable')} : ${row.title}`,
          onClick: () => onToggleProject?.(row.id, !row.enabled),
        }, row.enabled ? dabT('superProjectEnabled') : dabT('superProjectDisabled')),
        h('label', { className: 'dab-sa-field dab-sa-field-inline' },
          h('span', { className: 'dab-sa-field-label' }, dabT('superProjectLevel')),
          h('select', {
            className: 'dab-select dab-sa-level', value: row.level,
            'aria-label': `${dabT('superProjectLevel')} : ${row.title}`,
            onChange: event => onSetProjectLevel?.(row.id, event?.target?.value),
          }, DAB_AUTONOMY_LEVELS.map(level => h('option', { key: level, value: level }, level)))),
        h('label', { className: 'dab-sa-field dab-sa-field-inline' },
          h('span', { className: 'dab-sa-field-label' }, dabT('superProjectPriority')),
          h('input', {
            className: 'dab-input dab-sa-priority', type: 'number', min: 0, max: 9, value: row.priority,
            'aria-label': `${dabT('superProjectPriority')} : ${row.title}`,
            onChange: event => onSetProjectPriority?.(row.id, Number(event?.target?.value)),
          }))),
      h('div', { className: 'dab-sa-project-facts' },
        h('span', { className: 'dab-sa-model' }, `${dabT('model')} : ${row.model === null ? dabT('superNotAvailable') : `${row.model.provider ?? '?'}/${row.model.model ?? '?'}`}`),
        h('span', { className: 'dab-sa-budget' }, `${dabT('superProjectBudget')} : ${row.budget === null || row.budget.maxTasksPerHour === undefined ? dabT('superNotAvailable') : `${row.budget.maxTasksPerHour}/h`}`),
        h('span', { className: 'dab-sa-source' }, `${dabT('superProjectSource')} : ${row.source ?? dabT('superNotAvailable')}`)),
      row.reason === null ? null : h('div', { className: 'dab-sa-reason' }, `${dabT('superReason')} : ${row.reason}`))),
      dabSaExtraNode(h, bound.extra)),
    h('div', { className: 'dab-sa-dryrun-head' },
      h('button', {
        type: 'button', className: 'dab-btn dab-sa-dryrun-btn', 'aria-label': dabT('superSimulate'),
        disabled: dryRunBusy === true, onClick: onDryRun,
      }, dryRunBusy === true ? dabT('superSimulating') : dabT('superSimulate')),
      h('span', { className: 'dab-muted' }, dabT('superDryRunHint'))),
    dry === null
      ? null
      : dryUnavailable !== null
        ? dabSaReason(h, dryUnavailable)
        : h('div', { className: 'dab-sa-dryrun', 'data-readonly': 'true' },
          h('div', { className: 'dab-sa-dryrun-note' }, dabT('superDryRunNoWrite')),
          h('div', { className: 'dab-sa-dryrun-counts' },
            h('span', null, `${dabT('superDryRunProjects')} : ${dryProjects.length}`),
            h('span', null, `${dabT('superDryRunCandidates')} : ${dryCandidates.length}`),
            h('span', null, `${dabT('superDryRunActions')} : ${dryActions.length}`),
            h('span', null, `${dabT('superDryRunBlocks')} : ${dryBlocks.length}`)),
          dabSaDryRunList(h, 'projects', dryProjects, entry => `${String(entry.title ?? entry.id ?? '?')}${typeof entry.reason === 'string' ? ` — ${entry.reason}` : ''}`),
          dabSaDryRunList(h, 'candidates', dryCandidates, entry => `${String(entry.taskId ?? entry.id ?? '?')} · ${String(entry.projectId ?? '?')}${typeof entry.reason === 'string' ? ` — ${entry.reason}` : ''}`),
          dabSaDryRunList(h, 'actions', dryActions, entry => `${String(entry.action ?? entry.kind ?? '?')}${entry.projectId ? ` · ${entry.projectId}` : ''}`),
          dabSaDryRunList(h, 'blocks', dryBlocks, entry => `${String(entry.reason ?? entry.source ?? '?')}`)))
}

function factsPortfolioReason(host, superagent) {
  if (superagent === null || superagent === undefined) return 'superagent_not_published'
  if (host?.projects === undefined && superagent?.portfolio === undefined) return 'portfolio_not_published'
  return 'portfolio_empty'
}

function dabSaDryRunList(h, key, rows, label) {
  const bound = dabSaBound(rows, DAB_SUPER_LIST_LIMIT)
  if (bound.shown.length === 0) return null
  return h('div', { className: 'dab-sa-dryrun-section', 'data-list': key },
    h('ul', { className: 'dab-sa-list' }, bound.shown.map((entry, index) => h('li', { key: `${key}-${index}` }, label(entry)))),
    dabSaExtraNode(h, bound.extra))
}

/** Directives: a real persisted channel (list, add, revoke), never a textarea. */
function DabDirectiveForm({ projects, busy, onAdd }) {
  const h = React.createElement
  const [text, setText] = React.useState('')
  const [scope, setScope] = React.useState('global')
  const [projectId, setProjectId] = React.useState('')
  const options = dabSaList(projects)
  const valid = String(text).trim().length > 0 && (scope !== 'project' || String(projectId) !== '')
  return h('form', {
    className: 'dab-sa-directive-form',
    onSubmit: event => { event?.preventDefault?.(); if (valid) onAdd?.({ text: String(text).trim(), scope, projectId: scope === 'project' ? projectId : null }) },
  },
  h('label', { className: 'dab-sa-field' },
    h('span', { className: 'dab-sa-field-label' }, dabT('superDirectiveText')),
    h('input', {
      className: 'dab-input dab-sa-directive-input', type: 'text', value: text,
      'aria-label': dabT('superDirectiveText'), placeholder: dabT('superDirectivePlaceholder'),
      onChange: event => setText(event?.target?.value ?? ''),
    })),
  h('div', { className: 'dab-sa-directive-row' },
    h('label', { className: 'dab-sa-field dab-sa-field-inline' },
      h('span', { className: 'dab-sa-field-label' }, dabT('superDirectiveScope')),
      h('select', {
        className: 'dab-select dab-sa-directive-scope', value: scope, 'aria-label': dabT('superDirectiveScope'),
        onChange: event => setScope(event?.target?.value === 'project' ? 'project' : 'global'),
      },
      h('option', { value: 'global' }, dabT('superDirectiveGlobal')),
      h('option', { value: 'project' }, dabT('superDirectiveProjectScope')))),
    scope === 'project'
      ? h('label', { className: 'dab-sa-field dab-sa-field-inline' },
        h('span', { className: 'dab-sa-field-label' }, dabT('superDirectiveProject')),
        h('select', {
          className: 'dab-select dab-sa-directive-project', value: projectId, 'aria-label': dabT('superDirectiveProject'),
          onChange: event => setProjectId(event?.target?.value ?? ''),
        },
        h('option', { value: '' }, dabT('superNotAvailable')),
        options.map(project => h('option', { key: project.id, value: project.id }, project.title))))
      : null,
    h('button', {
      type: 'submit', className: 'dab-btn dab-sa-directive-add', disabled: busy === true || !valid,
    }, dabT('superDirectiveAdd'))))
}

function DabSuperagentDirectives({ superagent, portfolio, busy, onAdd, onRevoke }) {
  const h = React.createElement
  const facts = dabSuperagentFacts(superagent, null, {})
  const all = [...facts.directives, ...facts.revokedDirectives]
  const bound = dabSaBound(all, DAB_SUPER_PROJECT_LIMIT)
  const examples = [dabT('superDirectiveExample1'), dabT('superDirectiveExample2'), dabT('superDirectiveExample3')]
  return h('div', { className: 'dab-sa-tab dab-sa-directives' },
    all.length === 0
      ? h('div', { className: 'dab-sa-empty dab-sa-directives-empty' },
        h('div', null, dabT('superDirectivesEmpty')),
        h('div', { className: 'dab-muted' }, dabT('superDirectivesEmptyHint')))
      : h('ul', { className: 'dab-sa-directives-list' }, bound.shown.map(directive => h('li', {
        key: String(directive.id), className: 'dab-sa-directive',
        'data-directive-id': String(directive.id), 'data-status': String(directive.status ?? 'active'),
      },
      h('div', { className: 'dab-sa-directive-head' },
        h('span', { className: 'dab-sa-directive-text' }, String(directive.text ?? '')),
        h('span', { className: 'dab-tag' }, directive.scope === 'project' ? `${dabT('superDirectiveProjectScope')} · ${String(directive.projectId ?? '?')}` : dabT('superDirectiveGlobal')),
        h('span', { className: 'dab-tag' }, String(directive.status ?? 'active'))),
      h('div', { className: 'dab-sa-directive-meta' },
        h('span', { className: 'dab-muted' }, `${String(directive.author ?? 'operator')} · ${dabSaMoment(directive.createdAt) ?? dabT('superNotAvailable')}`),
        directive.status === 'active'
          ? h('button', {
            type: 'button', className: 'dab-btn dab-sa-revoke', disabled: busy === true,
            'aria-label': `${dabT('superRevoke')} : ${String(directive.id)}`,
            onClick: () => onRevoke?.(directive.id),
          }, dabT('superRevoke'))
          : h('span', { className: 'dab-muted' }, dabT('superRevoked'))))),
      dabSaExtraNode(h, bound.extra)),
    h(DabDirectiveForm, { projects: portfolio, busy, onAdd }),
    h('div', { className: 'dab-sa-examples' },
      h('h3', { className: 'dab-sa-section-title' }, dabT('superDirectiveExamples')),
      h('ul', { className: 'dab-sa-list' }, examples.map((example, index) => h('li', { key: `ex-${index}` }, example)))))
}

/** Paramètres: model/fallback, level, budget, permissions, Stop, connectors. */
function DabSuperagentSettings({
  superagent, mandate, host, context, ui, busy, taskboard,
  onSetLevel, onSetAction, onToggleNotifications, onStop, onResume,
}) {
  const h = React.createElement
  const facts = dabSuperagentFacts(superagent, mandate, context)
  const level = typeof mandate?.level === 'string' ? mandate.level : (facts.level ?? 'L0')
  const models = dabSaObject(host?.models)
  const providers = Array.isArray(models?.providers) ? models.providers.filter(entry => entry !== null && typeof entry === 'object') : []
  const discovered = models?.discovered === true
  const budget = facts.budget
  const actions = dabSaObject(mandate?.actions) ?? {}
  const notes = Array.isArray(host?.reconcileNotes) ? host.reconcileNotes.slice(-5) : []
  const connector = dabSaObject(taskboard) ?? dabSaObject(host?.taskboardPublic)
  const connectorReason = connector === null ? null : (typeof connector.reason === 'string' ? connector.reason : null)
  const connectorState = connector === null
    ? dabT('superNotAvailable')
    : connector.configured === false ? dabT('superTaskboardUnconfigured') : connector.reachable === false ? dabT('superTaskboardDown') : dabT('superTaskboardOk')

  return h('div', { className: 'dab-sa-tab dab-sa-settings' },
    dabSaSection(h, 'model', dabT('superSettingsModel'),
      h('div', { className: 'dab-sa-model-row' },
        h('span', { className: 'dab-sa-field-label' }, dabT('superModelPrimary')),
        h('span', { className: 'dab-sa-model-primary' }, facts.modelText ?? (facts.available ? dabT('superModelUnavailable') : dabT('superNotAvailable')))),
      h('div', { className: 'dab-sa-fallbacks' },
        h('span', { className: 'dab-sa-field-label' }, dabT('superModelFallbacks')),
        facts.fallbackModels.length === 0
          ? h('span', { className: 'dab-muted' }, dabT('superModelNone'))
          : h('ul', { className: 'dab-sa-list' }, facts.fallbackModels.map((fallback, index) => h('li', { key: `fb-${index}` }, `${fallback.provider ?? '?'}/${fallback.model ?? '?'}`)))),
      discovered
        ? h('div', { className: 'dab-sa-models-discovered' },
          h('span', { className: 'dab-tag' }, dabT('superModelsDiscovered', { n: providers.length })),
          h('ul', { className: 'dab-sa-list' }, providers.slice(0, 6).map(provider => h('li', { key: String(provider.id) },
            `${String(provider.id)} · ${(Array.isArray(provider.models) ? provider.models.length : 0)} ${dabT('superModelsCountLabel')}`))),
          providers.length > 6 ? h('div', { className: 'dab-sa-more' }, `+${providers.length - 6}`) : null)
        : dabSaReason(h, typeof models?.reason === 'string' && models.reason !== '' ? models.reason : 'models_not_discovered')),
    dabSaSection(h, 'level', dabT('superSettingsLevel'),
      h('label', { className: 'dab-sa-field dab-sa-field-inline' },
        h('span', { className: 'dab-sa-field-label' }, dabT('superSettingsGlobalLevel')),
        h('select', {
          className: 'dab-select dab-sa-global-level', value: level, 'aria-label': dabT('superSettingsGlobalLevel'),
          onChange: event => onSetLevel?.(event?.target?.value),
        }, DAB_AUTONOMY_LEVELS.map(value => h('option', { key: value, value }, value))))),
    dabSaSection(h, 'budget', dabT('superSettingsBudget'),
      budget === null
        ? dabSaReason(h, 'budget_not_published')
        : h('dl', { className: 'dab-sa-dl' },
          h('dt', null, dabT('superBudgetCycles')), h('dd', null, `${Number(budget.cyclesThisHour) || 0}/${Number(budget.cyclesPerHour) || 0}`),
          h('dt', null, dabT('superBudgetCalls')), h('dd', null, `${Number(budget.modelCallsThisHour) || 0}/${Number(budget.modelCallsPerHour) || 0}`),
          h('dt', null, dabT('superBudgetTokens')), h('dd', null, budget.tokenBudget === null || budget.tokenBudget === undefined ? dabT('superUnavailableMetric') : String(budget.tokenBudget)),
          h('dt', null, dabT('superSettingsDelegation')), h('dd', null, `${Number(budget.concurrentAgents) || 0}/${Number(budget.maxConcurrentAgents) || 0}`))),
    dabSaSection(h, 'wake', dabT('superSettingsWake'),
      facts.nextWakeAt === null
        ? h('div', { className: 'dab-muted' }, dabT('superWakeNever'))
        : h('div', { className: 'dab-sa-wake' }, `${dabT('superWakeAt')} : ${dabSaMoment(facts.nextWakeAt)}`)),
    dabSaSection(h, 'notifications', dabT('superSettingsNotifications'),
      h('label', { className: 'dab-sa-check' },
        h('input', {
          type: 'checkbox', className: 'dab-sa-notifications',
          checked: ui?.notifications !== false,
          'aria-label': dabT('superSettingsNotifications'),
          onChange: event => onToggleNotifications?.(event?.target?.checked === true),
        }),
        h('span', null, dabT('superNotificationsHint')))),
    dabSaSection(h, 'permissions', dabT('superSettingsPermissions'),
      h('ul', { className: 'dab-sa-permissions' }, DAB_ACTION_ROWS.map(([action, labelKey]) => {
        const granted = actions[action] === true
        const reason = dabActionRefusalReason({ action, mandate, context: { ...context, level } })
        return h('li', { key: action, className: 'dab-sa-permission', 'data-action': action, 'data-granted': granted ? 'true' : 'false' },
          h('label', { className: 'dab-sa-check' },
            h('input', {
              type: 'checkbox', className: 'dab-sa-permission-toggle', checked: granted,
              'aria-label': `${dabT(labelKey)}${reason === null ? '' : ` — ${reason}`}`,
              onChange: event => onSetAction?.(action, event?.target?.checked === true),
            }),
            h('span', null, dabT(labelKey))),
          reason === null
            ? h('span', { className: 'dab-sa-permission-ok' }, dabT('superActionGranted'))
            : h('span', { className: 'dab-sa-permission-reason' }, `${dabT('superReason')} : ${reason}`))
      })),
      h('div', { className: 'dab-muted' }, dabT('superPermissionsHint'))),
    dabSaSection(h, 'diagnostics', dabT('superSettingsDiagnostics'),
      notes.length === 0
        ? h('div', { className: 'dab-muted' }, dabT('superReconcileNone'))
        : h('ul', { className: 'dab-sa-list' }, notes.map((note, index) => h('li', { key: `n-${index}` }, String(note?.message ?? note ?? '?'))))),
    dabSaSection(h, 'taskboard', dabT('superSettingsTaskboard'),
      h('div', { className: 'dab-sa-connector' },
        h('span', { className: 'dab-sa-connector-state', 'data-reachable': connector?.reachable === true ? 'true' : 'false' }, connectorState),
        connectorReason === null ? null : h('span', { className: 'dab-sa-connector-reason' }, `${dabT('superReason')} : ${connectorReason}`))),
    h('div', { className: 'dab-sa-lifecycle' },
      h('button', { type: 'button', className: 'dab-btn dab-sa-stop', 'data-danger': 'true', disabled: busy === true, onClick: onStop }, dabT('superStop')),
      h('button', { type: 'button', className: 'dab-btn dab-sa-resume', disabled: busy === true, onClick: onResume }, dabT('resume'))))
}

/** The Super Agent inspector: overlay shell + four tabs. */
function DabSuperagentInspector(props) {
  const h = React.createElement
  const {
    superagent, mandate, capabilities, portfolio, host, context, dryRun, dryRunBusy, busy, narrow, taskboard, ui,
    onClose, onOpenDetail, onDryRun, onToggleProject, onSetProjectLevel, onSetProjectPriority, onConfirmAllProjects,
    onAddDirective, onRevokeDirective, onAnswerDecision, onSetLevel, onSetAction, onToggleNotifications, onStop, onResume,
  } = props
  const facts = dabSuperagentFacts(superagent, mandate, context)
  const [tab, setTab] = React.useState('overview')
  const [decisionFilter, setDecisionFilter] = React.useState('decisions')
  const panelRef = React.useRef(null)
  const activeTab = DAB_SUPER_TABS.some(entry => entry[0] === tab) ? tab : 'overview'
  const tabId = id => `dab-sa-tab-${id}`
  const panelId = 'dab-sa-tabpanel'

  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const panel = panelRef.current
    // Same dialog semantics as the agent inspector: Escape closes, Tab is
    // trapped inside the 4-tab panel, and the first control receives focus.
    const handle = panel !== null && panel !== undefined && typeof panel.querySelector === 'function'
      && typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => {
        const first = panel.querySelector(DAB_FOCUSABLE)
        try { first?.focus?.({ preventScroll: true }) } catch { first?.focus?.() }
      })
      : null
    const onKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose?.()
        return
      }
      if (event.key !== 'Tab' || panel === null || panel === undefined || typeof panel.querySelectorAll !== 'function') return
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
      if (handle !== null && handle !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
    }
  }, [onClose])

  const content = activeTab === 'projects'
    ? h(DabSuperagentProjects, {
      superagent, mandate, host, context, dryRun, dryRunBusy, busy,
      onToggleProject, onSetProjectLevel, onSetProjectPriority, onConfirmAllProjects, onDryRun,
    })
    : activeTab === 'directives'
      ? h(DabSuperagentDirectives, { superagent, portfolio, busy, onAdd: onAddDirective, onRevoke: onRevokeDirective })
      : activeTab === 'settings'
        ? h(DabSuperagentSettings, {
          superagent, mandate, host, context, ui, busy, taskboard,
          onSetLevel, onSetAction, onToggleNotifications, onStop, onResume,
        })
        : h(DabSuperagentOverview, {
          superagent, mandate, capabilities, host, context, busy,
          onOpenDetail, onAnswer: onAnswerDecision, decisionFilter, onDecisionFilter: setDecisionFilter,
        })

  return h('div', { className: 'dab-insp-overlay dab-sa-inspector', 'data-narrow': narrow === true ? 'true' : 'false' },
    h('div', { className: 'dab-insp-scrim', 'aria-hidden': 'true', onClick: () => onClose?.() }),
    h('div', {
      className: 'dab-insp-panel dab-sa-panel',
      ref: panelRef,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': `${dabT('superAgent')} — ${dabT(facts.stateLabelKey)}`,
      'data-session-state': facts.stateKey,
      'data-session-active': facts.sessionActive ? 'true' : 'false',
    },
    h('span', { className: 'dab-insp-grip', 'aria-hidden': 'true' }),
    h('div', { className: 'dab-sa-head' },
      h('span', { className: 'dab-sa-mascot', 'aria-hidden': 'true' },
        dabMascot(h, {
          role: 'super_orchestrator', emblem: 'crown', name: dabT('superAgent'),
          status: 'unknown', size: 34, variant: 'compact', decorative: true,
        })),
      h('div', { className: 'dab-sa-head-text' },
        h('h2', { className: 'dab-sa-title' }, dabT('superAgent')),
        h('div', { className: 'dab-sa-sub' },
          h('span', { className: 'dab-sa-state', 'data-session-state': facts.stateKey }, dabT(facts.stateLabelKey)),
          facts.modelText === null ? null : h('span', { className: 'dab-sa-head-model' }, facts.modelText),
          facts.level === null ? null : h('span', { className: 'dab-tag' }, facts.level))),
      h('button', {
        type: 'button', className: 'dab-btn', 'data-variant': 'ghost', 'aria-label': dabT('close'), onClick: () => onClose?.(),
      }, '✕')),
    h('div', { className: 'dab-sa-tabs', role: 'tablist', 'aria-label': dabT('superTabs') },
      DAB_SUPER_TABS.map(([id, labelKey]) => h('button', {
        key: id, type: 'button', className: 'dab-sa-tab-btn', role: 'tab',
        id: tabId(id), 'aria-selected': activeTab === id ? 'true' : 'false', 'aria-controls': panelId,
        tabIndex: activeTab === id ? 0 : -1,
        onClick: () => setTab(id),
      }, dabT(labelKey)))),
    h('div', { className: 'dab-sa-panel-body', role: 'tabpanel', id: panelId, 'aria-labelledby': tabId(activeTab), tabIndex: 0 },
      content)))
}
