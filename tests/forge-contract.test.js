/**
 * Forge adapter contract tests against a FAKE GitHub API.
 *
 * No network, no token, no repository: these tests pin the connector contract
 * (capabilities, pagination bound, rate-limit classification, credential
 * refusal, conflict token, secret hygiene). They do NOT claim a live
 * integration — `validatedLive` stays false.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createGithubAdapter, nextLinkOf } from '../src/connectors/github.js'

function response({ status = 200, body = [], headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
  }
}

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  impl.calls = calls
  return impl
}

const issue = (number, extra = {}) => ({
  number,
  title: `Issue ${number}`,
  state: 'open',
  html_url: `https://github.com/o/r/issues/${number}`,
  updated_at: `2026-11-0${number}T00:00:00Z`,
  labels: [{ name: 'bug' }],
  ...extra,
})

test('github: bounded pagination follows Link rel=next and reports truncation', async () => {
  let page = 0
  const fetchImpl = fakeFetch(async url => {
    page += 1
    if (page === 1) {
      return response({
        body: [issue(1)],
        headers: { link: `<https://api.github.com/repos/o/r/issues?state=open&per_page=50&page=2>; rel="next"` },
      })
    }
    if (page === 2) {
      return response({
        body: [issue(2, { pull_request: { url: 'x' } })],
        headers: { link: `<https://api.github.com/repos/o/r/issues?state=open&per_page=50&page=3>; rel="next"` },
      })
    }
    return response({ body: [issue(3)] })
  })
  const adapter = createGithubAdapter({ repository: 'o/r', token: '', fetchImpl })
  const listed = await adapter.list()
  assert.deepEqual(listed.items.map(item => item.canonicalId), ['github:1', 'github:2', 'github:3'])
  assert.equal(listed.items[1].kind, 'pull_request')
  assert.equal(listed.meta.pages, 3)
  assert.equal(listed.meta.truncated, false)
  assert.equal(fetchImpl.calls[0].url.includes('per_page=50'), true)
})

test('github: the page walk is capped instead of looping forever', async () => {
  const fetchImpl = fakeFetch(async () =>
    response({
      body: [issue(1)],
      headers: { link: `<https://api.github.com/repos/o/r/issues?page=99>; rel="next"` },
    }))
  const adapter = createGithubAdapter({ repository: 'o/r', token: '', fetchImpl })
  const listed = await adapter.list()
  assert.equal(listed.meta.pages, 3, 'MAX_PAGES bound')
  assert.equal(listed.meta.truncated, true)
  assert.equal(fetchImpl.calls.length, 3)
})

test('github: an exhausted quota is retryable with a delay, not a bad credential', async () => {
  const reset = Math.floor(Date.now() / 1000) + 60
  const fetchImpl = fakeFetch(async () => response({
    status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
  }))
  const adapter = createGithubAdapter({ repository: 'o/r', token: 'secret-token', fetchImpl })
  await assert.rejects(() => adapter.list(), error => {
    assert.equal(error.code, 'rate_limited')
    assert.equal(error.retryable, true)
    assert.ok(error.retryAfterMs !== null && error.retryAfterMs <= 60_000)
    assert.ok(!String(error.message).includes('secret-token'), 'the token must never appear in an error')
    return true
  })
})

test('github: 401 stays a non-retryable credential refusal and never leaks the token', async () => {
  const fetchImpl = fakeFetch(async () => response({ status: 401 }))
  const adapter = createGithubAdapter({ repository: 'o/r', token: 'secret-token', fetchImpl })
  await assert.rejects(() => adapter.get(7), error => {
    assert.equal(error.code, 'credentials_rejected')
    assert.equal(error.retryable, false)
    assert.ok(!String(error.message).includes('secret-token'))
    return true
  })
})

test('github: 5xx is retryable and a network failure is a transport error', async () => {
  const failing = createGithubAdapter({
    repository: 'o/r', token: '', fetchImpl: fakeFetch(async () => response({ status: 503 })),
  })
  await assert.rejects(() => failing.list(), error => error.code === 'http_503' && error.retryable === true)

  const throwing = createGithubAdapter({
    repository: 'o/r', token: '', fetchImpl: async () => { throw new Error('ECONNRESET') },
  })
  await assert.rejects(() => throwing.list(), error => error.code === 'transport' && error.retryable === true)
})

test('github: get() returns the forge revision usable as a conflict token', async () => {
  const adapter = createGithubAdapter({
    repository: 'o/r',
    token: '',
    fetchImpl: fakeFetch(async () => response({ body: issue(9) })),
  })
  const item = await adapter.get(9)
  assert.equal(item.canonicalId, 'github:9')
  assert.equal(item.revision, '2026-11-09T00:00:00Z')
  assert.deepEqual(item.labels, ['bug'])
})

test('github: the declared capability contract is read-only and honest', () => {
  const adapter = createGithubAdapter({ repository: 'o/r', token: '' })
  const described = adapter.describe()
  assert.equal(described.validatedLive, false)
  assert.deepEqual(Object.entries(described.capabilities).filter(([, value]) => value).map(([key]) => key).sort(), ['checks', 'get', 'list'])
  assert.equal(described.capabilities.create, false)
  assert.equal(described.capabilities.merge, false)
  assert.equal(described.writeEnabled, false)
  assert.equal(adapter.status, 'available')
  const disabled = createGithubAdapter({ repository: undefined, token: '' })
  assert.equal(disabled.status, 'disabled')
})

test('nextLinkOf parses only the rel=next entry', () => {
  assert.equal(nextLinkOf('<https://x/1>; rel="next", <https://x/2>; rel="last"'), 'https://x/1')
  assert.equal(nextLinkOf('<https://x/0>; rel="prev"'), null)
  assert.equal(nextLinkOf(undefined), null)
})

test('github: a 403 WITHOUT the rate-limit header is a credential refusal, not a quota', async () => {
  const fetchImpl = fakeFetch(async () => response({ status: 403 }))
  const adapter = createGithubAdapter({ repository: 'o/r', token: 'secret-token', fetchImpl })
  await assert.rejects(() => adapter.list(), error => {
    assert.equal(error.code, 'credentials_rejected')
    assert.equal(error.retryable, false)
    return true
  })
})
