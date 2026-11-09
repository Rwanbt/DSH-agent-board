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
  assert.equal(snapshot.projection.byId.get('s1').preview.text, 'Last useful segment')

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


