/**
 * Capture the two public demo screenshots of the Agent Board.
 *
 * Why this exists: the original captures that used to live in this repository
 * were REAL captures of the author's own cockpit, and they showed personal
 * project names. They were removed (from the working tree AND from the whole
 * history) and replaced by these two, rendered from the real client components
 * with a FICTIONAL portfolio. Nothing here touches a live DSH session: the page
 * is the plugin's own client bundle, fed with a fake host state.
 *
 * Usage:
 *   node scripts/capture-demo-screenshots.mjs
 *
 * Output:
 *   docs/screenshots/demo-dark-desktop.png   (1440x900, dark)
 *   docs/screenshots/demo-dark-mobile.png    (390x844, dark)
 *
 * The Chromium binary is discovered from $CHROMIUM, then the Playwright cache,
 * then the usual Chrome/Edge locations. The script has no npm dependency.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.ux-harness', 'demo')
const OUT = join(ROOT, 'docs', 'screenshots')
const REACT = 'https://unpkg.com/react@18.3.1/umd/react.production.min.js'
const REACT_DOM = 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js'

/** Fictional projects: no real workspace, repository or person. */
const PROJECTS = [
  { id: 'ws-orion', title: 'Orion Studio', path: 'D:\\Demo\\orion-studio' },
  { id: 'ws-nebula', title: 'Nebula API', path: 'D:\\Demo\\nebula-api' },
  { id: 'ws-atlas', title: 'Atlas Docs', path: 'D:\\Demo\\atlas-docs' },
]

const MODEL = { provider: 'deepseek', model: 'deepseek-v4.1-flash' }

/** Fake sessions: id, project, title, status inputs. */
const SESSIONS = [
  { id: 's-orion-1', ws: 'ws-orion', title: 'Refactor the invoice export', running: true, turns: 4, steps: 12 },
  { id: 's-orion-2', ws: 'ws-orion', title: 'Add the ADR-0007 journal rename test', doneAt: 12, read: false },
  { id: 's-orion-3', ws: 'ws-orion', title: 'Approve the export schema change', waiting: true },
  { id: 's-nebula-1', ws: 'ws-nebula', title: 'Harden the webhook signature check', running: true, turns: 2, steps: 7 },
  { id: 's-nebula-2', ws: 'ws-nebula', title: 'api-review', parent: 's-nebula-1', origin: 'subagent', waiting: true },
  { id: 's-nebula-3', ws: 'ws-nebula', title: 'Rotate the staging keys', doneAt: 40, read: true },
  { id: 's-atlas-1', ws: 'ws-atlas', title: 'Write the migration guide', doneAt: 25, read: false },
  { id: 's-atlas-2', ws: 'ws-atlas', title: 'Fix the broken sidebar link', failed: true },
  { id: 's-atlas-3', ws: 'ws-atlas', title: 'License check', doneAt: 90, read: true },
]

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

function buildFakes() {
  const sessionsList = {
    phase: 'ready',
    ids: SESSIONS.map(session => session.id),
    byId: Object.fromEntries(SESSIONS.map(session => {
      const project = PROJECTS.find(entry => entry.id === session.ws)
      return [session.id, {
        id: session.id,
        displayTitle: session.title,
        cwd: project.path,
        running: session.running === true,
        origin: session.origin ?? 'main',
        ...(session.parent === undefined ? {} : { parentId: session.parent }),
        projectionValues: {
          modelSelection: { lastUsed: MODEL },
          goal: { goal: { objective: session.title } },
        },
        ...(session.turns === undefined ? {} : { activity: { turns: session.turns, steps: session.steps } }),
      }]
    })),
    projectionsBySession: {},
  }
  const statusMap = new Map()
  for (const session of SESSIONS) {
    if (session.waiting === true) statusMap.set(session.id, { running: false, pendingInteraction: { kind: 'approval' } })
    else if (session.running === true) statusMap.set(session.id, { running: true })
  }
  const workspaces = {
    items: PROJECTS.map(project => ({
      workspaceId: project.id,
      title: project.title,
      path: project.path,
      sessionIds: SESSIONS.filter(session => session.ws === project.id).map(session => session.id),
    })),
    archivedSessionIds: [],
  }
  const turnEnd = {}
  const acks = {}
  const now = Date.now()
  for (const session of SESSIONS) {
    if (session.doneAt !== undefined) {
      const at = now - session.doneAt * 60 * 1000
      turnEnd[session.id] = { at, kind: 'completed' }
      // An ack AFTER the turn end means "read"; an older cursor leaves it unread.
      acks[session.id] = { seenAt: session.read === true ? at + 60_000 : at - 60 * 60 * 1000 }
    }
    if (session.failed === true) {
      turnEnd[session.id] = { at: now - 5 * 60 * 1000, kind: 'error', error: 'provider_error' }
    }
  }
  const running = SESSIONS.filter(session => session.running === true).map((session, index) => ({
    id: `asg-demo-${index + 1}`,
    taskId: `work-demo-${index + 1}`,
    taskTitle: session.title,
    workspaceId: session.ws,
    status: 'running',
    sessionId: session.id,
    startedAt: now - (index + 1) * 3 * 60 * 1000,
    model: MODEL,
  }))
  const host = {
    schemaVersion: 2,
    mode: 'autonomous',
    stoppedAt: null,
    policy: { executionBackend: 'board', maxConcurrent: 2, allowedPermissions: ['read-only', 'workspace-write'] },
    mandate: {
      version: 2,
      scopeMode: 'selected',
      selectedWorkspaces: ['ws-orion', 'ws-nebula'],
      level: 'L3',
      actions: {
        comment: true, create_task: true, update_task: true, promote_task: true,
        launch: true, launch_work: true, delegate: false, schedule: true, push_branch: false,
        open_pr: false, merge: false, protected_branch_write: false, delete_task: false, secrets: false, policy_change: false,
      },
      actionModes: {},
      projects: {
        'ws-orion': { enabled: true, level: 'L3', priority: 3, budget: { maxTasksPerHour: 6 } },
        'ws-nebula': { enabled: true, level: 'L3', priority: 5, budget: { maxTasksPerHour: 4 } },
      },
      paused: false,
      requiresConfiguration: false,
    },
    assignments: running,
    acks,
    turnEnd,
    previews: {
      's-orion-1': { text: 'The export now writes through the new InvoiceWriter and the golden files still match.', at: now - 60 * 1000 },
      's-nebula-1': { text: 'Signature check hardened with a constant-time compare; two new tests cover replay and skew.', at: now - 90 * 1000 },
      's-atlas-1': { text: 'Migration guide drafted: schema v2, journal rename, rollback section.', at: now - 25 * 60 * 1000 },
    },
    proposals: [],
    routeEvents: [],
    health: {},
    lastTick: { at: now - 30 * 1000, reason: 'ok', mode: 'autonomous', actions: [], skipped: [] },
    sync: { ok: true, at: now - 30 * 1000, tasksTotal: 0, ledgerRevision: null, error: null },
    adapters: { adapters: [], executors: [], baseUrl: 'http://127.0.0.1:1' },
    audit: [],
    gone: {},
    contract: null,
    budget: { concurrent: 2, maxConcurrent: 2, tasksThisHour: 2, maxTasksPerHour: 6 },
    primaryReturn: null,
    host: {
      build: { version: '0.2.0', schemaVersion: 2, features: ['mandate', 'scopeMode', 'levels', 'supervision', 'superagent', 'dryRun', 'project-work'] },
      primary: true,
      lockHolder: 'demo',
      taskboardPublic: { configured: false, reachable: false, reason: 'token_not_configured', capabilities: null },
      models: { discovered: true, reason: null, providers: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: MODEL.model, name: MODEL.model }] }] },
    },
    capabilities: {
      observe: { state: 'available', reason: 'allowed', source: 'host' },
      analyse: { state: 'available', reason: 'allowed', source: 'host' },
      launch: { state: 'available', reason: 'allowed', source: 'mandate' },
      launch_work: { state: 'available', reason: 'allowed', source: 'mandate' },
      promote_task: { state: 'available', reason: 'allowed', source: 'mandate' },
      open_pr: { state: 'unavailable', reason: 'github_token_missing', source: 'integration' },
    },
    portfolio: PROJECTS.map(project => ({
      projectId: project.id, title: project.title, selected: project.id !== 'ws-atlas', enabled: project.id !== 'ws-atlas',
      level: 'L3', effectiveLevel: 'L3', canLaunchReason: project.id === 'ws-atlas' ? 'project_not_selected' : 'allowed',
      priority: 5, model: null, budget: { maxTasksPerHour: 6 },
      taskCounts: { total: 0, todo: 0, bounded: true },
      source: { canonical: 'workspace', available: true, reason: null },
    })),
    superagent: {
      identity: {
        agentId: 'super-agent-demo', name: 'Super Agent', level: 'L3', status: 'idle', generation: 3,
        model: { provider: MODEL.provider, model: MODEL.model }, session: { sessionId: 'session-demo', active: true },
      },
      session: { sessionId: 'session-demo', active: true, startedAt: now - 45 * 60 * 1000, lastError: null },
      portfolio: [],
      memory: { digest: { text: 'Projets : Orion Studio et Nebula API activés en L3. Deux items de travail détectés dans les ADR.' }, facts: 3, decisions: 1 },
      directives: [{ id: 'dir-demo', scope: 'global', text: 'Toujours ajouter un test de redémarrage quand le journal change.', status: 'active', createdAt: now - 86_400_000, version: 1 }],
      decisions: {
        pending: [{
          id: 'dec-demo-1', kind: 'arbitration', status: 'pending', projectId: 'ws-nebula',
          title: 'Choisir le backend de file d’attente', urgency: 'normal',
          context: 'L’ADR 0008 est encore « Proposed » : la décision n’est pas prise.',
          recommendation: 'Valider l’ADR avant de lancer le travail.',
          options: [{ id: 'a', label: 'Postgres', effect: 'approve' }, { id: 'b', label: 'Redis', effect: 'reject' }],
        }],
        recent: [],
        summary: { pending: 1, total: 1, approvals: 0, arbitrations: 1, urgent: 0 },
      },
      directivesRevoked: [],
      plan: {
        revision: 4, updatedAt: now - 10 * 60 * 1000,
        objectives: [
          { id: 'obj-1', projectId: 'ws-orion', title: 'Tester le renommage atomique du journal', status: 'active', source: 'adr' },
          { id: 'obj-2', projectId: 'ws-nebula', title: 'Durcir la vérification de signature', status: 'active', source: 'issue' },
        ],
        nextActions: [{ id: 'act-1', action: 'launch_work', projectId: 'ws-orion', taskId: null, rationale: 'ADR 0007 accepté, case non cochée' }],
        idleReason: null,
      },
      activity: [
        { at: now - 10 * 60 * 1000, kind: 'cycle', summary: 'Deux items de travail prêts dans Orion Studio ; un ADR proposé en attente de décision.', refs: [] },
        { at: now - 25 * 60 * 1000, kind: 'cycle', summary: 'Session de travail ouverte sur « Add the ADR-0007 journal rename test ».', refs: [] },
      ],
      budget: {
        cyclesPerHour: 6, cyclesThisHour: 2, concurrentAgents: 2, maxConcurrentAgents: 2,
        modelCallsPerHour: 12, modelCallsThisHour: 3, tokenBudget: null,
        metricAvailability: { tokens: false, cost: false, calls: true, cycles: true }, windowStartedAt: now - 20 * 60 * 1000,
      },
      lastCycle: { at: now - 10 * 60 * 1000, trigger: 'scheduled', outcome: 'applied', reason: null, proposals: 2, authorized: 2, applied: 2, refused: 0, decisions: 0, durationMs: 8400 },
      nextWakeAt: now + 5 * 60 * 1000,
      minIntervalMs: 600_000,
      dirty: false,
      failureCount: 0,
      runtime: { available: true, reason: null, activeModel: MODEL },
      work: {
        at: now - 10 * 60 * 1000,
        total: 4,
        ready: [
          { id: 'work-1', projectId: 'ws-orion', source: 'adr', title: 'Write the state file through a temp file and a rename', ref: 'docs/adr/0007-journal.md:12' },
          { id: 'work-2', projectId: 'ws-nebula', source: 'issue', title: 'Add a replay test for the webhook signature', ref: '#142' },
        ],
        needsDecision: [
          { id: 'work-3', projectId: 'ws-nebula', source: 'adr', title: 'Extract the scheduler loop into a worker', ref: 'docs/adr/0008-worker.md:9', reason: 'adr_not_accepted:proposed' },
        ],
      },
      promotions: [],
    },
    dryRun: null,
    projectionSummary: null,
    reconcileNotes: [],
    instance: { primary: true, lockHolder: 'demo' },
    supervision: null,
    events: [],
  }
  // A Map is not JSON: serialize the entries and rebuild it in the page.
  return { host, sessionsList, statusMapEntries: [...statusMap.entries()], workspaces }
}

/** Dark DSH token set: the same aliases the plugin reads, nothing more. */
const TOKENS = `<style>
:root, html, body { color-scheme: dark; }
:root {
  --dsw-alias-bg-base:#141414; --dsw-alias-bg-layer-1:#1f1f1f; --dsw-alias-bg-layer-2:#2a2a2a;
  --dsw-alias-label-primary:#f2f2f2; --dsw-alias-label-secondary:#a3a3a3; --dsw-alias-label-tertiary:#7a7a7a;
  --dsw-alias-border-l2:#2e2e2e; --dsw-alias-border-l3:#3a3a3a; --dsw-alias-brand-primary:#ffffff;
  --dsw-alias-state-success-primary:#22c55e; --dsw-alias-state-warn-primary:#f59e0b;
  --dsw-alias-state-error-primary:#ef4444; --dsw-alias-state-info-primary:#60a5fa;
  --dsw-alias-interactive-bg-hover:#2f2f2f; --dsw-radius-sm:6px; --dsw-radius-md:10px;
  --dsw-elevation-prominent:0 8px 32px #0008;
}
html, body { margin:0; padding:0; background:#141414; color:#f2f2f2; }
body { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
#root { min-height: 100vh; }
.dab-root { width: 100%; min-height: 100vh; }
</style>`

function mountScript() {
  return `<script>
(function () {
  const { createBoardStore, dabMakePage, DAB_CSS, dabInjectStyles } = globalThis.__DAB_INTERNALS__
  const data = globalThis.__DAB_DEMO__
  document.head.insertAdjacentHTML('beforeend', '<style>' + DAB_CSS + '</style>')
  const noopSubscribe = () => () => {}
  const fakeCtx = {
    get(name) {
      if (name === 'sessions') return { list: { getSnapshot: () => data.sessionsList, subscribe: noopSubscribe } }
      if (name === 'uiSession') return { sessionStatus: { getSnapshot: () => new Map(data.statusMapEntries), subscribe: noopSubscribe } }
      if (name === 'workspaces') return { list: { getSnapshot: () => data.workspaces, subscribe: noopSubscribe } }
      return undefined
    },
  }
  const fakeFetch = async url => {
    if (String(url).endsWith('/state')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: data.host }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  class FakeEventSource {
    constructor() { this.readyState = 0 }
    addEventListener() {}
    close() {}
  }
  const store = createBoardStore(fakeCtx, { fetchImpl: fakeFetch, EventSourceImpl: FakeEventSource, apiBase: '/demo' })
  // Load the fake host state BEFORE the first paint: the projection needs the
  // acks/turn-end facts to decide which cards are unread or waiting.
  void store.refreshHost().then(result => {
    const Page = dabMakePage(store, fakeCtx)
    const root = document.getElementById('root')
    ReactDOM.createRoot(root).render(React.createElement(Page))
    document.documentElement.setAttribute('data-demo-ready', 'true')
    if (new URLSearchParams(location.search).get('audit') === '1') {
      setTimeout(() => {
        const box = element => {
          if (element === null) return null
          const rect = element.getBoundingClientRect()
          return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
        }
        const rootEl = document.querySelector('.dab-root')
        const cards = [...document.querySelectorAll('.dab-gcard-wrap')]
        const audit = {
          viewport: { w: window.innerWidth, h: window.innerHeight },
          narrow: rootEl?.getAttribute('data-narrow') ?? null,
          view: rootEl?.getAttribute('data-view') ?? null,
          band: box(document.querySelector('.dab-super')),
          toolbar: box(document.querySelector('.dab-toolbar')),
          rootBox: box(rootEl),
          cards: cards.length,
          firstCard: box(cards[0] ?? null),
          secondCard: box(cards[1] ?? null),
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          bodyBg: getComputedStyle(document.body).backgroundColor,
          cardBg: cards[0] === undefined ? null : getComputedStyle(cards[0]).backgroundColor,
          textColor: rootEl === null ? null : getComputedStyle(rootEl).color,
          titles: cards.slice(0, 8).map(card => card.querySelector('.dab-gcard-name')?.textContent ?? null),
          hostError: store.getSnapshot().hostError ?? null,
        }
        const pre = document.createElement('pre')
        pre.id = 'layout-audit'
        // Readable by the capture script, invisible in the screenshot.
        pre.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden'
        pre.textContent = JSON.stringify(audit)
        document.body.appendChild(pre)
      }, 300)
    }
  })
})()
</script>`
}

async function ensure(url, file) {
  if (existsSync(file)) return
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed: ${url} (${response.status})`)
  await writeFile(file, await response.text(), 'utf8')
}

function findChromium() {
  const candidates = [
    process.env.CHROMIUM,
    join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1200', 'chrome-win64', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(value => typeof value === 'string' && value !== '')
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new Error('no Chromium binary found; set CHROMIUM=/path/to/chrome')
}

async function buildPage() {
  await mkdir(WORK, { recursive: true })
  await mkdir(OUT, { recursive: true })
  await ensure(REACT, join(WORK, 'react.js'))
  await ensure(REACT_DOM, join(WORK, 'react-dom.js'))

  const bundle = await readFile(join(ROOT, 'src', 'client.js'), 'utf8')
  const marker = "    return { name: 'dsh-agent-board/client', inject: ['slots'], apply }"
  if (!bundle.includes(marker)) throw new Error('client bundle shape changed: cannot inject the demo surface')
  const exposed = [
    'createBoardStore', 'dabMakePage', 'DAB_CSS', 'dabInjectStyles',
  ].join(', ')
  const instrumented = bundle.replace(marker, `    globalThis.__DAB_INTERNALS__ = { ${exposed} }\n${marker}`)
  await writeFile(join(WORK, 'client.js'), instrumented, 'utf8')

  const { host, sessionsList, statusMapEntries, workspaces } = buildFakes()
  const data = `globalThis.__DAB_DEMO__ = ${JSON.stringify({ host, sessionsList, statusMapEntries, workspaces })}`
  await writeFile(join(WORK, 'data.js'), data, 'utf8')

  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Agent Board — demo dataset</title>
${TOKENS}
<script src="react.js"></script>
<script src="react-dom.js"></script>
<script>
window.__ModuleLoader__ = { load(definition) { definition.factory(name => (name === 'react' ? React : undefined)) } }
</script>
</head><body><div id="root"></div>
<script src="client.js"></script>
<script src="data.js"></script>
${mountScript()}
</body></html>`
  await writeFile(join(WORK, 'index.html'), html, 'utf8')
  return pathToFileURL(join(WORK, 'index.html')).href
}

/** Resolve a CDP target URL and a websocket page session (no npm dependency). */
async function pollJson(url, timeoutMs = 15_000) {
  const started = Date.now()
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch { /* browser still starting */ }
    if (Date.now() - started > timeoutMs) throw new Error('devtools endpoint unavailable: ' + url)
    await new Promise(resolve => setTimeout(resolve, 120))
  }
}

/**
 * Capture one exact viewport through the DevTools protocol.
 *
 * `--window-size` alone is not trustworthy on Windows (the real window can be
 * clamped to a minimum width), which would silently crop a mobile layout.
 * `Emulation.setDeviceMetricsOverride` sets the CSS viewport the page really
 * lays out in, and the page reports when the fake state is painted, so the PNG
 * is deterministic instead of racing the first render.
 */
async function shoot(chromium, url, { width, height, file, audit = false }) {
  const profile = join(WORK, 'profile-' + width + 'x' + height)
  const port = 9200 + Math.floor(Math.random() * 600)
  const child = spawn(chromium, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--force-device-scale-factor=1', '--allow-file-access-from-files',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' })
  try {
    const targets = await pollJson('http://127.0.0.1:' + port + '/json/list')
    const page = (Array.isArray(targets) ? targets : []).find(target => target.type === 'page')
    if (page === undefined) throw new Error('no page target')
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    let nextId = 0
    const pending = new Map()
    const events = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
        return
      }
      const listeners = events.get(message.method)
      if (listeners !== undefined) for (const listener of [...listeners]) listener(message.params)
    })
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
    const once = method => new Promise(resolve => {
      const listeners = events.get(method) ?? new Set()
      const listener = params => { listeners.delete(listener); resolve(params) }
      listeners.add(listener)
      events.set(method, listeners)
    })
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height,
    })
    const loaded = once('Page.loadEventFired')
    await send('Page.navigate', { url: url + (audit ? '?audit=1' : '') })
    await loaded
    const ready = await send('Runtime.evaluate', {
      awaitPromise: true, returnByValue: true,
      expression: "new Promise(resolve => { const started = Date.now(); const tick = () => { const cards = document.querySelectorAll('.dab-gcard-wrap').length; if (document.documentElement.dataset.demoReady === 'true' && cards > 0) resolve({ cards, width: innerWidth, height: innerHeight }); else if (Date.now() - started > 8000) resolve({ cards, width: innerWidth, height: innerHeight, timeout: true }); else setTimeout(tick, 50) }; tick() })",
    })
    const metrics = ready.result?.value ?? {}
    if (metrics.width !== width) throw new Error('viewport mismatch: ' + JSON.stringify(metrics))
    if (audit) {
      await new Promise(resolve => setTimeout(resolve, 450))
      const report = await send('Runtime.evaluate', { returnByValue: true, expression: "document.getElementById('layout-audit')?.textContent ?? null" })
      if (report.result?.value) console.log('layout ' + width + 'x' + height + ': ' + report.result.value)
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(file, Buffer.from(shot.data, 'base64'))
    if (audit) console.log('audit ' + width + 'x' + height + ': ' + JSON.stringify(metrics))
    socket.close()
    return { file, metrics }
  } finally {
    child.kill()
  }
}

const url = await buildPage()
const chromium = findChromium()
const shots = [
  { width: 1440, height: 900, file: join(OUT, 'demo-dark-desktop.png') },
  { width: 390, height: 844, file: join(OUT, 'demo-dark-mobile.png') },
]
for (const shot of shots) {
  const captured = await shoot(chromium, url, { ...shot, audit: true })
  console.log('captured ' + shot.file + ' (' + shot.width + 'x' + shot.height + ', cards=' + captured.metrics.cards + ', viewport=' + captured.metrics.width + 'x' + captured.metrics.height + ')')
}
console.log('chromium: ' + chromium)
console.log('dataset: ' + isoMinutesAgo(0) + ' — fictional projects Orion Studio / Nebula API / Atlas Docs')
