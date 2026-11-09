/**
 * AgentTree / ProjectGroup / CompactGrid: render the pure board view
 * (board/view.js) as family trees grouped by project, or as a compact grid
 * still grouped by project and by root parent.
 *
 * @module dsh-agent-board/client/ui/tree
 */

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
    }),
    entry.children.length > 0
      ? h('ul', { className: 'dab-kids', role: 'group' }, entry.children.map(child => h(DabTreeBranch, { key: child.node.id, entry: child, ctx })))
      : null,
  )
}

function DabAgentTree({ entry, ctx }) {
  const h = React.createElement
  return h('div', { className: 'dab-tile' },
    h('ul', { className: 'dab-branch-root', role: 'tree', 'aria-label': entry.node.title, style: { listStyle: 'none', margin: 0, padding: 0 } },
      h(DabTreeBranch, { entry, ctx })))
}

function dabFlattenTree(entry, out = [], parentTitle = null) {
  out.push({ entry, parentTitle })
  for (const child of entry.children) dabFlattenTree(child, out, entry.node.title)
  return out
}

function DabCompactProject({ project, ctx, treeLimit }) {
  const h = React.createElement
  const trees = project.trees.slice(0, treeLimit)
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
      }))))
  }))
}

function DabProjectGroup({ project, ctx, folded, onFold, treeLimit, onMoreTrees, compact }) {
  const h = React.createElement
  const title = project.unassigned ? dabT('unassigned') : project.title
  const hiddenTrees = Math.max(0, project.trees.length - treeLimit)
  const summary = []
  if (project.summary.running > 0) summary.push(h('span', { key: 'r', className: 'dab-counter' }, h('span', { className: 'dab-dot', 'data-tone': 'running' }), project.summary.running))
  if (project.summary.waiting > 0) summary.push(h('span', { key: 'w', className: 'dab-counter' }, h('span', { className: 'dab-dot', 'data-tone': 'waiting' }), project.summary.waiting))
  if (project.summary.unread > 0) summary.push(h('span', { key: 'u', className: 'dab-counter' }, h('span', { className: 'dab-dot', 'data-tone': 'unread' }), project.summary.unread))
  return h('section', { className: 'dab-project', 'data-project-id': project.id, 'aria-label': title },
    h('button', { type: 'button', className: 'dab-project-head', 'aria-expanded': !folded, onClick: () => onFold(project.id) },
      h('span', { className: 'dab-caret', 'aria-hidden': 'true' }, folded ? '▸' : '▾'),
      h('span', null, title),
      h('span', { className: 'dab-project-count' }, `${project.visibleAgents} agent${project.visibleAgents > 1 ? 's' : ''}`),
      summary),
    folded
      ? null
      : compact
        ? h(DabCompactProject, { project, ctx, treeLimit })
        : h('div', { className: 'dab-forest' }, project.trees.slice(0, treeLimit).map(tree => h(DabAgentTree, { key: tree.node.id, entry: tree, ctx }))),
    !folded && hiddenTrees > 0
      ? h('div', { className: 'dab-more' }, h('button', { type: 'button', className: 'dab-btn', onClick: () => onMoreTrees(project.id) }, dabT('moreTrees', { n: hiddenTrees })))
      : null,
  )
}
