import test from 'node:test'
import assert from 'node:assert/strict'

import { createBoardStore } from '../src/client/core.js'

function makeCtx() {
  const listeners = new Set()
  const sessions = {
    list: {
      getSnapshot: () => ({
        phase: 'ready',
        ids: ['s1', 's2'],
        byId: {
          s1: { id: 's1', displayTitle: 'Main session', running: true },
          s2: { id: 's2', parentId: 's1', displayTitle: 'Explorer sub-agent', origin: 'subagent' },
        },
        projectionsBySession: {},
      }),
      subscribe: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
  return {
    get(name) {
      if (name === 'sessions') return sessions
      return undefined
    },
    __bump: () => { for (const listener of listeners) listener() },
    __listenerCount: () => listeners.size,
  }
}

function fakeFetch(hostState) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/state')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: hostState }) }
    }
    if (String(url).endsWith('/ack')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  impl.calls = calls
  return impl
}

const hostState = {
  mode: 'supervised',
  acks: {},
  previews: { s1: { text: 'Last useful segment', at: 10 } },
  turnEnd: {},
  proposals: [],
  assignments: [],
  routeEvents: [],
  adapters: { adapters: [], executors: [] },
  sync: null,
}

test('store merges native sessions with host state and reacts to native changes', async () => {
  const ctx = makeCtx()
  const fetchImpl = fakeFetch(hostState)
  const store = createBoardStore(ctx, { fetchImpl, EventSourceImpl: undefined })
  store.start()
  await new Promise(resolve => setTimeout(resolve, 30))
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.host.mode, 'supervised')
  assert.equal(snapshot.projection.nodes.length, 2)
  assert.equal(snapshot.projection.byId.get('s2').parentId, 's1')
  // s1 is still running: its mid-turn segment is not presented as a final answer.
  assert.equal(snapshot.projection.byId.get('s1').preview.final, false)
  assert.ok(snapshot.aggregates.get('s1').running)

  const before = store.getSnapshot()
  ctx.__bump()
  const after = store.getSnapshot()
  assert.notEqual(before, after, 'a native session notification must produce a new snapshot')
  store.destroy()
})

test('ack persists through the host API and the store survives destroy', async () => {
  const ctx = makeCtx()
  const fetchImpl = fakeFetch(hostState)
  const store = createBoardStore(ctx, { fetchImpl })
  store.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  const result = await store.ack('s1')
  assert.equal(result.ok, true)
  const ackCall = fetchImpl.calls.find(call => call.url.endsWith('/ack'))
  assert.ok(ackCall !== undefined)
  assert.deepEqual(JSON.parse(ackCall.init.body), { sessionId: 's1' })
  store.destroy()
})

// An EventSource double that records subscribed event types and dispatches
// frames by type, exactly like the browser: `message` reaches onmessage, a
// named event only reaches addEventListener listeners.
function recordingEventSource() {
  const ref = { current: null }
  class RecordingEventSource {
    constructor(url) {
      this.url = url
      this.closed = false
      this.listenedTypes = new Set()
      this.listeners = new Map()
      ref.current = this
    }
    addEventListener(type, handler) {
      this.listenedTypes.add(type)
      if (!this.listeners.has(type)) this.listeners.set(type, [])
      this.listeners.get(type).push(handler)
    }
    emit(type, event) {
      for (const handler of this.listeners.get(type) ?? []) handler(event)
      if (type === 'message' && typeof this.onmessage === 'function') this.onmessage(event)
    }
    close() { this.closed = true }
  }
  return { EventSourceImpl: RecordingEventSource, ref }
}

async function startedStore(options = {}) {
  const ctx = makeCtx()
  const fetchImpl = fakeFetch(hostState)
  const store = createBoardStore(ctx, { fetchImpl, notifyWindowMs: 0, ...options })
  store.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  return { ctx, fetchImpl, store }
}

test('SSE: the named state event updates host state (not only message)', async () => {
  const { EventSourceImpl, ref } = recordingEventSource()
  const { store } = await startedStore({ EventSourceImpl })
  const created = ref.current
  assert.ok(created !== null)
  assert.equal(created.url, '/dsh-agent-board/api/v2/events')
  assert.ok(created.listenedTypes.has('state'), 'the client must subscribe to the named `state` event')

  let notified = 0
  store.subscribe(() => { notified += 1 })
  store.getSnapshot()
  const before = store.getHost()
  const notifiedBefore = notified

  created.emit('state', { data: JSON.stringify({ ...hostState, mode: 'autonomous' }) })

  assert.notEqual(store.getHost(), before, 'the named state frame must replace host state')
  assert.equal(store.getHost().mode, 'autonomous')
  assert.ok(notified > notifiedBefore, 'subscribers must be notified after a named state frame')
  assert.equal(store.getSnapshot().host.mode, 'autonomous')

  // Idempotent: a second connectStream() must not register a duplicate handler.
  store.connectStream()
  assert.equal(created.listeners.get('state').length, 1)
  store.destroy()
})

test('SSE: an unnamed message frame still updates host state', async () => {
  const { EventSourceImpl, ref } = recordingEventSource()
  const { store } = await startedStore({ EventSourceImpl })
  const created = ref.current

  created.emit('message', { data: JSON.stringify({ ...hostState, mode: 'manual' }) })
  assert.equal(store.getHost().mode, 'manual')
  store.destroy()
})

test('SSE: invalid JSON on the state event is ignored and keeps the previous state', async () => {
  const { EventSourceImpl, ref } = recordingEventSource()
  const { store } = await startedStore({ EventSourceImpl })
  const created = ref.current
  const before = store.getHost()

  assert.doesNotThrow(() => created.emit('state', { data: '{not json' }))
  assert.doesNotThrow(() => created.emit('state', {}))
  assert.doesNotThrow(() => created.emit('state', { data: '42' }))
  assert.equal(store.getHost(), before)
  assert.equal(store.getHost().mode, 'supervised')
  store.destroy()
})

test('EventSource updates are applied to the next snapshot', async () => {
  const ctx = makeCtx()
  let created = null
  class FakeEventSource {
    constructor(url) { this.url = url; created = this }
    close() { this.closed = true }
  }
  const fetchImpl = fakeFetch(hostState)
  const store = createBoardStore(ctx, { fetchImpl, EventSourceImpl: FakeEventSource })
  store.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(created.url, '/dsh-agent-board/api/v2/events')
  created.onmessage({ data: JSON.stringify({ ...hostState, mode: 'autonomous' }) })
  assert.equal(store.getSnapshot().host.mode, 'autonomous')
  store.destroy()
  assert.equal(created.closed, true)
})

test('a failing host API is reported without breaking the projection', async () => {
  const ctx = makeCtx()
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) })
  const store = createBoardStore(ctx, { fetchImpl })
  store.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.projection.nodes.length, 2)
  assert.ok(snapshot.hostError.includes('500'))
  store.destroy()
})


