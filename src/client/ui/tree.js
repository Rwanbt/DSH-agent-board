/**
 * AgentTree / ProjectGroup / CompactGrid: render the pure board view
 * (board/view.js) as family trees grouped by project, or as a compact grid
 * still grouped by project and by root parent.
 *
 * @module dsh-agent-board/client/ui/tree
 */

function dabEntryRole(ctx, node) {
  if (ctx.roles instanceof Map) return ctx.roles.get(node.id) ?? null
  return null
}

function dabEntryTaskState(ctx, node) {
  if (node.taskId === null || node.taskId === undefined) return null
  if (ctx.taskStates instanceof Map) return ctx.taskStates.get(String(node.taskId)) ?? null
  return null
}

function DabTreeBranch({ entry, ctx }) {
  const h = React.createElement
  const node = entry.node
  return h(
    'li', { className: 'dab-branch', role: 'treeitem', 'aria-expanded': entry.totalChildren > 0 ? !entry.collapsed : undefined, 'aria-level': entry.depth + 1 },
    h(DabAgentCard, {
      node,
      depth: entry.depth,
      root: entry.depth === 0,
      selected: ctx.selectedId === node.id,
      arbiter: ctx.arbiter,
      hiddenChildren: entry.hiddenChildren,
      totalChildren: entry.totalChildren,
      collapsed: entry.collapsed,
      expanded: entry.expanded,
      groupActive: entry.groupActive,
      onToggleBranch: ctx.onToggleBranch,
      onRevealHidden: ctx.onRevealHidden,
      nowBucket: ctx.nowBucket,
      role: dabEntryRole(ctx, node),
      taskState: dabEntryTaskState(ctx, node),
      groupedProject: true,
    }),
    entry.children.length > 0
      ? h('ul', { className: 'dab-kids', role: 'group' }, entry.children.map(child => h(DabTreeBranch, { key: child.node.id, entry: child, ctx })))
      : null,
  )
}

/** Parent → child pairs of the visible tree (render order). */
function dabEdgesOf(entry, out = []) {
  for (const child of entry.children) {
    out.push({ from: entry.node.id, to: child.node.id, active: child.aggregate?.running === true || child.node.status === 'running' })
    dabEdgesOf(child, out)
  }
  return out
}

/**
 * Smooth node-graph link between two card rectangles (tile coordinates).
 * Horizontal layout: right-middle of the parent → left-middle of the child.
 * Stacked (narrow) layout: below the parent's mark → left-middle of the child.
 */
function dabLinkPath(a, b) {
  if (b.left >= a.right - 1) {
    const x1 = a.right
    const y1 = a.top + Math.min(24, a.height / 2)
    const x2 = b.left
    const y2 = b.top + Math.min(24, b.height / 2)
    const dx = Math.max(12, (x2 - x1) * 0.55)
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
  }
  const x1 = a.left + 16
  const y1 = a.bottom
  const x2 = b.left
  const y2 = b.top + Math.min(18, b.height / 2)
  return `M${x1},${y1} C${x1},${y2} ${x1},${y2} ${x2},${y2}`
}

function DabAgentTree({ entry, ctx }) {
  const h = React.createElement
  const tileRef = React.useRef(null)
  const [links, setLinks] = React.useState({ paths: [], width: 0, height: 0 })
  const edges = dabEdgesOf(entry)
  const edgeKey = edges.map(edge => `${edge.from}>${edge.to}:${edge.active ? 1 : 0}`).join('|')

  React.useLayoutEffect(() => {
    const tile = tileRef.current
    if (tile === null) return undefined
    const measure = () => {
      const base = tile.getBoundingClientRect()
      const rectOf = id => {
        const element = tile.querySelector(`.dab-card[data-node-id="${CSS.escape(id)}"]`)
        if (element === null) return null
        const r = element.getBoundingClientRect()
        const left = r.left - base.left + tile.scrollLeft
        const top = r.top - base.top + tile.scrollTop
        return { left, top, right: left + r.width, bottom: top + r.height, width: r.width, height: r.height }
      }
      const paths = []
      for (const edge of edges) {
        const a = rectOf(edge.from)
        const b = rectOf(edge.to)
        if (a !== null && b !== null) paths.push({ key: `${edge.from}>${edge.to}`, d: dabLinkPath(a, b), active: edge.active })
      }
      setLinks({ paths, width: tile.scrollWidth, height: tile.scrollHeight })
    }
    measure()
    if (typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(() => measure())
    observer.observe(tile)
    return () => observer.disconnect()
  }, [edgeKey, ctx.selectedId])

  return h('div', { className: 'dab-tile', ref: tileRef },
    links.paths.length > 0
      ? h('svg', { className: 'dab-links', width: links.width, height: links.height, 'aria-hidden': 'true' },
        links.paths.map(link => h('path', { key: link.key, d: link.d, 'data-active': link.active ? 'true' : 'false' })))
      : null,
    h('ul', { className: 'dab-tree', role: 'tree', 'aria-label': entry.node.title },
      h(DabTreeBranch, { entry, ctx })))
}

function dabFlattenTree(entry, out = [], parentTitle = null) {
  out.push({ entry, parentTitle })
  for (const child of entry.children) dabFlattenTree(child, out, entry.node.title)
  return out
}

/**
 * The visible tree slice. `treeLimit` trims CALM trees only: a tree whose
 * subtree contains an agent waiting for the user is never hidden because it is
 * older than eight newer trees (the yellow card is the one thing that must
 * always be reachable without expanding a list).
 */
function dabVisibleTrees(project, treeLimit) {
  const head = project.trees.slice(0, treeLimit)
  const tail = project.trees.slice(treeLimit)
  const waiting = tail.filter(tree => (tree.aggregate?.bestTier ?? 9) === 0 || tree.node?.status === 'waiting_user')
  return waiting.length === 0 ? head : [...waiting, ...head]
}

function DabCompactProject({ project, ctx, trees }) {
  const h = React.createElement
  return h('div', null, trees.map(tree => {
    const flat = dabFlattenTree(tree)
    return h('div', { className: 'dab-compact-group', key: tree.node.id },
      tree.children.length > 0 || tree.hiddenChildren > 0
        ? h('div', { className: 'dab-compact-parent' }, `${tree.node.title}${tree.hiddenChildren > 0 ? ` · +${tree.hiddenChildren} ${dabT('hidden')}` : ''}`)
        : null,
      h('div', { className: 'dab-compact-grid' }, flat.map(({ entry }) => h(DabAgentCard, {
        key: entry.node.id,
        node: entry.node,
        depth: entry.depth,
        root: false,
        compact: true,
        selected: ctx.selectedId === entry.node.id,
        arbiter: ctx.arbiter,
        hiddenChildren: 0,
        totalChildren: 0,
        collapsed: false,
        expanded: false,
        groupActive: entry.groupActive,
        onToggleBranch: ctx.onToggleBranch,
        onRevealHidden: ctx.onRevealHidden,
        nowBucket: ctx.nowBucket,
        role: dabEntryRole(ctx, entry.node),
        taskState: dabEntryTaskState(ctx, entry.node),
        groupedProject: true,
      }))))
  }))
}

function DabProjectGroup({ project, ctx, folded, onFold, treeLimit, onMoreTrees, compact }) {
  const h = React.createElement
  const title = project.unassigned ? dabT('unassigned') : project.title
  const trees = folded ? [] : dabVisibleTrees(project, treeLimit)
  const hiddenTrees = Math.max(0, project.trees.length - trees.length)
  const summary = []
  if (project.summary.running > 0) summary.push(h('span', { key: 'r', className: 'dab-counter' }, h('span', { className: 'dab-dot', 'data-tone': 'running' }), project.summary.running))
  if (project.summary.waiting > 0) summary.push(h('span', { key: 'w', className: 'dab-counter' }, h('span', { className: 'dab-dot', 'data-tone': 'waiting' }), project.summary.waiting))
  if (project.summary.unread > 0) summary.push(h('span', { key: 'u', className: 'dab-counter' }, h('span', { className: 'dab-dot', 'data-tone': 'unread' }), project.summary.unread))
  // The declared project orchestrator, when the hierarchy projection found one.
  // A missing orchestrator is NOT rendered here as a fake node or a warning;
  // the hierarchy view owns the explicit gap.
  const orchestrator = project.orchestrator
  const orchestratorChip = orchestrator === null || orchestrator === undefined
    ? null
    : h('span', {
      className: 'dab-project-orch',
      title: `${dabT('orchestratorLabel')} : ${orchestrator.name}${orchestrator.role ? ` (${orchestrator.role})` : ''}`,
    },
    dabMascot(h, { role: orchestrator.role, name: orchestrator.name, status: orchestrator.status, size: 18, variant: 'compact', decorative: true }),
    h('span', { className: 'dab-project-orch-name' }, orchestrator.name))
  return h('section', { className: 'dab-project', 'data-project-id': project.id, 'aria-label': title },
    h('button', { type: 'button', className: 'dab-project-head', 'aria-expanded': !folded, onClick: () => onFold(project.id) },
      h('span', { className: 'dab-caret', 'aria-hidden': 'true' }, folded ? '▸' : '▾'),
      h('span', null, title),
      h('span', { className: 'dab-project-count' }, `${project.visibleAgents} agent${project.visibleAgents > 1 ? 's' : ''}`),
      orchestratorChip,
      summary),
    folded
      ? null
      : compact
        ? h(DabCompactProject, { project, ctx, trees })
        : h('div', { className: 'dab-forest' }, trees.map(tree => h(DabAgentTree, { key: tree.node.id, entry: tree, ctx }))),
    !folded && hiddenTrees > 0
      ? h('div', { className: 'dab-more' }, h('button', { type: 'button', className: 'dab-btn', onClick: () => onMoreTrees(project.id) }, dabT('moreTrees', { n: hiddenTrees })))
      : null,
  )
}
