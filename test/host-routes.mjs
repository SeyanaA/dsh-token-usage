#!/usr/bin/env node
/**
 * Host route test: mounts the host half against a temporary DSH_HOME and a fake
 * Session store, then exercises the clear + refresh contract the dashboard's
 * two new toolbar buttons rely on.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')

const home = mkdtempSync(join(tmpdir(), 'dsh-token-usage-routes-'))
process.env.DSH_HOME = home

const mod = await import(join(pluginDir, 'index.js'))
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

const now = Date.now()
let revision = 'rev-1'
const header = { id: 'session-routes', createdAt: now - 200000 }
const events = [
  {
    type: 'request/header',
    time: now - 120000,
    data: { turn: 1, step: 1, header: { config: { provider: 'p', model: 'model-a' } } },
  },
  { type: 'assistant/message', time: now - 120000, data: { turn: 1, step: 1, usage: { totalTokens: 1000 } } },
  { type: 'assistant/message', time: now - 60000, data: { turn: 1, step: 1, usage: { totalTokens: 500 } } },
]

const routes = new Map()
const ctx = {
  effect(fn) {
    const dispose = fn()
    return dispose
  },
  get(key) {
    if (key === 'sessionPersistence') {
      return { list: async () => [{ header, revision }] }
    }
    if (key === 'sessionQuery') {
      return { readSession: async () => ({ session: header, events: [...events] }) }
    }
    if (key === 'sessions') {
      return { list: () => [] }
    }
    if (key === 'llm') {
      return { listProviders: () => [], listModels: async () => [] }
    }
    return undefined
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}
mod.apply(ctx)

function call(path, method = 'GET', options = {}) {
  const headers = { host: '127.0.0.1:1', ...(options.headers ?? {}) }
  const body = options.body === undefined ? null : JSON.stringify(options.body)
  const request = Readable.from(body === null ? [] : [Buffer.from(body)])
  request.method = method
  request.url = path
  request.headers = headers
  const handler = routes.get(path.split('?')[0])
  return new Promise((resolve) => {
    const response = {
      status: 0,
      headers: {},
      writeHead(status, headersOut) {
        this.status = status
        this.headers = headersOut ?? {}
      },
      end(payload) {
        let parsed = null
        try {
          parsed = payload ? JSON.parse(payload) : null
        } catch {
          parsed = payload ?? null
        }
        resolve({ status: this.status, headers: this.headers, body: parsed })
      },
    }
    if (handler === undefined) {
      failures.push('missing route: ' + path)
      response.writeHead(404)
      response.end(null)
      return
    }
    Promise.resolve(handler(request, response)).catch((error) => {
      failures.push(`${method} ${path} threw: ${String(error)}`)
      response.writeHead(500)
      response.end(null)
    })
  })
}

const OVERVIEW = mod.ROUTES.overview + '?range=7'
const CLEAR = mod.ROUTES.clear

const first = await call(OVERVIEW)
check(first.status === 200 && first.body?.ok === true, `first overview failed: ${first.status}`)
check(first.body?.totals?.tokens === 1500, `first overview tokens ${first.body?.totals?.tokens}, expected 1500`)
check(first.body?.clearedAt === 0, 'a fresh profile has no statistics origin')

const wrongMethod = await call(CLEAR, 'GET')
check(wrongMethod.status === 405, `clear GET should be 405, got ${wrongMethod.status}`)
const wrongType = await call(CLEAR, 'POST', { headers: { 'content-type': 'text/plain' }, body: {} })
check(wrongType.status === 415, `clear without JSON should be 415, got ${wrongType.status}`)

const cleared = await call(CLEAR, 'POST', { headers: { 'content-type': 'application/json' }, body: {} })
check(cleared.status === 200 && cleared.body?.ok === true, `clear failed: ${cleared.status}`)
const clearedAt = cleared.body?.clearedAt
check(typeof clearedAt === 'number' && clearedAt > 0, 'clear must return an epoch-ms origin')

const cache = JSON.parse(readFileSync(join(home, 'dsh-token-usage', 'cache.json'), 'utf8'))
check(cache.clearedAt === clearedAt, 'the statistics origin must be persisted')

const afterClear = await call(OVERVIEW)
check(afterClear.body?.totals?.tokens === 0, `cleared overview tokens ${afterClear.body?.totals?.tokens}, expected 0`)
check(afterClear.body?.clearedAt === clearedAt, 'overview must report the persisted origin')

// A new usage event, with no revision bump: the cached fold would miss it, but
// the manual refresh is required to drop the cache and re-read the Session.
events.push({
  type: 'assistant/message',
  time: clearedAt + 1000,
  data: { turn: 1, step: 1, usage: { totalTokens: 400 } },
})
const stale = await call(OVERVIEW)
check(stale.body?.totals?.tokens === 0, `cached overview should still be 0, got ${stale.body?.totals?.tokens}`)
const refreshed = await call(OVERVIEW + '&refresh=1&diag=1')
check(refreshed.body?.totals?.tokens === 400, `refreshed overview tokens ${refreshed.body?.totals?.tokens}, expected 400`)
check(refreshed.body?.cache?.read >= 1, 'refresh must force a Session re-read')
check(refreshed.body?.clearedAt === clearedAt, 'refresh keeps the statistics origin')

try {
  rmSync(home, { recursive: true, force: true })
} catch {
  // Temp cleanup is best effort.
}

if (failures.length > 0) {
  console.error('host-routes: FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('host-routes: PASS (clear origin + persistence + manual refresh)')
