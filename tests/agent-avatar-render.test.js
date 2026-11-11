import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dabAgentAvatarModel } from '../src/contracts/agent-roles.js'
import { AGENT_BOT_ASSETS } from '../src/client/ui/agent-bots-assets.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const AVATAR_SOURCE = await readFile(join(ROOT, 'src', 'client', 'ui', 'avatar.js'), 'utf8')

// The bundle concatenates this module, so it must stay a plain script. The smoke
// test evaluates it exactly that way, with a minimal React stub and the real
// pure model — no JSX transform, no DOM, no HTML sink.
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  },
}

const LABELS = {
  statusRunning: 'Running',
  statusWaiting: 'Needs your action',
  statusRecovering: 'Recovering',
  statusInterrupted: 'Interrupted',
  statusUnread: 'Finished — not viewed',
  statusRead: 'Finished',
  statusFailed: 'Failed',
  statusIdle: 'Idle',
  statusUnknown: 'Unknown / disconnected',
  taskInReview: 'In review',
  task: 'Task',
  agent: 'Agent',
}
const dabT = key => LABELS[key] ?? key

globalThis.AGENT_BOT_ASSETS = AGENT_BOT_ASSETS
const factory = new Function('React', 'dabAgentAvatarModel', 'dabT', `${AVATAR_SOURCE}\nreturn DabAgentAvatar`)
const DabAgentAvatar = factory(React, dabAgentAvatarModel, dabT)

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function byClass(tree, className) {
  const matches = []
  walk(tree, node => {
    const value = node.props?.className
    if (typeof value === 'string' && value.split(/\s+/).includes(className)) matches.push(node)
  })
  return matches
}

function byType(tree, type) {
  const matches = []
  walk(tree, node => { if (node.type === type) matches.push(node) })
  return matches
}

const render = props => DabAgentAvatar(props)

test('the module has no JSX and no HTML sink', () => {
  assert.doesNotMatch(AVATAR_SOURCE, /dangerouslySetInnerHTML\s*:/)
  assert.doesNotMatch(AVATAR_SOURCE, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/)
  assert.doesNotMatch(AVATAR_SOURCE, /<[a-z][\w-]*\s+[^>]*>/i, 'no JSX/HTML markup literal')
  assert.doesNotMatch(AVATAR_SOURCE, /animation\s*:/, 'no animation in the component')
  assert.match(AVATAR_SOURCE, /React\.createElement/)
})

test('renders a declared role: wrapper name, mascot data URI and separate status dot', () => {
  const tree = render({ role: 'worker', name: 'Ada', status: 'running', size: 64 })
  assert.equal(tree.type, 'span')
  assert.equal(tree.props.className, 'dab-avatar')
  assert.equal(tree.props.role, 'img')
  assert.equal(tree.props['aria-label'], 'Ada — Worker — Running')
  assert.equal(tree.props['data-role'], 'worker')
  assert.equal(tree.props['data-tone'], 'active')
  assert.equal(tree.props['data-variant'], 'full')
  assert.equal(tree.props['data-size'], '64')
  assert.equal(tree.props.style['--dab-avatar-size'], '64px')
  assert.equal(tree.props['aria-hidden'], undefined)

  const images = byType(tree, 'img')
  assert.equal(images.length, 1)
  assert.equal(images[0].props.src, AGENT_BOT_ASSETS.worker.full)
  assert.equal(images[0].props.alt, '', 'the wrapper carries the accessible name')

  const dots = byClass(tree, 'dab-avatar-dot')
  assert.equal(dots.length, 1)
  assert.equal(dots[0].props['data-tone'], 'active')
  assert.ok(tree.children.includes(dots[0]), 'the dot is a sibling of the mascot, not part of it')
  assert.equal(dots[0].props.style, undefined, 'the dot colour is a stylesheet decision, never the mascot colour')
  assert.equal(byClass(tree, 'dab-avatar-task').length, 0)
})

test('the default 40px uses the compact variant and the size reaches CSS', () => {
  const tree = render({ role: 'worker', name: 'Ada', status: 'idle' })
  assert.equal(tree.props['data-variant'], 'compact')
  assert.equal(tree.props['data-size'], '40')
  assert.equal(tree.props.style['--dab-avatar-size'], '40px')
  assert.equal(byType(tree, 'img')[0].props.src, AGENT_BOT_ASSETS.worker.compact)
})

test('role colour never expresses status and the status dot stays separate', () => {
  const tree = render({ role: 'worker', name: 'Ada', status: 'failed', size: 64 })
  assert.equal(tree.props['data-role'], 'worker')
  assert.equal(tree.props['data-tone'], 'blocked')
  const dot = byClass(tree, 'dab-avatar-dot')[0]
  assert.equal(dot.props['data-tone'], 'blocked')
  const images = byType(tree, 'img')
  assert.equal(images.length, 1)
  assert.ok(images[0].props.src.startsWith('data:image/svg+xml;base64,'))
  walk(tree, node => {
    const style = node.props?.style
    if (style === undefined) return
    if (typeof style === 'object' && style !== null) {
      assert.equal(style.backgroundColor, undefined, 'no inline status colour')
      assert.equal(style.background, undefined)
      assert.equal(style.color, undefined)
    }
  })
})

test('an in-review task renders a chip without changing the agent tone', () => {
  const tree = render({ role: 'worker', name: 'Ada', status: 'running', taskState: 'in_review', size: 64 })
  assert.equal(tree.props['data-tone'], 'active')
  const chips = byClass(tree, 'dab-avatar-task')
  assert.equal(chips.length, 1)
  assert.equal(chips[0].props['data-tone'], 'reviewing')
  assert.deepEqual(chips[0].children, ['In review'])
  assert.match(chips[0].props.title, /Task · In review/)
})

test('an unknown role gets the neutral grey mark, never a guessed mascot', () => {
  const tree = render({ role: 'not-a-role', name: 'Ghost', size: 64 })
  assert.equal(tree.props['data-role'], 'generic')
  assert.equal(byType(tree, 'img').length, 0, 'no mascot data URI for an unknown role')
  const marks = byClass(tree, 'dab-avatar-generic')
  assert.equal(marks.length, 1)
  assert.equal(marks[0].type, 'svg')
  assert.equal(marks[0].props['aria-hidden'], 'true')
  assert.equal(tree.props['aria-label'], 'Ghost')
  const painted = []
  walk(marks[0], node => {
    if (node.props?.fill !== undefined) painted.push(node.props.fill)
    if (node.props?.stroke !== undefined) painted.push(node.props.stroke)
  })
  assert.ok(painted.includes('#7E8B9C'), 'the fallback is grey')
  assert.ok(!painted.some(color => /^#[0-9a-f]{6}$/i.test(color) && color.toUpperCase() !== '#7E8B9C'), 'no role colour')
})

test('a known role with a missing source also falls back, without crashing', () => {
  const tree = render({ role: 'worker', name: 'Ada', status: 'idle', sources: null, size: 64 })
  assert.equal(byType(tree, 'img').length, 0)
  assert.equal(byClass(tree, 'dab-avatar-generic').length, 1)
  assert.equal(tree.props['data-role'], 'worker')
  assert.equal(tree.props['aria-label'], 'Ada — Worker — Idle')
})

test('the generic identity still renders its own status dot', () => {
  const tree = render({ role: null, name: 'Nobody', status: 'failed', sources: null })
  assert.equal(tree.props['data-role'], 'generic')
  assert.equal(byClass(tree, 'dab-avatar-dot')[0].props['data-tone'], 'blocked')
  assert.equal(tree.props['aria-label'], 'Nobody — Failed')
})

test('selected and decorative states are explicit', () => {
  const plain = render({ role: 'worker', name: 'Ada', size: 64 })
  assert.equal(plain.props['data-selected'], 'false')
  const selected = render({ role: 'worker', name: 'Ada', size: 64, selected: true })
  assert.equal(selected.props['data-selected'], 'true')
  const decorative = render({ role: 'worker', name: 'Ada', size: 64, decorative: true })
  assert.equal(decorative.props['aria-hidden'], 'true')
  assert.equal(decorative.props.role, undefined)
  assert.equal(decorative.props['aria-label'], undefined)
  assert.equal(byType(decorative, 'img').length, 1, 'decorative still renders the visual')
  assert.equal(byClass(decorative, 'dab-avatar-dot').length, 1)
})

test('the super orchestrator renders the crown or the bolt emblem', () => {
  const crown = render({ role: 'super_orchestrator', name: 'Top', size: 64 })
  assert.equal(crown.props['data-emblem'], 'crown')
  assert.equal(byType(crown, 'img')[0].props.src, AGENT_BOT_ASSETS.super_orchestrator.full)
  const bolt = render({ role: 'super_orchestrator', name: 'Top', emblem: 'bolt', size: 64 })
  assert.equal(bolt.props['data-emblem'], 'bolt')
  assert.equal(byType(bolt, 'img')[0].props.src, AGENT_BOT_ASSETS.super_orchestrator_bolt.full)
  const ordinary = render({ role: 'orchestrator', name: 'Orc', emblem: 'bolt', size: 64 })
  assert.equal(ordinary.props['data-emblem'], undefined)
})

test('unknown statuses render the neutral idle tone', () => {
  const tree = render({ role: 'worker', name: 'Ada', status: 'not_a_status', size: 64 })
  assert.equal(tree.props['data-tone'], 'idle')
  assert.equal(byClass(tree, 'dab-avatar-dot')[0].props['data-tone'], 'idle')
})
