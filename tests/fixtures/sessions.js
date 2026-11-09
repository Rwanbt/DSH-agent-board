/**
 * Explicitly synthetic fixtures (NOT live data) shaped like the DSH 0.2.2-rc.1
 * client `sessions.list` snapshot, `uiSession.sessionStatus` map and
 * `workspaces.list` snapshot observed in the live profile on 2026-11-09:
 *   - rows carry `parentId` + `origin: 'subagent'` for sub-agents,
 *   - `projectionValues` holds modelSelection / turnOutline / userQuestions /
 *     mobilePushLifecycle.lastTurnEnd / subagent.label,
 *   - workspace items are keyed by `workspaceId` with top-level `sessionIds`.
 */

export const NOW = 1_800_000_000_000
const HOUR = 3_600_000

export function row(id, extra = {}) {
  const { values = {}, ...rest } = extra
  return {
    id,
    displayTitle: rest.displayTitle ?? `Session ${id}`,
    running: false,
    blank: false,
    updatedAt: NOW - 30 * HOUR,
    cwd: 'C:\\Users\\me\\default-workspace',
    projectionValues: {
      modelSelection: { lastUsed: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, next: null },
      turnOutline: [{ turn: 1, prompt: 'p', response: `Answer of ${id}.\nAll tests pass.` }],
      userQuestions: { active: [], settled: [] },
      plan: { active: false, pending: false },
      mobilePushLifecycle: { lastTurnEnd: { turn: 1, reason: 'completed' } },
      sessionStats: { turns: 1, steps: 4 },
      ...values,
    },
    ...rest,
  }
}

/**
 * The photo scenario: default-workspace with 39 old sessions, 2 running roots,
 * 9 unread results and several sub-agents (depth 3), plus a Ravum project with
 * two roots, an orphan, a cycle, a long title and an unknown workspace path.
 */
export function photoScenario() {
  const byId = {}
  const ids = []
  const add = r => { byId[r.id] = r; ids.push(r.id) }
  for (let index = 0; index < 39; index += 1) {
    add(row(`old-${index}`, { displayTitle: index % 3 === 0 ? `CRON-F free periodic ${index}` : `Old session ${index}`, updatedAt: NOW - (8 + index) * HOUR }))
  }
  // Two running roots in Ravum, one with a 3-level family.
  add(row('ravum-goal', { displayTitle: '# GOAL — RAVUM CORE', running: true, cwd: 'D:\\App\\Ravum', updatedAt: NOW - 60_000,
    values: { agentTeam: { members: [{ id: 'child-a', name: 'feat-syn', role: 'teammate' }] } } }))
  add(row('child-a', { parentId: 'ravum-goal', origin: 'subagent', running: true, cwd: 'D:\\App\\Ravum', displayTitle: 'You are working in the',
    values: { subagent: { label: 'Author conformance cases', mode: 'continuable' } } }))
  add(row('grandchild', { parentId: 'child-a', origin: 'subagent', running: true, cwd: 'D:\\App\\Ravum', displayTitle: 'Explore' }))
  add(row('great-grandchild', { parentId: 'grandchild', origin: 'subagent', cwd: 'D:\\App\\Ravum', displayTitle: 'Leaf' }))
  for (let index = 0; index < 6; index += 1) {
    add(row(`calm-child-${index}`, { parentId: 'ravum-goal', origin: 'subagent', cwd: 'D:\\App\\Ravum', displayTitle: `Calm child ${index}` }))
  }
  // Parent whose own turn finished while its child still runs.
  add(row('ravum-parent-done', { displayTitle: 'GOAL — RAVUM', running: false, cwd: 'D:\\App\\Ravum', updatedAt: NOW - 2 * HOUR }))
  add(row('ravum-child-live', { parentId: 'ravum-parent-done', origin: 'subagent', running: true, cwd: 'D:\\App\\Ravum' }))
  // Second running root in default-workspace.
  add(row('dw-live', { displayTitle: 'DSH Agent Board', running: true, updatedAt: NOW - 5000 }))
  // Nine unread results (host turnEnd recorded, no ack).
  for (let index = 0; index < 9; index += 1) add(row(`unread-${index}`, { updatedAt: NOW - (index + 1) * 600_000 }))
  // Waiting for an answer, many hours old: must stay visible.
  add(row('asking', { displayTitle: 'Needs a decision', updatedAt: NOW - 34 * HOUR,
    values: { userQuestions: { active: [{ question: 'Which branch should I merge into?' }], settled: [] } } }))
  // Malformed data.
  add(row('orphan', { parentId: 'ghost-parent', origin: 'subagent', running: true, cwd: 'D:\\App\\Ravum' }))
  add(row('cyc-a', { parentId: 'cyc-b', cwd: 'D:\\App\\Ravum', running: true }))
  add(row('cyc-b', { parentId: 'cyc-a', cwd: 'D:\\App\\Ravum' }))
  add(row('long', { displayTitle: 'L'.repeat(400), running: true, cwd: 'E:\\Nowhere\\unknown-project' }))
  add(row('failed-new', { displayTitle: 'Broken run', values: { mobilePushLifecycle: { lastTurnEnd: { turn: 1, reason: 'error' } } } }))

  const turnEnd = {}
  for (let index = 0; index < 9; index += 1) turnEnd[`unread-${index}`] = { at: NOW - index * 1000, kind: 'completed' }
  turnEnd['failed-new'] = { at: NOW - 1000, kind: 'error', error: 'provider 500' }

  return {
    list: { phase: 'ready', ids: [...ids, 'child-a' /* duplicate id must be deduplicated */], byId, projectionsBySession: {
      'ravum-goal': { values: { subagentCatalog: [{ id: 'child-a', label: 'Author conformance cases', mode: 'continuable' }] } },
    } },
    statusMap: new Map(ids.map(id => [id, { running: byId[id].running === true, completionUnread: false }])),
    hostState: { turnEnd, acks: {}, previews: {}, assignments: [] },
    workspaces: {
      items: [
        { workspaceId: 'w-dw', title: 'default-workspace', path: 'C:\\Users\\me\\default-workspace', sessionIds: ids.filter(id => id.startsWith('old-') || id.startsWith('unread-') || ['dw-live', 'asking', 'failed-new'].includes(id)) },
        { workspaceId: 'w-ravum', title: 'Ravum', path: 'D:\\App\\Ravum', sessionIds: ['ravum-goal'] },
        { workspaceId: 'w-gone', title: 'Deleted', path: 'Z:\\does-not-exist', sessionIds: ['not-a-session'] },
      ],
      archivedSessionIds: ['old-1'],
    },
  }
}

/** Large profile: `history` calm sessions plus `active` running roots with children. */
export function largeScenario({ history = 200, active = 30 } = {}) {
  const byId = {}
  const ids = []
  for (let index = 0; index < history; index += 1) {
    const r = row(`h-${index}`, { updatedAt: NOW - index * HOUR })
    byId[r.id] = r; ids.push(r.id)
  }
  for (let index = 0; index < active; index += 1) {
    const root = row(`a-${index}`, { running: true, cwd: `D:\\App\\p${index % 5}`, updatedAt: NOW - index * 1000 })
    byId[root.id] = root; ids.push(root.id)
    const child = row(`a-${index}-c`, { parentId: root.id, origin: 'subagent', running: index % 2 === 0, cwd: root.cwd })
    byId[child.id] = child; ids.push(child.id)
  }
  return {
    list: { phase: 'ready', ids, byId, projectionsBySession: {} },
    statusMap: new Map(ids.map(id => [id, { running: byId[id].running }])),
    hostState: { turnEnd: {}, acks: {}, previews: {} },
    workspaces: { items: [0, 1, 2, 3, 4].map(n => ({ workspaceId: `w${n}`, title: `p${n}`, path: `D:\\App\\p${n}`, sessionIds: [] })) },
  }
}
