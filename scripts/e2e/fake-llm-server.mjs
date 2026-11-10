#!/usr/bin/env node
/**
 * Dependency-free, deterministic OpenAI-compatible provider used by the
 * isolated-host E2E harness (GOAL 3 §13.5 / §16.17).
 *
 * It is NOT a model. It answers `GET /v1/models` and `POST /v1/chat/completions`
 * (streaming SSE by default, plain JSON when `stream:false`) with a fixed,
 * recognizable reply, and it can be scripted through `/ _control/next` to emit
 * the failure shapes the board's router must classify:
 *
 *   ok | rate_limit (429 + Retry-After) | server_error (500) | auth_error (401)
 *   | timeout (hang then reset) | partial_stream (chunk, then stream error)
 *   | unknown_model (404 model_not_found) | bad_request (400)
 *
 * Every served request is appended to an in-memory log that the orchestrator
 * reads as evidence. The log never contains a credential: the Authorization
 * header is recorded as a boolean, never as a value.
 *
 * Standalone:
 *   node scripts/e2e/fake-llm-server.mjs [--port 0] [--model e2e-fake-gpt]
 *   -> prints one JSON line on stdout: {"url":"http://127.0.0.1:PORT/v1",...}
 *
 * In-process (used by run-e2e.mjs):
 *   const { startFakeLlm } = await import('./fake-llm-server.mjs')
 *   const fake = await startFakeLlm({ port: 0 })
 *   fake.setScript([{ type: 'rate_limit' }])
 *   fake.requests, fake.port, fake.baseURL, fake.close()
 *
 * @module scripts/e2e/fake-llm-server
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const SIMULATION_HEADER = 'x-simulated-llm'
export const DEFAULT_MODEL = 'e2e-fake-gpt'

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

function jsonHeaders(extra = {}) {
  return { 'content-type': 'application/json; charset=utf-8', [SIMULATION_HEADER]: 'true', ...extra }
}

function errorPayload(message, type, code = null) {
  return { error: { message, type, param: null, code } }
}

function previewOf(body) {
  try {
    const messages = Array.isArray(body?.messages) ? body.messages : []
    const lastUser = [...messages].reverse().find(message => message?.role === 'user')
    const content = lastUser?.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join(' ')
        : ''
    return text.replace(/\s+/g, ' ').trim().slice(0, 240)
  } catch {
    return ''
  }
}

function sseChunk(id, model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

/**
 * @param {object} [options]
 * @param {number} [options.port] 0 = ephemeral
 * @param {string} [options.host] default 127.0.0.1
 * @param {string} [options.model] advertised model id
 * @param {number} [options.hangMs] default timeout behaviour duration
 * @param {number} [options.chunkDelayMs] delay between ok chunks (deterministic tests stay fast)
 */
export async function startFakeLlm({ port = 0, host = '127.0.0.1', model = DEFAULT_MODEL, hangMs = 9000, chunkDelayMs = 2 } = {}) {
  /** @type {Array<{type: string, [key: string]: any}>} */
  let script = []
  /** @type {object[]} */
  const requests = []
  let seq = 0

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake-llm')
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => void handle(req, res, url, Buffer.concat(chunks).toString('utf8')).catch(error => {
      if (!res.headersSent) {
        res.writeHead(500, jsonHeaders())
        res.end(JSON.stringify(errorPayload(`fake-llm internal: ${String(error?.message ?? error)}`, 'server_error')))
      } else {
        try { res.end() } catch { /* closed */ }
      }
    }))
  })

  async function handle(req, res, url, rawBody) {
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders())
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: model, object: 'model', created: 0, owned_by: 'e2e-harness-simulation' }],
      }))
      return
    }

    if (url.pathname === '/_control/next' && req.method === 'POST') {
      let body = {}
      try { body = rawBody === '' ? {} : JSON.parse(rawBody) } catch { body = null }
      if (body === null) {
        res.writeHead(400, jsonHeaders())
        res.end(JSON.stringify({ ok: false, error: 'invalid_json' }))
        return
      }
      const next = Array.isArray(body.behaviors) ? body.behaviors : (body.behavior !== undefined ? [body.behavior] : [])
      script = next.map(behavior => (typeof behavior === 'string' ? { type: behavior } : { ...behavior }))
      res.writeHead(200, jsonHeaders())
      res.end(JSON.stringify({ ok: true, value: { queued: script.length, script } }))
      return
    }

    if (url.pathname === '/_control/reset' && req.method === 'POST') {
      let body = {}
      try { body = rawBody === '' ? {} : JSON.parse(rawBody) } catch { /* keep defaults */ }
      script = []
      if (body?.clearLog === true) requests.length = 0
      res.writeHead(200, jsonHeaders())
      res.end(JSON.stringify({ ok: true, value: { queued: 0, requests: requests.length } }))
      return
    }

    if (url.pathname === '/_control/state' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders())
      res.end(JSON.stringify({ ok: true, value: { queued: script.length, script, requests } }))
      return
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const started = Date.now()
      seq += 1
      const entry = {
        seq,
        at: new Date(started).toISOString(),
        method: req.method,
        path: url.pathname,
        model: null,
        stream: null,
        authorizationPresent: typeof req.headers.authorization === 'string' && req.headers.authorization !== '',
        behavior: 'ok',
        status: null,
        sseChunks: 0,
        ms: null,
        promptPreview: '',
      }
      requests.push(entry)
      let body = null
      try { body = rawBody === '' ? null : JSON.parse(rawBody) } catch { body = null }
      if (body === null || typeof body !== 'object') {
        entry.status = 400
        entry.behavior = 'bad_request'
        entry.ms = Date.now() - started
        res.writeHead(400, jsonHeaders())
        res.end(JSON.stringify(errorPayload('invalid JSON body', 'invalid_request_error', 'invalid_json')))
        return
      }
      const requestedModel = typeof body.model === 'string' ? body.model : ''
      body.__stream = body.stream === true
      entry.model = requestedModel === '' ? null : requestedModel
      entry.stream = body.__stream === true
      entry.promptPreview = previewOf(body)

      const behavior = script.length > 0 ? script.shift() : { type: 'ok' }
      const type = typeof behavior?.type === 'string' ? behavior.type : 'ok'
      entry.behavior = type

      const finish = (status, payload, headers = {}) => {
        entry.status = status
        entry.ms = Date.now() - started
        res.writeHead(status, jsonHeaders(headers))
        res.end(JSON.stringify(payload))
      }

      if (type === 'rate_limit') {
        finish(429, errorPayload('Rate limit reached for requests. Please retry after a short delay.', 'rate_limit_error', 'rate_limit_exceeded'), {
          'retry-after': String(behavior.retryAfterSeconds ?? 1),
        })
        return
      }
      if (type === 'server_error') {
        finish(500, errorPayload('Internal server error (scripted by the E2E harness).', 'server_error', 'server_error'))
        return
      }
      if (type === 'auth_error') {
        finish(401, errorPayload('Incorrect API key provided (scripted by the E2E harness).', 'invalid_request_error', 'invalid_api_key'))
        return
      }
      if (type === 'unknown_model') {
        finish(404, errorPayload(`The model \`${requestedModel}\` does not exist or you do not have access to it.`, 'invalid_request_error', 'model_not_found'))
        return
      }
      if (type === 'timeout') {
        entry.status = 'timeout_hang'
        // Accept the request, then reset the socket after a short hang. The
        // board/pi-ai layer sees a transport/abort failure, never a valid turn.
        await new Promise(resolve => setTimeout(resolve, Math.max(50, Number(behavior.hangMs) || hangMs)))
        entry.ms = Date.now() - started
        try { req.socket.destroy() } catch { /* already gone */ }
        return
      }

      const text = String(behavior.text ?? `E2E fake provider reply #${seq}: the isolated DSH host reached a scripted OpenAI-compatible endpoint.`)
      const responseId = `chatcmpl-fake-${seq}-${randomUUID().slice(0, 8)}`
      if (body.__stream !== true) {
        finish(200, {
          id: responseId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: requestedModel || model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: text.length, total_tokens: text.length + 1 },
        })
        return
      }

      entry.status = 'streaming'
      res.writeHead(200, { ...SSE_HEADERS, [SIMULATION_HEADER]: 'true' })
      const write = value => { res.write(value); entry.sseChunks += 1 }
      write(sseChunk(responseId, requestedModel || model, { role: 'assistant' }))
      const pieces = text.match(/.{1,24}/gs) ?? [text]
      for (const piece of pieces) {
        if (chunkDelayMs > 0) await new Promise(resolve => setTimeout(resolve, chunkDelayMs))
        if (type === 'partial_stream') {
          write(sseChunk(responseId, requestedModel || model, { content: piece }))
          entry.status = 'partial_stream_error'
          // Deliver a corrupted/error frame AFTER content, then close: the
          // request produced output the caller cannot silently replay.
          res.write(`data: ${JSON.stringify(errorPayload('The server had an error while streaming (scripted partial stream).', 'server_error', 'stream_interrupted'))}\n\n`)
          entry.ms = Date.now() - started
          res.end()
          return
        }
        write(sseChunk(responseId, requestedModel || model, { content: piece }))
      }
      write(sseChunk(responseId, requestedModel || model, {}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
      entry.status = 200
      entry.ms = Date.now() - started
      return
    }

    res.writeHead(404, jsonHeaders())
    res.end(JSON.stringify({ ok: false, error: 'not_found', path: url.pathname }))
  }

  await new Promise(resolve => server.listen(port, host, resolve))
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  const baseURL = `http://${host}:${actualPort}/v1`

  return {
    server,
    host,
    port: actualPort,
    baseURL,
    get requests() { return requests },
    setScript(behaviors) {
      script = (Array.isArray(behaviors) ? behaviors : [behaviors]).filter(Boolean).map(behavior => (
        typeof behavior === 'string' ? { type: behavior } : { ...behavior }
      ))
    },
    reset({ clearLog = false } = {}) {
      script = []
      if (clearLog) requests.length = 0
    },
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

const isMain = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = process.argv.slice(2)
  const option = (name, fallback) => {
    const index = args.indexOf(name)
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
  }
  const fake = await startFakeLlm({
    port: Number(option('--port', '0')) || 0,
    model: option('--model', DEFAULT_MODEL),
  })
  process.stderr.write(`[fake-llm] SIMULATION — not a real provider; ${fake.baseURL} (model ${option('--model', DEFAULT_MODEL)})\n`)
  process.stdout.write(`${JSON.stringify({ url: fake.baseURL, port: fake.port, model: option('--model', DEFAULT_MODEL), simulation: true })}\n`)
  const shutdown = () => { void fake.close().then(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
