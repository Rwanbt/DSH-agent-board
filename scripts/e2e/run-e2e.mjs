#!/usr/bin/env node
/**
 * GOAL 3 (§13.5, §16.17) end-to-end driver on a REAL isolated DSH host.
 *
 * What it proves, with no user credential and no touch of the desktop profile:
 *   a. a fresh `DSH_HOME` + `e2e` profile boots the real DSH web host with this
 *      plugin installed by `link:`, the Agent Board HTTP API answers, and the
 *      board reads a (simulated) Task Board over HTTP;
 *   b. in autonomous mode a Task Board card is dispatched by `POST /tick`, a
 *      real DSH session is created, and its model turn SUCCEEDS against a
 *      scripted OpenAI-compatible provider (evidence: the fake provider's own
 *      request log + the board's `turnEnd`/audit);
 *   c. a scripted 429 leads to the board's classification path: a same-route
 *      retry, then a provider switch to the second fake route, a handoff to a
 *      new session, and a successful turn on the backup — all visible in
 *      `/state` `routeEvents` and `audit`.
 *
 * Everything is simulated at the EDGES (Task Board, model provider). The DSH
 * host, its plugin tree, its sessions, its turn loop and the board's HTTP API
 * are the real product under test.
 *
 * Usage:
 *   node scripts/e2e/run-e2e.mjs
 *   node scripts/e2e/run-e2e.mjs --keep-home --keep-running --pause-file docs/e2e/.e2e-stop
 *   node scripts/e2e/run-e2e.mjs --home D:\App\dsh-e2e-home-goal3
 *
 * Options:
 *   --home <dir>        disposable DSH_HOME (default: <tmp>/dsh-e2e-home-goal3)
 *   --keep-home         do not delete the home after the run
 *   --keep-running      after the scenarios, keep the instance up and wait for
 *                       --pause-file so a human/Playwright can inspect the GUI
 *   --pause-file <p>    stop file for --keep-running (default docs/e2e/.e2e-stop)
 *   --evidence-dir <d>  default docs/e2e
 *   --timeout-scale <n> multiply waits (slow machines), default 1
 *
 * Exit code: 0 only when every required assertion passed; 2 when a scenario
 * could not run in this environment; 1 when the harness or the product failed.
 *
 * @module scripts/e2e/run-e2e
 */

import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer, connect } from 'node:net'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'

import { startFakeLlm } from './fake-llm-server.mjs'
import { startFakeTaskBoard } from './fake-taskboard-server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const DSH_CLI = process.platform === 'win32'
  ? 'C:\\Users\\barat\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd'
  : 'dsh'
const PROFILE = 'e2e'
const BOARD_API = '/dsh-agent-board/api/v2'
const WORKSPACE_ID = 'ws-e2e-1'
const FAKE_KEY_ENV = 'DSH_E2E_FAKE_KEY'
const FAKE_KEY_VALUE = `e2e-invented-key-${randomUUID()}`

const args = process.argv.slice(2)
const option = (name, fallback = null) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const flag = name => args.includes(name)
const timestamp = () => new Date().toISOString()
const log = (...values) => process.stderr.write(`[e2e] ${values.join(' ')}\n`)

const home = resolve(option('--home', join(process.env.TEMP ?? '/tmp', 'dsh-e2e-home-goal3')))
const keepHome = flag('--keep-home')
const keepRunning = flag('--keep-running')
const pauseFile = resolve(option('--pause-file', join(REPO_ROOT, 'docs', 'e2e', '.e2e-stop')))
const evidenceDir = resolve(option('--evidence-dir', join(REPO_ROOT, 'docs', 'e2e')))
const timeoutScale = Math.max(0.2, Number(option('--timeout-scale', '1')) || 1)
const date = option('--date', new Date().toISOString().slice(0, 10))

const results = {
  goal: 'GOAL 3 §13.5 §16.17 — isolated real DSH host + fake OpenAI-compatible provider + fake Task Board',
  date,
  startedAt: timestamp(),
  environment: {
    platform: process.platform,
    release: process.version,
    repoRoot: REPO_ROOT,
    dshCli: DSH_CLI,
    dshVersion: null,
    home,
    profile: PROFILE,
    credentialPolicy: `no real credential: ${FAKE_KEY_ENV} carries an invented value generated for this run`,
  },
  simulation: {},
  host: {},
  scenarios: [],
  board: {},
  assertions: [],
  processOutput: { cli: [], server: [] },
  cleanup: {},
  gaps: [],
}

let fakePrimary = null
let fakeBackup = null
let fakeTaskBoard = null
let dshChild = null
let dshPort = null
let origin = null
let cookie = null
let token = null
let serverOutput = ''

// --------------------------------------------------------------------- utils
/**
 * Build a single cmd.exe command line. The DSH CLI is a `.cmd` shim living under
 * a path with spaces, so the executable MUST be quoted: passing it as argv to
 * `spawn(..., { shell: true })` splits at the first space and fails with
 * "'C:\Users\...\DeepSeek' is not recognized".
 */
function commandLineOf(command, commandArgs) {
  const quote = value => {
    const text = String(value)
    return /[\s"]/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text
  }
  return [quote(command), ...commandArgs.map(quote)].join(' ')
}

function spawnShell(command, commandArgs, options = {}) {
  if (process.platform === 'win32') {
    // `spawn(commandLine, { shell: true })` is the only form that survives a
    // quoted `.cmd` path: passing args to a shell:true spawn re-quotes them
    // (verified against this host's DSH CLI).
    return spawn(commandLineOf(command, commandArgs), { ...options, shell: true, windowsHide: true })
  }
  return spawn(command, commandArgs, options)
}

function spawnCapture(command, commandArgs, options = {}) {
  return new Promise(resolvePromise => {
    const child = spawnShell(command, commandArgs, {
      windowsHide: true,
      cwd: options.cwd ?? REPO_ROOT,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_HOME: home,
        [FAKE_KEY_ENV]: FAKE_KEY_VALUE,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8') })
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* gone */ }
    }, (options.timeoutMs ?? 180_000) * timeoutScale)
    child.on('error', error => {
      clearTimeout(timer)
      resolvePromise({ code: -1, stdout, stderr: `${stderr}\n${String(error?.message ?? error)}` })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

async function poll(label, fn, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs * timeoutScale
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value !== undefined && value !== null && value !== false) return value
    } catch (error) {
      lastError = error
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, intervalMs))
  }
  throw new Error(`${label} timed out after ${Math.round(timeoutMs * timeoutScale)}ms${lastError ? ` (${lastError.message})` : ''}`)
}

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise(resolvePromise => {
    const socket = connect({ port, host })
    const done = value => { socket.destroy(); resolvePromise(value) }
    socket.setTimeout(800)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function pickEphemeralPort() {
  const server = createNetServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const port = server.address().port
  await new Promise(resolvePromise => server.close(resolvePromise))
  return port
}

function killProcessTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(pid, 'SIGKILL')
  } catch { /* already gone */ }
}

async function killPortOwner(port) {
  if (process.platform !== 'win32') return
  try {
    const netstat = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
    const line = netstat.split(/\r?\n/).find(entry => entry.includes(`:${port} `) && entry.includes('LISTENING'))
    if (line !== undefined) {
      const pid = line.trim().split(/\s+/).pop()
      if (pid && /^\d+$/.test(pid)) killProcessTree(pid)
    }
  } catch { /* best effort */ }
}

async function httpJson(method, path, body, { expected = null } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      ...(cookie === null ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON */ }
  if (expected !== null && response.status !== expected) {
    throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`)
  }
  return { status: response.status, json, text }
}

/** HTTP helper for the SIMULATED Task Board (a different origin than DSH). */
async function taskBoardJson(method, path, body, { expected = null } = {}) {
  const response = await fetch(`${fakeTaskBoard.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON */ }
  if (expected !== null && response.status !== expected) {
    throw new Error(`${method} ${path} on simulated Task Board -> HTTP ${response.status}: ${text.slice(0, 300)}`)
  }
  return { status: response.status, json, text }
}

function assert(name, ok, detail = '') {
  results.assertions.push({ name, ok: ok === true, detail })
  log(`${ok === true ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  return ok === true
}

function redact(text) {
  if (typeof text !== 'string') return text
  return text
    .replaceAll(FAKE_KEY_VALUE, '[invented-e2e-key]')
    .replaceAll(token ?? '__none__', '[redacted-token]')
    .replace(/([?&]token=)[^&\s"']+/g, '$1[redacted]')
}

/** Collect `/events` SSE for `durationMs`; returns the raw frames. */
function collectSse(durationMs) {
  return new Promise(resolvePromise => {
    const frames = []
    let buffer = ''
    let bytes = 0
    let error = null
    const req = httpRequest(`${origin}${BOARD_API}/events`, { headers: { cookie: cookie ?? '' } }, res => {
      if (res.statusCode !== 200) { error = `HTTP ${res.statusCode}`; res.resume(); return }
      res.setEncoding('utf8')
      res.on('data', chunk => {
        bytes += chunk.length
        buffer += chunk
        let index = buffer.indexOf('\n\n')
        while (index >= 0) {
          frames.push(buffer.slice(0, index))
          buffer = buffer.slice(index + 2)
          index = buffer.indexOf('\n\n')
        }
      })
      res.on('error', cause => { error = String(cause?.message ?? cause) })
    })
    req.on('error', cause => { error = String(cause?.message ?? cause) })
    req.setTimeout(30_000)
    const timer = setTimeout(() => { try { req.destroy() } catch { /* closed */ } }, Math.max(500, durationMs * timeoutScale))
    setTimeout(() => {
      clearTimeout(timer)
      try { req.destroy() } catch { /* closed */ }
      resolvePromise({ frames, bytes, error })
    }, Math.max(800, durationMs * timeoutScale + 300))
  })
}

function parseSseFrames(frames) {
  return frames.map(frame => {
    const eventMatch = frame.match(/^event:\s*(.+)$/m)
    const dataMatch = frame.match(/^data:\s*(.+)$/m)
    let data = null
    if (dataMatch !== null) { try { data = JSON.parse(dataMatch[1]) } catch { data = null } }
    return { event: eventMatch?.[1] ?? null, data }
  })
}

async function boardState() {
  const { json } = await httpJson('GET', `${BOARD_API}/state`, undefined, { expected: 200 })
  return json.value
}

// ------------------------------------------------------------------ setup
async function ensureSafeHome() {
  if (!basename(home).startsWith('dsh-e2e-home')) {
    throw new Error(`refusing to use/delete a DSH_HOME that is not named dsh-e2e-home-*: ${home}`)
  }
  if (existsSync(home)) {
    log(`removing previous disposable home ${home}`)
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
  await mkdir(join(home, 'project'), { recursive: true })
  await mkdir(join(home, 'storages'), { recursive: true })
  await mkdir(evidenceDir, { recursive: true })
}

async function seedWorkspace() {
  const projectDir = join(home, 'project')
  const now = new Date().toISOString()
  const store = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: WORKSPACE_ID,
      workspaceIds: [WORKSPACE_ID],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        [WORKSPACE_ID]: {
          path: projectDir,
          title: 'e2e-project',
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  }
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify(store, null, 2), 'utf8')
  results.host.workspace = { id: WORKSPACE_ID, path: projectDir, seededStore: 'storages/workspace.json' }
  return projectDir
}

const patchFor = (primaryPort, backupPort, taskBoardPort) => `# E2E harness patch — generated by scripts/e2e/run-e2e.mjs. Disposable profile only.
- id: agent-default-model
  config:
    provider: e2e-primary
    model: e2e-fake-gpt
- id: llm-pi-ai
  config:
    providers:
      e2e-primary:
        displayName: E2E Fake Primary (simulation)
        api: openai-completions
        baseURL: http://127.0.0.1:${primaryPort}/v1
        apiKeyEnv: ${FAKE_KEY_ENV}
        retryPolicy:
          mode: normal
          maxRetries: 0
        models:
          - id: e2e-fake-gpt
            name: E2E Fake GPT
            contextWindow: 65536
            maxTokens: 4096
      e2e-backup:
        displayName: E2E Fake Backup (simulation)
        api: openai-completions
        baseURL: http://127.0.0.1:${backupPort}/v1
        apiKeyEnv: ${FAKE_KEY_ENV}
        retryPolicy:
          mode: normal
          maxRetries: 0
        models:
          - id: e2e-fake-backup-gpt
            name: E2E Fake GPT Backup
            contextWindow: 65536
            maxTokens: 4096
- id: dsh-agent-board
  config:
    baseUrl: http://127.0.0.1:${taskBoardPort}
`

async function createProfileAndInstall() {
  const version = await spawnCapture(DSH_CLI, ['--version'], { timeoutMs: 60_000 })
  results.processOutput.cli.push({ step: 'dsh --version', ...version })
  if (version.code !== 0) {
    throw new Error(`dsh --version failed (exit ${version.code}): ${version.stderr.trim().slice(-800) || version.stdout.trim().slice(-800)}`)
  }
  results.environment.dshVersion = (version.stdout.trim().split(/\r?\n/).pop() ?? '').trim() || null

  const created = await spawnCapture(DSH_CLI, ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], { timeoutMs: 180_000 })
  results.processOutput.cli.push({ step: 'create profile', code: created.code, stdoutTail: created.stdout.slice(-2000), stderrTail: created.stderr.slice(-2000) })
  if (created.code !== 0) throw new Error(`profile creation failed (exit ${created.code}): ${created.stderr.slice(-800)}`)

  const installed = await spawnCapture(DSH_CLI, ['plugin', '--profile', PROFILE, 'add', `link:${REPO_ROOT.replaceAll('\\', '/')}`], { timeoutMs: 240_000 })
  results.processOutput.cli.push({ step: 'install link plugin', code: installed.code, stdoutTail: installed.stdout.slice(-2000), stderrTail: installed.stderr.slice(-2000) })
  if (installed.code !== 0) throw new Error(`plugin link install failed (exit ${installed.code}): ${installed.stderr.slice(-800)}`)
  const manifest = await readFile(join(home, 'profiles', PROFILE, 'package.json'), 'utf8')
  results.host.profile = {
    path: join(home, 'profiles', PROFILE),
    pluginManifest: JSON.parse(manifest),
  }
}

async function bootHost() {
  const patchPath = join(home, 'profiles', PROFILE, 'cordis.patch.yml')
  await writeFile(patchPath, patchFor(fakePrimary.port, fakeBackup.port, fakeTaskBoard.port), 'utf8')
  results.host.patchPath = patchPath
  results.host.patch = redact(patchPath)

  dshChild = spawnShell(DSH_CLI, ['--profile', PROFILE, '--port', '0', '--no-open'], {
    windowsHide: true,
    cwd: join(home, 'project'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: home,
      [FAKE_KEY_ENV]: FAKE_KEY_VALUE,
    },
  })
  let stdout = ''
  let stderr = ''
  let url = null
  dshChild.stdout?.on('data', chunk => {
    stdout += chunk.toString('utf8')
    const match = stdout.match(/dsh web:\s*(http\S+)/)
    if (url === null && match !== null) url = match[1]
  })
  dshChild.stderr?.on('data', chunk => { stderr += chunk.toString('utf8') })
  serverOutput = ''
  dshChild.on('close', code => { serverOutput = `[exit ${code}]\n${stdout}\n${stderr}` })

  const readyUrl = await poll('dsh web startup URL', () => url, { timeoutMs: 120_000, intervalMs: 200 })
  const parsed = new URL(readyUrl)
  dshPort = Number(parsed.port)
  origin = `http://${parsed.host}`
  token = parsed.searchParams.get('token')
  results.host.origin = origin
  results.host.port = dshPort
  results.host.startupUrlRedacted = redact(readyUrl)

  const exchange = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  const setCookies = exchange.headers.getSetCookie?.() ?? []
  cookie = setCookies.map(value => value.split(';')[0]).join('; ')
  if (cookie === '') throw new Error(`token exchange returned no session cookie (HTTP ${exchange.status})`)
  results.host.auth = { exchangeStatus: exchange.status, cookieNames: setCookies.map(value => value.split('=')[0]) }
  results.host.pid = dshChild.pid ?? null
  results.host.cwd = join(home, 'project')

  const state = await poll('board API /state', async () => {
    try {
      const response = await fetch(`${origin}${BOARD_API}/state`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) })
      if (!response.ok) return null
      const json = await response.json()
      return json.value ?? null
    } catch { return null }
  }, { timeoutMs: 90_000, intervalMs: 400 })
  results.host.stateAtBoot = {
    mode: state.mode,
    instance: state.instance,
    adapters: state.adapters,
    sync: state.sync,
  }
  return readyUrl
}

// --------------------------------------------------------------- scenarios
async function configureBoard({ chain, maxRetries = 0, maxSwitches = 1, executionBackend = 'contract' }) {
  const policy = await httpJson('POST', `${BOARD_API}/policy`, {
    policy: {
      mode: 'autonomous',
      executionBackend,
      routeChain: chain,
      maxRetries,
      maxSwitches,
      maxConcurrent: 2,
      allowedProviders: [],
      allowedPermissions: ['read-only', 'workspace-write'],
    },
  }, { expected: 200 })
  const mode = await httpJson('POST', `${BOARD_API}/mode`, { mode: 'autonomous' }, { expected: 200 })
  // `executionBackend: contract` triggers a capability negotiation; wait for the
  // outcome the board itself broadcasts before any tick can be meaningful.
  const negotiation = await poll('execution contract negotiation', async () => {
    const { json } = await httpJson('GET', `${BOARD_API}/contract`, undefined, { expected: 200 })
    return json.value?.writes === true ? json.value : null
  }, { timeoutMs: 20_000, intervalMs: 250 })
  return { policy: policy.json?.value, mode: mode.json?.value, contract: negotiation }
}

const primaryRoute = { provider: 'e2e-primary', model: 'e2e-fake-gpt', locality: 'local' }
const backupRoute = { provider: 'e2e-backup', model: 'e2e-fake-backup-gpt', locality: 'local' }

async function seedTask(task) {
  const response = await taskBoardJson('POST', '/_control/tasks', { task }, { expected: 201 })
  return response.json.value
}

async function finishTask(taskId) {
  // The simulated ledger is a model of the REAL ledger: the session claims and
  // moves it to in_review, so the simulated task must leave `todo`. This also
  // keeps the board's 4 s timer from relaunching it during the next scenario.
  await taskBoardJson('POST', `/_control/tasks/${encodeURIComponent(taskId)}`, { patch: { status: 'in_review' } }, { expected: 200 })
}

async function waitForTurn(sessionId, { timeoutMs = 60_000 } = {}) {
  return poll(`turn end for ${sessionId}`, async () => {
    const state = await boardState()
    if (state.turnEnd?.[sessionId] === undefined) return null
    return { state, turnEnd: state.turnEnd[sessionId], assignment: state.assignments.find(entry => entry.sessionId === sessionId) ?? null }
  }, { timeoutMs, intervalMs: 300 })
}

async function waitForTaskStatus(taskId, statuses, { timeoutMs = 20_000 } = {}) {
  return poll(`simulated ledger status ${statuses.join('/')} for ${taskId}`, async () => {
    const { json } = await taskBoardJson('GET', '/_control/state', undefined, { expected: 200 })
    const task = (json.value?.tasks ?? []).find(entry => entry.id === taskId)
    if (task === undefined) return null
    return statuses.includes(task.status) ? task : null
  }, { timeoutMs, intervalMs: 250 })
}

async function contractCallLog(taskId) {
  // The fake board records every request it receives; the product's own calls
  // are the evidence that lease -> attach -> report/settle really happened.
  const calls = fakeTaskBoard.calls.filter(entry => entry.path.includes(taskId) || /\/executions\//.test(entry.path))
  return calls.map(entry => ({ method: entry.method, path: entry.path, status: entry.body?.ok === false ? 'refused' : 'accepted' }))
}

async function scenarioModelTurn() {
  const scenario = {
    id: 'a-contract-model-turn',
    title: 'Autonomous tick leases a canonical execution, runs a real session turn on the fake provider, attaches, settles to in_review',
    startedAt: timestamp(),
    assertions: [],
    observed: {},
  }
  results.scenarios.push(scenario)
  const taskId = 'tb-e2e-contract'
  await seedTask({
    id: taskId,
    title: 'E2E simulated card — contract happy path',
    description: 'Prove lease -> real DSH session/model turn -> attach -> settle(in_review) through the REAL host.',
    workspaceId: WORKSPACE_ID,
    isolation: 'none',
    permission: 'workspace-write',
    execution: { mode: 'claim' },
  })
  scenario.task = { id: taskId, workspaceId: WORKSPACE_ID, isolation: 'none' }

  const primaryStart = fakePrimary.requests.length
  const backupStart = fakeBackup.requests.length
  const ssePromise = collectSse(12_000)
  const configured = await configureBoard({ chain: [primaryRoute, backupRoute], maxRetries: 0, maxSwitches: 1, executionBackend: 'contract' })
  scenario.contract = configured.contract
  const tick = await httpJson('POST', `${BOARD_API}/tick`, {}, { expected: 200 })
  scenario.tick = tick.json

  const action = (tick.json?.actions ?? []).find(entry => entry.taskId === taskId) ?? null
  let sessionId = action?.sessionId ?? null
  if (sessionId === null) {
    const state = await boardState()
    sessionId = ([...(state.assignments ?? [])].reverse().find(entry => entry.taskId === taskId))?.sessionId ?? null
  }
  scenario.launch = { action, sessionId }
  // No failover is expected here: stop the 4 s timer while the turn completes.
  // A completed turn still settles the canonical execution in OFF mode.
  await httpJson('POST', `${BOARD_API}/mode`, { mode: 'off' }, { expected: 200 })

  if (sessionId !== null) {
    const ended = await waitForTurn(sessionId, { timeoutMs: 60_000 })
    scenario.observed.turnEnd = ended.turnEnd
    scenario.observed.assignment = ended.assignment
  }
  const ledgerTask = await waitForTaskStatus(taskId, ['in_review', 'done'], { timeoutMs: 20_000 })
  scenario.observed.ledgerTask = ledgerTask
  const state = await boardState()
  scenario.observed.stateAfter = summarizeState(state)
  const sse = await ssePromise
  scenario.observed.sse = {
    frames: sse.frames.length,
    named: parseSseFrames(sse.frames).filter(frame => frame.event !== null).length,
    sample: redact(sse.frames.slice(0, 2).join('\n\n')).slice(0, 1200),
  }
  scenario.observed.primaryRequests = fakePrimary.requests.slice(primaryStart).map(requestSummary)
  scenario.observed.backupRequests = fakeBackup.requests.slice(backupStart).map(requestSummary)
  scenario.observed.simulatedBoardCalls = await contractCallLog(taskId)
  scenario.observed.simulatedBoardState = fakeTaskBoard.state()

  const turn = scenario.observed.turnEnd
  const assignment = scenario.observed.assignment ?? {}
  const executions = ledgerTask?.executions ?? []
  const succeeded = executions.find(entry => entry.outcome === 'succeeded')
  const calls = scenario.observed.simulatedBoardCalls
  const sawLease = calls.some(entry => entry.path.endsWith('/executions/lease'))
  const sawAttach = calls.some(entry => entry.path.endsWith('/attach'))
  const sawSettle = calls.some(entry => entry.path.endsWith('/settle'))
  const report = succeeded?.report ?? null

  assert('a1. the execution contract negotiated with writes=true', configured.contract?.writes === true && configured.contract?.simulated === true, JSON.stringify(configured.contract ?? null).slice(0, 400))
  assert('a2. POST /tick launched a real board session on the contract backend', sessionId !== null && action?.ok === true && assignment.backend === 'contract', JSON.stringify({ action, backend: assignment.backend, sessionId }))
  assert('a3. the model turn completed on the fake provider', turn?.kind === 'completed' && fakePrimary.requests.slice(primaryStart).some(entry => entry.status === 200 && entry.sseChunks > 0), JSON.stringify({ turnEnd: turn, primary: fakePrimary.requests.slice(primaryStart).map(entry => ({ status: entry.status, chunks: entry.sseChunks })) }))
  assert('a4. the simulated Task Board received lease -> attach -> settle', sawLease && sawAttach && sawSettle, JSON.stringify(calls))
  assert('a5. the settled execution is in_review with a report and is NEVER done', ledgerTask?.status === 'in_review' && succeeded !== undefined && report?.summary?.length > 0, JSON.stringify({ status: ledgerTask?.status, executions: executions.map(entry => ({ id: entry.id, outcome: entry.outcome, hasReport: entry.report !== undefined, previousExecutionId: entry.previousExecutionId ?? null })) }))
  assert('a6. the board audit recorded contract settlement', (state.audit ?? []).some(entry => entry.type === 'contract_settled'), JSON.stringify((state.audit ?? []).slice(-6).map(entry => entry.type)))
  assert('a7. SSE /events delivered a named state frame', scenario.observed.sse.frames > 0 && scenario.observed.sse.named > 0, JSON.stringify(scenario.observed.sse).slice(0, 300))
  scenario.endedAt = timestamp()
  return scenario
}

async function scenarioContractFailover() {
  const scenario = {
    id: 'b-contract-failover',
    title: 'A scripted 429 on the primary provider makes the board release attempt 1 and lease a SECOND execution with previousExecutionId on the backup route',
    startedAt: timestamp(),
    assertions: [],
    observed: {},
  }
  results.scenarios.push(scenario)
  const taskId = 'tb-e2e-failover'
  await seedTask({
    id: taskId,
    title: 'E2E simulated card — 429 failover',
    description: 'Primary route answers 429 (Retry-After 0); the board must classify rate_limit, switch provider and lease a second canonical execution.',
    workspaceId: WORKSPACE_ID,
    isolation: 'none',
    permission: 'workspace-write',
    execution: { mode: 'claim' },
  })
  scenario.task = { id: taskId }

  const primaryStart = fakePrimary.requests.length
  const backupStart = fakeBackup.requests.length
  fakePrimary.setScript([{ type: 'rate_limit', retryAfterSeconds: 0 }])
  scenario.script = [{ type: 'rate_limit', retryAfterSeconds: 0 }]
  const configured = await configureBoard({ chain: [primaryRoute, backupRoute], maxRetries: 0, maxSwitches: 1, executionBackend: 'contract' })
  scenario.contract = configured.contract
  const tick = await httpJson('POST', `${BOARD_API}/tick`, {}, { expected: 200 })
  scenario.tick = tick.json
  const action = (tick.json?.actions ?? []).find(entry => entry.taskId === taskId) ?? null
  let firstSessionId = action?.sessionId ?? null
  if (firstSessionId === null) {
    const state = await boardState()
    firstSessionId = ([...(state.assignments ?? [])].reverse().find(entry => entry.taskId === taskId))?.sessionId ?? null
  }
  scenario.launch = { action, sessionId: firstSessionId }

  const settled = await waitForTaskStatus(taskId, ['in_review'], { timeoutMs: 40_000 })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1500 * timeoutScale))
  const state = await boardState()
  const taskAssignments = (state.assignments ?? []).filter(entry => entry.taskId === taskId)
  const routeEvents = (state.routeEvents ?? []).filter(entry => entry.taskId === taskId)
  const audit = (state.audit ?? []).filter(entry => JSON.stringify(entry).includes(taskId))
  const executions = settled.executions ?? []
  const first = executions[0] ?? null
  const second = executions[1] ?? null
  const backupSession = taskAssignments.find(entry => entry.model?.provider === 'e2e-backup')
  scenario.observed.assignments = taskAssignments.map(entry => ({
    id: entry.id, attempt: entry.attempt, status: entry.status, backend: entry.backend,
    provider: entry.model?.provider, model: entry.model?.model,
    leaseId: entry.leaseId ?? null, executionId: entry.executionId ?? null,
    routeHistory: entry.routeHistory, outcome: entry.outcome, error: entry.error,
  }))
  scenario.observed.routeEvents = routeEvents
  scenario.observed.audit = audit
  scenario.observed.primaryRequests = fakePrimary.requests.slice(primaryStart).map(requestSummary)
  scenario.observed.backupRequests = fakeBackup.requests.slice(backupStart).map(requestSummary)
  scenario.observed.simulatedBoardCalls = await contractCallLog(taskId)
  scenario.observed.ledgerTask = settled
  scenario.observed.simulatedBoardState = fakeTaskBoard.state()
  scenario.observed.backupTurnEnd = backupSession === undefined ? null : (state.turnEnd?.[backupSession.sessionId] ?? null)

  const switchEvent = routeEvents.find(entry => entry.action === 'switch' && entry.kind === 'rate_limit')
  const primarySaw429 = fakePrimary.requests.slice(primaryStart).some(entry => entry.status === 429)
  const backupSaw200 = fakeBackup.requests.slice(backupStart).some(entry => entry.status === 200)
  const sawRelease = scenario.observed.simulatedBoardCalls.some(entry => entry.path.endsWith('/release'))

  assert('b1. the scripted 429 was classified as rate_limit and routed to a switch', primarySaw429 && switchEvent !== undefined, JSON.stringify({ primarySaw429, routeEvents: routeEvents.map(entry => `${entry.action}:${entry.kind}`) }))
  assert('b2. the board switched to the backup provider route', switchEvent?.to === 'e2e-backup/e2e-fake-backup-gpt' && backupSession?.model?.provider === 'e2e-backup', JSON.stringify(switchEvent ?? null))
  assert('b3. attempt 1 execution was released and executed on the primary provider', sawRelease && first?.outcome === 'cancelled' && first?.route?.provider === 'e2e-primary', JSON.stringify({ sawRelease, first: first === null ? null : { id: first.id, outcome: first.outcome, route: first.route } }))
  assert('b4. a SECOND canonical execution carries previousExecutionId', second !== undefined && second.previousExecutionId === first?.id, JSON.stringify({ executions: executions.map(entry => ({ id: entry.id, previousExecutionId: entry.previousExecutionId ?? null, outcome: entry.outcome, route: entry.route?.provider ?? null })) }))
  assert('b5. the second session ran on the backup route and completed', scenario.observed.backupTurnEnd?.kind === 'completed' && backupSaw200, JSON.stringify({ backupTurnEnd: scenario.observed.backupTurnEnd, backup200: backupSaw200 }))
  assert('b6. the card ended in_review with the second execution report, never done', settled.status === 'in_review' && second?.outcome === 'succeeded' && second?.report?.summary?.length > 0, JSON.stringify({ status: settled.status, second: second === null ? null : { outcome: second.outcome, hasReport: second.report !== undefined } }))
  assert('b7. audit recorded release/handoff/settle', audit.some(entry => entry.type === 'contract_released') && audit.some(entry => entry.type === 'handoff') && audit.some(entry => entry.type === 'contract_settled'), JSON.stringify(audit.map(entry => entry.type)))

  await httpJson('POST', `${BOARD_API}/mode`, { mode: 'off' }, { expected: 200 })
  scenario.endedAt = timestamp()
  return scenario
}

function summarizeState(state) {
  return {
    mode: state.mode,
    stoppedAt: state.stoppedAt,
    lastTick: state.lastTick,
    routeEvents: (state.routeEvents ?? []).slice(-6),
    health: state.health,
    auditTail: (state.audit ?? []).slice(-8),
    assignments: (state.assignments ?? []).slice(-4).map(entry => ({
      id: entry.id,
      taskId: entry.taskId,
      sessionId: entry.sessionId,
      status: entry.status,
      model: entry.model,
      attempts: entry.attempt,
      retries: entry.retries,
      switches: entry.switches,
      outcome: entry.outcome,
      routeHistory: entry.routeHistory,
      error: entry.error,
    })),
    turnEnd: state.turnEnd,
  }
}

function requestSummary(entry) {
  return {
    seq: entry.seq,
    at: entry.at,
    model: entry.model,
    stream: entry.stream,
    behavior: entry.behavior,
    status: entry.status,
    sseChunks: entry.sseChunks,
    ms: entry.ms,
    authorizationPresent: entry.authorizationPresent,
    promptHasTask: entry.promptPreview.includes('tb-e2e'),
    promptPreview: redact(entry.promptPreview).slice(0, 180),
  }
}

async function captureExtensionContract() {
  // The product does not call the proposed execution-ownership endpoints yet
  // (src/connectors/taskboard-contract.js is not present on this branch).
  // Exercise the SIMULATION directly so the semantics are recorded, and state
  // plainly that this is not product behavior.
  const contract = await fetch(`${fakeTaskBoard.url}/dsh-taskboard/contract`)
  const contractJson = await contract.json()
  const taskId = 'tb-e2e-contract-direct'
  await seedTask({ id: taskId, title: 'Extension contract probe', workspaceId: WORKSPACE_ID, isolation: 'none' })
  const contractStatus = contract.status
  const post = async (path, body) => {
    const response = await fetch(`${fakeTaskBoard.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.json().catch(() => null) }
  }
  const lease = await post(`/dsh-taskboard/tasks/${taskId}/executions/lease`, { idempotencyKey: `e2e:${taskId}:1`, expectedVersion: 1 })
  const leaseId = lease.body?.value?.leaseId ?? null
  const replay = leaseId === null ? null : await post(`/dsh-taskboard/tasks/${taskId}/executions/lease`, { idempotencyKey: `e2e:${taskId}:1`, expectedVersion: 1 })
  const conflict = await post(`/dsh-taskboard/tasks/${taskId}/executions/lease`, { idempotencyKey: `e2e:${taskId}:2`, expectedVersion: 1 })
  const attach = leaseId === null ? null : await post(`/dsh-taskboard/executions/${leaseId}/attach`, { sessionId: 'session-e2e-contract' })
  const attachReplay = leaseId === null ? null : await post(`/dsh-taskboard/executions/${leaseId}/attach`, { sessionId: 'session-e2e-contract' })
  const report = leaseId === null ? null : await post(`/dsh-taskboard/executions/${leaseId}/report`, { summary: 'simulated report', changedFiles: [], checks: ['simulation'], artifacts: [], risk: '' })
  const settle = leaseId === null ? null : await post(`/dsh-taskboard/executions/${leaseId}/settle`, { outcome: 'succeeded', requestReview: true, report: { summary: 'simulated settle report' } })
  return {
    simulated: true,
    contract: contractJson.value,
    responses: {
      contract: { status: contractStatus, headers: Object.fromEntries(contract.headers.entries()), body: contractJson.value },
      lease: lease === null ? null : { status: lease.status, simulatedHeader: lease.headers['x-simulated-taskboard'], body: lease.body },
      replay: replay === null ? null : { status: replay.status, body: replay.body },
      conflict: { status: conflict.status, body: conflict.body },
      attach: attach === null ? null : { status: attach.status, body: attach.body },
      attachReplay: attachReplay === null ? null : { status: attachReplay.status, body: attachReplay.body },
      report: report === null ? null : { status: report.status, body: report.body },
      settle: settle === null ? null : { status: settle.status, body: settle.body },
    },
    note: 'Direct exercise of the SIMULATED Task Board extension semantics; the product itself also drove the same endpoints in scenarios a/b.',
  }
}

// ------------------------------------------------------------------ report
async function writeEvidence({ finished = false } = {}) {
  results.finishedAt = finished ? timestamp() : null
  results.processOutput.server = [redact(serverOutput).slice(-6000)]
  results.board.finalState = results.board.finalState ?? null
  const jsonPath = join(evidenceDir, `GOAL3-E2E-${date}.json`)
  await writeFile(jsonPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
  return jsonPath
}

function markdownOf() {
  const lines = []
  const p = value => (value === undefined || value === null ? '' : String(value))
  const executed = results.assertions.filter(entry => entry.ok).length
  const failedAssertions = results.assertions.filter(entry => !entry.ok)
  const verdict = (
    results.fatalError !== undefined ||
    results.assertions.length === 0 ||
    results.scenarios.length === 0 ||
    failedAssertions.length > 0
  ) ? 'FAIL' : 'PASS'
  lines.push(`# GOAL 3 E2E — isolated real DSH host + fake OpenAI-compatible provider + fake Task Board`)
  lines.push('')
  lines.push(`- Date: ${results.date}`)
  lines.push(`- Started: ${results.startedAt}`)
  lines.push(`- Verdict: **${verdict}** (${executed}/${results.assertions.length} assertions passed, ${results.scenarios.length} scenario(s) executed${results.fatalError === undefined ? '' : ', FATAL ERROR'})`)
  if (results.fatalError !== undefined) lines.push(`- Fatal: \`${String(results.fatalError).slice(0, 800)}\``)
  lines.push(`- DSH CLI: \`${results.environment.dshCli}\` (${p(results.environment.dshVersion)})`)
  lines.push(`- Disposable \`DSH_HOME\`: \`${results.host.home ?? results.environment.home}\``)
  lines.push(`- Profile: \`${PROFILE}\` (created from the shipped \`web\` template, plugin installed with \`link:${REPO_ROOT.replaceAll('\\', '/')}\`)`)
  lines.push(`- Model provider: **simulated** OpenAI-compatible server on \`127.0.0.1\` (port ${p(fakePrimary?.port)} primary, ${p(fakeBackup?.port)} backup)`)
  lines.push(`- Task Board: **simulated** ledger on \`127.0.0.1:${p(fakeTaskBoard?.port)}\` — every response carries \`x-simulated-taskboard: true\``)
  lines.push('- Credentials: **none**. The provider route uses an invented environment value; the desktop profile was never read or written.')
  lines.push('')
  lines.push('## Commands actually run')
  lines.push('')
  lines.push('```powershell')
  lines.push(`$env:DSH_HOME = '${results.environment.home}'`)
  lines.push(`& '${DSH_CLI}' --profile ${PROFILE} --from-default-profile web --dump-config`)
  lines.push(`& '${DSH_CLI}' plugin --profile ${PROFILE} add link:${REPO_ROOT.replaceAll('\\', '/')}`)
  lines.push(`& '${DSH_CLI}' --profile ${PROFILE} --port 0 --no-open   # prints dsh web: http://127.0.0.1:<port>/?token=…`)
  lines.push('```')
  lines.push('')
  lines.push('The orchestrator then exchanged the launch token for the signed session cookie and used the board API:')
  lines.push('')
  lines.push('```text')
  lines.push(`GET  ${BOARD_API}/state`)
  lines.push(`POST ${BOARD_API}/policy   { executionBackend: "contract", routeChain: [e2e-primary, e2e-backup], maxRetries: 0, maxSwitches: 1 }`)
  lines.push(`GET  ${BOARD_API}/contract  -> { writes: true, version: 1 }`)
  lines.push(`POST ${BOARD_API}/mode     { mode: "autonomous" }`)
  lines.push(`POST ${BOARD_API}/tick`)
  lines.push(`GET  ${BOARD_API}/events   (SSE)`)
  lines.push('```')
  lines.push('')
  lines.push('## What ran and what was observed')
  lines.push('')
  for (const scenario of results.scenarios) {
    lines.push(`### ${scenario.id} — ${scenario.title}`)
    lines.push('')
    const observed = scenario.observed ?? {}
    if (scenario.id.startsWith('a')) {
      lines.push(`- Contract: \`${JSON.stringify(scenario.contract ?? null).slice(0, 500)}\``)
      lines.push(`- Tick: \`${JSON.stringify(scenario.tick?.actions ?? [])}\``)
      lines.push(`- Session: \`${p(scenario.launch?.sessionId)}\` — \`turnEnd\`: \`${JSON.stringify(observed.turnEnd ?? null)}\``)
      lines.push(`- Fake provider requests: \`${JSON.stringify((observed.primaryRequests ?? []).map(entry => ({ seq: entry.seq, status: entry.status, chunks: entry.sseChunks, model: entry.model })))}\``)
      lines.push(`- Assignment: \`status=${p(observed.assignment?.status)}\`, \`backend=${p(observed.assignment?.backend)}\`, \`leaseId=${p(observed.assignment?.leaseId)}\`, \`executionId=${p(observed.assignment?.executionId)}\``)
      lines.push(`- Simulated Task Board calls (by the REAL product): \`${JSON.stringify((observed.simulatedBoardCalls ?? []).map(entry => `${entry.method} ${entry.path}`))}\``)
      lines.push(`- Simulated ledger task: \`status=${p(observed.ledgerTask?.status)}\`, executions: \`${JSON.stringify((observed.ledgerTask?.executions ?? []).map(entry => ({ id: entry.id, outcome: entry.outcome, previousExecutionId: entry.previousExecutionId ?? null, hasReport: entry.report !== undefined })))}\``)
      lines.push(`- SSE: ${p(observed.sse?.frames)} frame(s), ${p(observed.sse?.named)} named — sample below.`)
      lines.push('')
      lines.push('```text')
      lines.push(redact(observed.sse?.sample ?? '').slice(0, 700))
      lines.push('```')
    } else {
      lines.push(`- Tick: \`${JSON.stringify(scenario.tick?.actions ?? [])}\``)
      lines.push(`- \`routeEvents\`: \`${JSON.stringify(observed.routeEvents ?? [], null, 0)}\``)
      lines.push(`- Primary provider: ${p((observed.primaryRequests ?? []).filter(entry => entry.status === 429).length)} × 429, ${p((observed.primaryRequests ?? []).filter(entry => entry.status === 200).length)} × 200.`)
      lines.push(`- Backup provider: ${p((observed.backupRequests ?? []).filter(entry => entry.status === 200).length)} × 200.`)
      lines.push(`- Assignments: \`${JSON.stringify((observed.assignments ?? []).map(entry => ({ attempt: entry.attempt, status: entry.status, provider: entry.provider, leaseId: entry.leaseId, executionId: entry.executionId, history: entry.routeHistory?.map(h => h.kind) })))}\``)
      lines.push(`- Simulated executions: \`${JSON.stringify((observed.ledgerTask?.executions ?? []).map(entry => ({ id: entry.id, outcome: entry.outcome, previousExecutionId: entry.previousExecutionId ?? null, route: entry.route?.provider ?? null, hasReport: entry.report !== undefined })))}\``)
      lines.push(`- Final simulated ledger status: \`${p(observed.ledgerTask?.status)}\` (never \`done\`)`)
      lines.push(`- Audit: \`${JSON.stringify((observed.audit ?? []).map(entry => entry.type))}\``)
    }
    lines.push('')
  }
  lines.push('## Assertions')
  lines.push('')
  for (const entry of results.assertions) {
    lines.push(`- ${entry.ok ? '✅' : '❌'} **${entry.name}** — ${entry.detail}`)
  }
  lines.push('')
  lines.push('## Live vs simulated')
  lines.push('')
  lines.push('| Part | Nature |')
  lines.push('|---|---|')
  lines.push('| DSH CLI, profile tree, plugin load by link, web host, launch-token auth, `/dsh-agent-board/api/v2/*` | **live** (real product on an isolated `DSH_HOME`) |')
  lines.push('| DSH sessions, agent loop, tool-less model turn, turn-end events | **live** (the real `ctx.agents` path of the plugin) |')
  lines.push('| `GET /dsh-taskboard/state` read by `src/connectors/taskboard.js` | **live client code, simulated server** (banner + `x-simulated-taskboard: true`) |')
  lines.push('| Model provider (`GET /v1/models`, streaming `POST /v1/chat/completions`) | **simulated** OpenAI-compatible server, deterministic |')
  lines.push('| Execution-ownership extension (`contract` / `lease` / `attach` / `report` / `release` / `settle`) | **live client code, simulated server** — the REAL product negotiated, leased, attached, released and settled against `scripts/e2e/fake-taskboard-server.mjs`; the real `dsh-taskboard` plugin does not implement this extension yet |')
  lines.push('')
  if (results.extensionContract !== undefined) {
    lines.push('### Extension semantics, exercised directly as well')
    lines.push('')
    const responses = results.extensionContract.responses
    lines.push('```text')
    lines.push(`GET  /dsh-taskboard/contract           -> HTTP ${p(responses.contract?.status)} advertised ${JSON.stringify(results.extensionContract.contract?.contract?.features ?? [])}`)
    lines.push(`POST /tasks/${'tb-e2e-contract-direct'}/executions/lease -> HTTP ${p(responses.lease?.status)} ${JSON.stringify(responses.lease?.body?.value ?? responses.lease?.body)}`)
    lines.push(`POST lease replay (same key)           -> HTTP ${p(responses.replay?.status)} (idempotent, same lease)`)
    lines.push(`POST lease (different key)             -> HTTP ${p(responses.conflict?.status)} ${JSON.stringify(responses.conflict?.body?.error ?? null)}`)
    lines.push(`POST attach                            -> HTTP ${p(responses.attach?.status)} ${JSON.stringify(responses.attach?.body?.value ?? null)}`)
    lines.push(`POST report                            -> HTTP ${p(responses.report?.status)} ${JSON.stringify(responses.report?.body?.value ?? null)}`)
    lines.push(`POST settle                            -> HTTP ${p(responses.settle?.status)} ${JSON.stringify(responses.settle?.body?.value ?? null)}`)
    lines.push('```')
    lines.push('')
  }
  lines.push('## UX preserved (isolated instance)')
  lines.push('')
  const screenshots = (results.screenshots ?? []).filter(name => name.endsWith('.png'))
  if (screenshots.length === 0) {
    lines.push('_No screenshot was captured in this run._')
  } else {
    lines.push('The Agent Board panel in the isolated instance (same client bundle as the product) was captured by Playwright:')
    lines.push('')
    for (const name of screenshots) lines.push(`- [\`${name}\`](screenshots/${name})`)
    lines.push('')
    if (results.uiObservation !== undefined) {
      lines.push('```json')
      lines.push(JSON.stringify(results.uiObservation, null, 2))
      lines.push('```')
    }
  }
  lines.push('')
  lines.push('## Limits / gaps (honest)')
  lines.push('')
  for (const gap of results.gaps) lines.push(`- ${gap}`)
  lines.push('')
  lines.push('## Cleanup')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(results.cleanup, null, 2))
  lines.push('```')
  lines.push('')
  return `${lines.join('\n')}\n`
}

async function writeMarkdown() {
  const md = markdownOf()
  const path = join(evidenceDir, 'GOAL3-E2E.md')
  await writeFile(path, md, 'utf8')
  return path
}

async function listScreenshots() {
  try {
    const names = await readdir(join(evidenceDir, 'screenshots'))
    return names.filter(name => name.startsWith('goal3-ux-') && name.endsWith('.png')).sort()
  } catch {
    return []
  }
}

// -------------------------------------------------------------------- main
async function main() {
  results.host.home = home
  await ensureSafeHome()
  await seedWorkspace()

  fakePrimary = await startFakeLlm({ model: 'e2e-fake-gpt' })
  fakeBackup = await startFakeLlm({ model: 'e2e-fake-backup-gpt' })
  fakeTaskBoard = await startFakeTaskBoard({ workspaceId: WORKSPACE_ID })
  results.simulation = {
    primaryProvider: { url: fakePrimary.baseURL, model: 'e2e-fake-gpt' },
    backupProvider: { url: fakeBackup.baseURL, model: 'e2e-fake-backup-gpt' },
    taskBoard: { url: fakeTaskBoard.url, simulatedHeader: 'x-simulated-taskboard: true' },
  }
  log(`fake providers: ${fakePrimary.baseURL} / ${fakeBackup.baseURL}; fake Task Board: ${fakeTaskBoard.url}`)

  await createProfileAndInstall()
  const startupUrl = await bootHost()
  results.host.startupUrl = redact(startupUrl)

  const models = await fetch(`${fakePrimary.baseURL}/models`, { signal: AbortSignal.timeout(5000) }).then(async response => ({ status: response.status, body: await response.json() }))
  results.simulation.primaryModels = models
  assert('0. the fake OpenAI-compatible provider answers GET /v1/models', models.status === 200 && Array.isArray(models.body?.data) && models.body.data[0]?.id === 'e2e-fake-gpt', JSON.stringify({ status: models.status, models: (models.body?.data ?? []).map(model => model.id) }))

  try {
    await scenarioModelTurn()
  } catch (error) {
    assert('a0. scenario a ran to completion', false, String(error?.message ?? error))
    results.gaps.push(`Scenario a could not complete: ${String(error?.message ?? error)}`)
  }
  try {
    await scenarioContractFailover()
  } catch (error) {
    assert('b0. scenario b ran to completion', false, String(error?.message ?? error))
    results.gaps.push(`Scenario b could not complete: ${String(error?.message ?? error)}`)
  }

  try {
    results.extensionContract = await captureExtensionContract()
  } catch (error) {
    results.extensionContract = { simulated: true, error: String(error?.message ?? error) }
    results.gaps.push(`Extension contract probe failed: ${String(error?.message ?? error)}`)
  }

  results.board.finalState = summarizeState(await boardState())
  results.taskboard = {
    state: fakeTaskBoard.state(),
    calls: fakeTaskBoard.calls.slice(-40),
  }
  results.simulation.primaryRequests = fakePrimary.requests.map(requestSummary)
  results.simulation.backupRequests = fakeBackup.requests.map(requestSummary)

  results.gaps.push(
    'The real `dsh-taskboard` plugin (0.10/0.11) does NOT implement the execution-ownership extension. The contract path is proven against a SIMULATED Task Board (clearly headed `x-simulated-taskboard: true`), so it proves the board side of the contract, not a live Task Board integration.',
    'The Agent Board connector reports `validatedLive: false` by design; the ledger read was made against the simulation.',
    'The fake provider is deterministic and tool-less; it proves the transport + turn loop, not real model quality or reasoning.',
    'Only a 429 was driven through the board classifier in this run. 500/401/timeout/partial-stream/unknown-model behaviours are implemented and scriptable in the fake provider but were not routed through a board turn.',
    'The simulated ledger is updated by the harness only to seed cards; the reviewed transition to `in_review` in the contract scenarios is performed by the REAL board settle call, not by the harness.',
  )
  if (results.scenarios.length < 2) results.gaps.push('One scenario did not run; see the failed assertion detail.')

  let jsonPath = await writeEvidence({ finished: false })
  let mdPath = await writeMarkdown()

  if (keepRunning) {
    await rm(pauseFile, { force: true })
    log(`READY_FOR_UI ${redact(startupUrl)}`)
    log(`instance kept alive; create ${pauseFile} (or press Ctrl+C) to clean up`)
    process.stderr.write(`E2E_READY ${JSON.stringify({ url: startupUrl, port: dshPort, home, pauseFile })}\n`)
    await poll('pause file', async () => existsSync(pauseFile), { timeoutMs: 30 * 60_000, intervalMs: 1000 })
  }

  await cleanup()

  results.cleanup.finishedAt = timestamp()
  results.finishedAt = timestamp()
  jsonPath = await writeEvidence({ finished: true })
  mdPath = await writeMarkdown()
  log(`evidence: ${jsonPath}`)
  log(`report:   ${mdPath}`)
  const failed = results.assertions.filter(entry => !entry.ok)
  if (failed.length > 0) {
    log(`FAILED assertions: ${failed.map(entry => entry.name).join(', ')}`)
    process.exitCode = 1
  }
}

async function cleanup() {
  if (dshChild !== null) {
    killProcessTree(dshChild.pid)
    dshChild = null
    if (dshPort !== null) {
      const closed = await poll('DSH port closed', async () => !(await isPortOpen(dshPort)), { timeoutMs: 20_000, intervalMs: 300 }).then(() => true).catch(() => false)
      if (!closed) {
        await killPortOwner(dshPort)
        await new Promise(resolvePromise => setTimeout(resolvePromise, 1500))
      }
      results.cleanup.portClosed = !(await isPortOpen(dshPort))
    }
  }
  for (const [name, server] of [['primaryProvider', fakePrimary], ['backupProvider', fakeBackup], ['taskBoard', fakeTaskBoard]]) {
    if (server === null || server === undefined) continue
    try { await server.close() } catch (error) { results.gaps.push(`closing ${name} failed: ${String(error?.message ?? error)}`) }
  }
  results.cleanup.serversClosed = true
  if (keepHome) {
    results.cleanup.homeKept = { path: home, reason: '--keep-home requested; disposable profile + sessions kept for inspection' }
  } else {
    try {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      results.cleanup.homeRemoved = home
    } catch (error) {
      results.cleanup.homeRemovalError = String(error?.message ?? error)
    }
  }
  results.cleanup.screenshots = await listScreenshots()
  results.screenshots = results.cleanup.screenshots
  results.cleanup.desktopProfileTouched = false
  // A human/Playwright session may drop its observation (panel presence,
  // console errors) next to the evidence before the instance is released.
  try {
    const observationPath = join(evidenceDir, '.ui-observation.json')
    results.uiObservation = JSON.parse(await readFile(observationPath, 'utf8'))
    await rm(observationPath, { force: true })
  } catch { /* no observation file */ }
}

process.on('SIGINT', () => {
  log('interrupted; cleaning up')
  void cleanup().finally(() => process.exit(130))
})

main().catch(async error => {
  results.fatalError = String(error?.stack ?? error)
  log(`FATAL ${results.fatalError}`)
  try { await cleanup() } catch { /* best effort */ }
  try { await writeEvidence({ finished: false }); await writeMarkdown() } catch { /* best effort */ }
  process.exit(2)
})
