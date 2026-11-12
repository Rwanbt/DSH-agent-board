#!/usr/bin/env node
/**
 * Visual harness for the Super Agent band + inspector, without a DSH host.
 *
 * Writes a self-contained HTML page that evaluates the real cockpit modules
 * (same concatenation as the build) with React 18 and a fixture payload, so
 * the layout can be checked at phone widths (390 / 360 px) in any browser.
 * The DSH design tokens are approximated: colours are indicative, layout and
 * spacing are the real CSS.
 *
 *   node scripts/ux-harness.mjs [outDir]   -> <outDir>/ux-harness.html
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(process.argv[2] ?? join(ROOT, '.ux-harness'))

const MODULES = [
  'src/contracts/model.js', 'src/contracts/agent-roles.js', 'src/supervisor/projection.js',
  'src/supervisor/super-orchestrator.js', 'src/board/view.js', 'src/board/hierarchy.js',
  'src/board/overview.js', 'src/board/interaction.js', 'src/client/ui/strings.js',
  'src/client/ui/styles.js', 'src/client/ui/select.js', 'src/client/ui/agent-bots-assets.js', 'src/client/ui/avatar.js',
  'src/client/ui/card.js', 'src/client/ui/hierarchy.js', 'src/client/ui/overview.js',
  'src/client/ui/superbar.js', 'src/client/ui/tree.js', 'src/client/ui/preview.js',
  'src/client/ui/inspector.js',
]
const IMPORT_STATEMENT = /^[ \t]*import\s+(?:[^'"]*?\s+from\s+)?['"][^'"]+['"][ \t]*;?[ \t]*\r?\n?/gm
const EXPORT_PREFIX = /^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm

const code = []
for (const relative of MODULES) {
  const raw = await readFile(join(ROOT, relative), 'utf8')
  code.push(raw.replace(IMPORT_STATEMENT, '').replace(EXPORT_PREFIX, ''))
}

const app = `
DAB_LANG = 'fr'
const h = React.createElement
const projects = ['unifia', 'Ravum-flow', 'Ravum', 'DSH-agent-board', 'default-workspace']
const host = { projects: projects.map(id => ({ id, title: id })), models: { discovered: false, reason: 'models_not_discovered' }, taskboardPublic: { configured: false, reachable: false, reason: 'public_api_disabled' } }
const superagent = {
  identity: { agentId: 'sa', name: 'Super Agent', model: null, level: 'L0', status: 'idle', generation: 1 },
  session: { sessionId: null, active: false }, directives: [], decisions: [], activity: [],
  plan: { revision: 1, objectives: [], nextActions: [], idleReason: 'not_started' },
  budget: { cyclesPerHour: 6, cyclesThisHour: 0, concurrentAgents: 0, maxConcurrentAgents: 2, modelCallsPerHour: 12, modelCallsThisHour: 0, tokenBudget: null },
  lastCycle: null, nextWakeAt: null, runtime: { available: false, reason: 'not_started' },
}
const mandate = { version: 2, scopeMode: 'none', selectedWorkspaces: [], level: 'L0', paused: false, requiresConfiguration: true,
  actions: { comment: false, create_task: false, update_task: false, launch: false, delegate: false, schedule: false, push_branch: false, open_pr: false, merge: false, protected_branch_write: false, delete_task: false, secrets: false, policy_change: false },
  projects: {} }
const workspace = { status: 'idle', available: true, mode: 'off', recommendations: [], blocks: [], taskboard: null,
  delegation: { inFlight: 0, depthLimit: 1, concurrentLimit: 2, hourlyLimit: 6 },
  capabilities: { observe: true, recommend: true, delegate: { state: 'unavailable', reason: 'mode_off' }, reassign: { state: 'unavailable', reason: 'mode_off' }, priority: { state: 'unavailable', reason: 'mode_off' },
    receiveOrchestratorReports: { state: 'unavailable', reason: 'no_inbound_orchestrator_report_channel' }, kanbanWrite: { state: 'unavailable', reason: 'taskboard_write_api_unavailable' } },
  capabilityReasons: {} }
const context = { mode: 'off', stopped: false, scopeMode: 'none', requiresConfiguration: true }
function App() {
  const [tab, setTab] = React.useState(new URLSearchParams(location.search).get('tab'))
  const [open, setOpen] = React.useState(true)
  const [policies, setPolicies] = React.useState({ 'Ravum': { enabled: true, level: 'L3' } })
  const liveMandate = { ...mandate, scopeMode: Object.keys(policies).length ? 'selected' : 'none', selectedWorkspaces: Object.keys(policies), projects: policies }
  const projectRows = dabProjectPolicyRows(host, superagent, liveMandate)
  return h('div', { className: 'dab-root', style: { position: 'relative', minHeight: '100vh', containerType: 'inline-size', containerName: 'dab' } },
    h(DabSuperOrchestratorBar, { workspace, totals: { projects: 5, agents: 7, dependencies: 0 }, projects: [], orchestrators: [], mode: 'off', open, compact: true,
      onToggle: () => setOpen(v => !v), onSelect: () => {}, superagent, mandate: liveMandate, capabilities: {}, stopped: false, busy: false, projectRows,
      onToggleProject: (id, on) => setPolicies(p => ({ ...p, [id]: { ...(p[id] ?? { level: 'L0' }), enabled: on } })),
      onSetProjectLevel: (id, level) => setPolicies(p => ({ ...p, [id]: { ...p[id], level } })),
      onStart() {}, onPause() {}, onStop() {}, onResume() {}, onOpenSuperagent: () => setTab('overview'), onOpenProjects: () => setTab('projects') }),
    tab ? h(DabSuperagentInspector, { key: tab, initialTab: tab, superagent, mandate, capabilities: {}, portfolio: host.projects, host, context, workspace, narrow: true, ui: {}, busy: false,
      onClose: () => setTab(null) }) : null)
}
ReactDOM.createRoot(document.getElementById('root')).render(h(App))
`

const tokens = `:root, body { color-scheme: dark; --dsw-alias-bg-base:#141414; --dsw-alias-bg-layer-1:#1f1f1f; --dsw-alias-bg-layer-2:#2a2a2a;
  --dsw-alias-label-primary:#f2f2f2; --dsw-alias-label-secondary:#a3a3a3; --dsw-alias-label-tertiary:#7a7a7a;
  --dsw-alias-border-l2:#2e2e2e; --dsw-alias-border-l3:#3a3a3a; --dsw-alias-brand-primary:#ffffff;
  --dsw-alias-state-success-primary:#22c55e; --dsw-alias-state-warn-primary:#f59e0b; --dsw-alias-state-error-primary:#ef4444; --dsw-alias-state-info-primary:#60a5fa;
  --dsw-alias-interactive-bg-hover:#2f2f2f; --dsw-radius-sm:6px; --dsw-radius-md:10px; --dsw-elevation-prominent:0 8px 32px #0008; }
body { margin:0; background:#141414; color:#f2f2f2; font: 13px/1.4 system-ui, sans-serif; }
.dab-btn, .dab-select, .dab-input { background:#262626; color:#f2f2f2; border:1px solid #3a3a3a; border-radius:6px; padding:4px 10px; font: inherit; }`

const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Board UX harness</title>
<script src="https://unpkg.com/react@18.3.1/umd/react.development.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js"></script>
<style>${tokens}</style></head><body><div id="root"></div>
<script>
${code.join('\n\n')}
document.head.insertAdjacentHTML('beforeend', '<style>' + DAB_CSS + '</style>')
${app}
</script></body></html>`

await mkdir(outDir, { recursive: true })
const out = join(outDir, 'ux-harness.html')
await writeFile(out, html)
console.log(out)
