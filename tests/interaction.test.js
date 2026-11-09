import test from 'node:test'
import assert from 'node:assert/strict'

import { createClickArbiter } from '../src/board/interaction.js'

function harness() {
  let clock = 0
  const timers = new Map()
  let nextId = 1
  const log = []
  const arbiter = createClickArbiter({
    onSelect: id => log.push(['select', id]),
    onOpen: id => log.push(['open', id]),
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id },
    clearTimer: id => timers.delete(id),
    now: () => clock,
  })
  const advance = ms => {
    clock += ms
    for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn() }
  }
  return { arbiter, log, advance }
}

test('single click selects after the delay, without opening', () => {
  const { arbiter, log, advance } = harness()
  arbiter.click('a', 1)
  assert.deepEqual(log, [])
  advance(260)
  assert.deepEqual(log, [['select', 'a']])
})

test('double click opens exactly once and cancels the pending single action', () => {
  const { arbiter, log, advance } = harness()
  arbiter.click('a', 1)
  advance(80)
  arbiter.click('a', 2)
  arbiter.doubleClick('a')
  arbiter.doubleClick('a') // duplicated event
  advance(1000)
  assert.deepEqual(log, [['open', 'a']])
})

test('keyboard: Enter opens, Space previews, other keys ignored', () => {
  const { arbiter, log } = harness()
  assert.equal(arbiter.key('a', 'Enter'), true)
  assert.equal(arbiter.key('b', ' '), true)
  assert.equal(arbiter.key('b', 'x'), false)
  assert.deepEqual(log, [['open', 'a'], ['select', 'b']])
})

test('open guard drops a second open of the same id but allows another id', () => {
  const { arbiter, log, advance } = harness()
  arbiter.open('a')
  arbiter.key('a', 'Enter')
  arbiter.open('b')
  advance(900)
  arbiter.open('a')
  assert.deepEqual(log, [['open', 'a'], ['open', 'b'], ['open', 'a']])
})
