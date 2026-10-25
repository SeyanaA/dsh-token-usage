/**
 * dsh-token-usage — host half.
 *
 * Aggregates the model token usage that DSH already records in every Session
 * log, and serves it as one JSON document for the browser half's dashboard:
 *
 *   - per-day totals (the activity heatmap),
 *   - per-day, per-model totals (the trend lines),
 *   - per-model totals (the share donut),
 *   - whole-history figures: cumulative tokens, peak day, longest continuous
 *     chat block, current / longest streak.
 *
 * ## Where the numbers come from
 *
 * A `request/header` event carries the exact model route of one step
 * (`data.header.config.{provider,model}`), and the step's `assistant/message`
 * carries the provider-reported usage (`data.usage.{inputTokens,
 * outputTokens,totalTokens,cacheReadTokens}`). Those two events are the only
 * source used here; the stream chunks inside `assistant/message` repeat the
 * same usage and must not be counted twice.
 *
 * ## Why there is a cache
 *
 * Reading one Session log means decompressing and replay-validating the whole
 * log (`sessionQuery.readSession`), which is not cheap. So each Session's fold
 * is cached against its `sessionPersistence` revision: a Session whose revision
 * is unchanged is served from the cache, and only changed or new Sessions are
 * re-read. The cache is persisted under `$DSH_HOME/dsh-token-usage/cache.json`
 * so a restart does not rebuild everything from scratch. It contains counts
 * only — no message text, no titles, no tool output.
 *
 * @module dsh-token-usage
*/

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-token-usage'

/** The one service this plugin cannot do without. */
export const inject = ['webServer']

/** Routes served to the browser half. */
export const ROUTES = {
  overview: '/api/dsh-token-usage/overview',
  hello: '/api/dsh-token-usage/hello',
}

/** Cache-file format; bump to invalidate every cached fold. */
const CACHE_VERSION = 2

/** A chat block ends after this long without an event. */
const BLOCK_GAP_MS = 10 * 60 * 1000

/** How many Session logs to read at once while filling the cache. */
const READ_CONCURRENCY = 3

/** The model catalog is re-read at most this often. */
const MODEL_CACHE_MS = 10 * 60 * 1000

/** Display fallbacks for model ids the live catalog does not know. */
const MODEL_WORDS = {
  glm: 'GLM', gpt: 'GPT', kimi: 'Kimi', qwen: 'Qwen', deepseek: 'DeepSeek',
  minimax: 'MiniMax', mimo: 'MiMo', hy: 'Hy', grok: 'Grok', claude: 'Claude',
  gemini: 'Gemini', llama: 'Llama', mistral: 'Mistral', longcat: 'LongCat',
  space: 'Space', bunny: 'Bunny', muse: 'Muse', spark: 'Spark', haiku: 'Haiku',
  luna: 'Luna', code: 'Code', flash: 'Flash', pro: 'Pro', max: 'Max',
  plus: 'Plus', preview: 'Preview', mini: 'Mini', turbo: 'Turbo', free: 'Free',
  exp: 'Exp', vision: 'Vision', reasoning: 'Reasoning', thinking: 'Thinking',
  instruct: 'Instruct', latest: 'Latest', beta: 'Beta', alpha: 'Alpha',
  sonnet: 'Sonnet', opus: 'Opus', gemma: 'Gemma', qwq: 'QwQ',
}

/** Two-digit pad. */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * @param {number} ms - epoch milliseconds.
 * @returns the local calendar day key, `YYYY-MM-DD`.
 */
export function localDayKey(ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * @param {string} key - a `YYYY-MM-DD` local day key.
 * @returns epoch milliseconds of that day's local midnight.
 */
function dayKeyStart(key) {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day).getTime()
}

/**
 * @param {string} key - a `YYYY-MM-DD` local day key.
 * @returns `YYYY-MM-01`, the first day of that month.
 */
function monthStartKey(key) {
  return String(key).slice(0, 8) + '01'
}

/**
 * @param {string} key - a `YYYY-MM-DD` local day key.
 * @returns `YYYY-MM-DD`, the last day of that month.
 */
function monthEndKey(key) {
  const [year, month] = key.split('-').map(Number)
  // Day 0 of the following month is the last day of this month.
  return localDayKey(new Date(year, month, 0).getTime())
}

/**
 * @param {string} key - a `YYYY-MM-DD` local day key.
 * @param {number} delta - whole months to add (can be negative).
 * @returns the first day of the shifted month.
 */
function monthShiftKey(key, delta) {
  const [year, month] = key.split('-').map(Number)
  return localDayKey(new Date(year, month - 1 + delta, 1).getTime())
}

/**
 * @param {string} key - a `YYYY-MM-DD` local day key.
 * @param {number} delta - days to add (can be negative).
 * @returns the shifted local day key.
 */
function shiftDayKey(key, delta) {
  return localDayKey(dayKeyStart(key) + delta * 86400000)
}

/**
 * @param {unknown} value - candidate.
 * @returns a finite non-negative number, or 0.
 */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * The state directory used for the persisted fold cache.
 * @returns an absolute directory path.
 */
export function stateDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'dsh-token-usage')
}

/** @returns the cache file path. */
export function cacheFile() {
  return join(stateDir(), 'cache.json')
}

/**
 * @param {string} file - path to read.
 * @returns parsed JSON, or null when absent/unreadable.
 */
export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * @param {string} file - path to write.
 * @param {unknown} value - JSON-serialisable value.
 */
export function writeJsonFile(file, value) {
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(file, JSON.stringify(value))
  } catch {
    // A cache that cannot be written costs time on the next request, not data.
  }
}

/**
 * @param {string} id - model id.
 * @returns a human-readable fallback name.
 */
export function prettyModelName(id) {
  if (typeof id !== 'string' || id === '') return '未知模型'
  return id
    .split(/[-_/\s]+/)
    .filter((segment) => segment !== '')
    .map((segment) => {
      const known = MODEL_WORDS[segment.toLowerCase()]
      if (known !== undefined) return known
      // A version segment keeps its digits but gets the model-name casing:
      // `v4.1` → `V4.1`, `5.3` → `5.3`.
      if (/^v?\d/.test(segment)) return segment.charAt(0).toUpperCase() + segment.slice(1)
      return segment.charAt(0).toUpperCase() + segment.slice(1)
    })
    .join('-')
}

/** Provider ids whose own catalog name is just the raw id, or good to fix up. */
const PROVIDER_LABELS = {
  'opencode-go': 'OpenCode',
  'deepseek-official': 'DeepSeek',
  'deepseek-account': 'DeepSeek Account',
}

/**
 * The display name for one provider: the live catalog name when it says
 * something, otherwise a readable fallback.
 * @param {string} provider - provider id.
 * @param {string|undefined} catalogName - name from `llm.listProviders()`.
 * @returns the display label.
 */
function providerDisplayName(provider, catalogName) {
  if (typeof catalogName === 'string' && catalogName !== '' && catalogName !== provider) return catalogName
  const known = PROVIDER_LABELS[provider]
  if (known !== undefined) return known
  const pretty = prettyProviderName(provider)
  return pretty !== '' ? pretty : provider
}

/** Separator between a provider id and a model id inside aggregation keys. */
const MODEL_KEY_SEP = '\u0001'

/**
 * @param {string} provider - provider id, e.g. `opencode-go`.
 * @param {string} model - model id, e.g. `deepseek-v4.1-flash`.
 * @returns the aggregation key that keeps providers apart.
 */
export function modelKey(provider, model) {
  return `${provider}${MODEL_KEY_SEP}${model}`
}

/**
 * @param {string} key - an aggregation key.
 * @returns `[provider, model]`; a legacy plain model id decodes as `['', id]`.
 */
export function splitModelKey(key) {
  const text = typeof key === 'string' ? key : ''
  const at = text.indexOf(MODEL_KEY_SEP)
  return at < 0 ? ['', text] : [text.slice(0, at), text.slice(at + 1)]
}

const PROVIDER_WORDS = {
  opencode: 'OpenCode',
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  minimax: 'MiniMax',
  qwen: 'Qwen',
  google: 'Google',
}

/**
 * A human label for a provider id, used when the live catalog is unavailable.
 * @param {string} id - provider id.
 * @returns the display name.
 */
export function prettyProviderName(id) {
  if (typeof id !== 'string' || id === '') return ''
  return id
    .split(/[-_/\s]+/)
    .filter((segment) => segment !== '')
    .map((segment) => {
      const known = PROVIDER_WORDS[segment.toLowerCase()]
      return known ?? segment.charAt(0).toUpperCase() + segment.slice(1)
    })
    .join(' ')
}

/**
 * Fold one Session's event log into daily / model token counts.
 *
 * @param {object} header - the Session header (`{id, createdAt, ...}`).
 * @param {readonly object[]} events - the raw Session log events.
 * @returns the fold, safe to persist as JSON.
 */
export function aggregateSession(header, events) {
  const stepModels = new Map()
  const days = Object.create(null)
  const dayModels = Object.create(null)
  const models = Object.create(null)
  const times = []
  let lastModel = null
  let totalTokens = 0

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const time = event.time
    if (typeof time === 'number' && Number.isFinite(time)) times.push(time)
    const data = event.data
    if (event.type === 'request/header') {
      const config = data?.header?.config
      if (config !== null && typeof config === 'object' && typeof config.model === 'string' && config.model !== '') {
        lastModel = {
          provider: typeof config.provider === 'string' ? config.provider : 'unknown',
          model: config.model,
        }
        if (typeof data.turn === 'number' && typeof data.step === 'number') {
          stepModels.set(`${data.turn}:${data.step}`, lastModel)
        }
      }
      continue
    }
    if (event.type !== 'assistant/message') continue
    const usage = data?.usage
    if (usage === null || typeof usage !== 'object') continue
    let tokens = count(usage.totalTokens)
    if (tokens === 0) {
      tokens = count(usage.inputTokens) + count(usage.outputTokens) + count(usage.cacheReadTokens)
    }
    if (tokens === 0) continue
    const key = typeof data?.turn === 'number' && typeof data?.step === 'number'
      ? `${data.turn}:${data.step}`
      : null
    const route = (key === null ? undefined : stepModels.get(key)) ?? lastModel
    // The provider is part of the identity: two providers can serve the same
    // model id (and catalog display name), and they must stay separate rows.
    const composite = route === null || route === undefined
      ? modelKey('unknown', 'unknown')
      : modelKey(route.provider, route.model)
    const day = localDayKey(typeof time === 'number' && Number.isFinite(time) ? time : Date.now())
    const byModel = dayModels[day] ?? (dayModels[day] = Object.create(null))
    byModel[composite] = (byModel[composite] ?? 0) + tokens
    days[day] = (days[day] ?? 0) + tokens
    models[composite] = (models[composite] ?? 0) + tokens
    totalTokens += tokens
  }

  times.sort((left, right) => left - right)
  let longestBlockMs = 0
  if (times.length > 1) {
    let blockStart = times[0]
    let previous = times[0]
    for (let index = 1; index < times.length; index += 1) {
      const time = times[index]
      if (time - previous > BLOCK_GAP_MS) {
        longestBlockMs = Math.max(longestBlockMs, previous - blockStart)
        blockStart = time
      }
      previous = time
    }
    longestBlockMs = Math.max(longestBlockMs, previous - blockStart)
  }

  const createdAt = typeof header?.createdAt === 'number' ? header.createdAt : (times[0] ?? undefined)
  return {
    createdAt,
    lastEventAt: times.length > 0 ? times[times.length - 1] : undefined,
    totalTokens,
    days,
    dayModels,
    models,
    longestBlockMs,
  }
}

/**
 * The catalog's display names, keyed by model id; empty when no catalog is
 * reachable (the caller then falls back to `prettyModelName`).
 *
 * @param {object} ctx - host plugin context.
 * @returns a frozen `{ [modelId]: name }` record.
 */
/** The provider catalog: display names for providers, models, and both keys. */
function emptyCatalog() {
  return {
    providers: Object.create(null),
    models: Object.create(null),
    providerModels: Object.create(null),
  }
}

async function modelNames(ctx) {
  const catalog = emptyCatalog()
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (llm === undefined || llm === null) return catalog
  let providers = []
  try {
    providers = Array.isArray(llm.listProviders?.()) ? llm.listProviders() : []
  } catch {
    providers = []
  }
  for (const provider of providers) {
    if (provider === null || typeof provider !== 'object' || typeof provider.id !== 'string') continue
    if (typeof provider.name === 'string' && provider.name !== '') catalog.providers[provider.id] = provider.name
    try {
      const models = await llm.listModels(provider.id)
      if (!Array.isArray(models)) continue
      const perProvider = catalog.providerModels[provider.id] ?? (catalog.providerModels[provider.id] = Object.create(null))
      for (const model of models) {
        if (model === null || typeof model !== 'object') continue
        if (typeof model.id === 'string' && typeof model.name === 'string' && model.name !== '') {
          perProvider[model.id] = model.name
          catalog.models[model.id] = model.name
        }
      }
    } catch {
      // A provider without a reachable catalog keeps the fallback name.
    }
  }
  return catalog
}

/**
 * Merge every Session fold into the one document the dashboard renders.
 *
 * @param {object[]} sessions - per-Session folds.
 * @param {number} range - trend/shared range in days (7 or 30).
 * @param {Record<string, string>} names - catalog display names.
 * @param {string} today - today's local day key.
 * @returns the overview document.
 */
export function buildOverview(sessions, range, naming, today) {
  // `naming` is the live catalog when available; a plain `{modelId: name}` map
  // (used by tests) is accepted as well.
  const catalog = naming !== null && typeof naming === 'object' ? naming : {}
  const providerNames = catalog.providers ?? Object.create(null)
  const modelNamesById = catalog.models !== undefined && typeof catalog.models === 'object'
    ? catalog.models
    : catalog
  const providerModelNames = catalog.providerModels ?? Object.create(null)
  const days = Object.create(null)
  const dayModels = Object.create(null)
  const models = Object.create(null)
  let longestChatMs = 0
  for (const session of sessions) {
    if (session === null || typeof session !== 'object') continue
    longestChatMs = Math.max(longestChatMs, count(session.longestBlockMs))
    for (const [day, tokens] of Object.entries(session.days ?? {})) {
      days[day] = (days[day] ?? 0) + count(tokens)
    }
    for (const [day, byModel] of Object.entries(session.dayModels ?? {})) {
      if (byModel === null || typeof byModel !== 'object') continue
      const merged = dayModels[day] ?? (dayModels[day] = Object.create(null))
      for (const [model, tokens] of Object.entries(byModel)) {
        merged[model] = (merged[model] ?? 0) + count(tokens)
      }
    }
    for (const [model, tokens] of Object.entries(session.models ?? {})) {
      models[model] = (models[model] ?? 0) + count(tokens)
    }
  }

  // Whole-history figures.
  let totalTokens = 0
  let peakDayTokens = 0
  let peakDay = null
  for (const [day, tokens] of Object.entries(days)) {
    totalTokens += tokens
    if (tokens > peakDayTokens) {
      peakDayTokens = tokens
      peakDay = day
    }
  }
  const activeDays = Object.keys(days).filter((day) => days[day] > 0).sort()
  let longestStreak = 0
  let streak = 0
  let previous = null
  for (const day of activeDays) {
    streak = previous !== null && shiftDayKey(previous, 1) === day ? streak + 1 : 1
    if (streak > longestStreak) longestStreak = streak
    previous = day
  }
  let currentStreak = 0
  {
    let cursor = today
    if (!(days[cursor] > 0)) {
      // A day that has not seen usage yet keeps yesterday's run alive only when
      // today is still empty; a run broken yesterday is over.
      cursor = shiftDayKey(today, -1)
    }
    while (days[cursor] > 0) {
      currentStreak += 1
      cursor = shiftDayKey(cursor, -1)
    }
  }

  // Activity heatmap: twelve whole local months ending with the current month.
  // The current month keeps its not-yet-reached days as empty cells, so the
  // grid advances one whole month at a time instead of sliding every day.
  const heatEnd = monthEndKey(today)
  const heatStart = monthShiftKey(monthStartKey(today), -11)
  const heatDays = []
  for (let cursor = heatStart; cursor <= heatEnd; cursor = shiftDayKey(cursor, 1)) {
    heatDays.push({ d: cursor, t: days[cursor] ?? 0 })
    if (heatDays.length > 400) break
  }

  // Trend + range-scoped model share.
  const rangeStart = shiftDayKey(today, -(range - 1))
  const trendDays = []
  const rangeModels = Object.create(null)
  for (let index = 0; index < range; index += 1) {
    const day = shiftDayKey(rangeStart, index)
    const byModel = dayModels[day] ?? {}
    for (const [model, tokens] of Object.entries(byModel)) {
      rangeModels[model] = (rangeModels[model] ?? 0) + count(tokens)
    }
    trendDays.push({ d: day, t: days[day] ?? 0, m: Object.assign(Object.create(null), byModel) })
  }
  const rangeTotal = Object.values(rangeModels).reduce((sum, value) => sum + value, 0)

  const resolvedModels = Object.entries(rangeModels)
    .map(([key, tokens]) => {
      const [provider, model] = splitModelKey(key)
      const providerName = providerDisplayName(provider, providerNames[provider])
      const providerModel = providerModelNames[provider]
      const name = provider !== '' && providerModel !== undefined && providerModel !== null && providerModel[model] !== undefined
        ? providerModel[model]
        : (modelNamesById[model] ?? prettyModelName(model))
      return {
        key,
        id: model,
        provider,
        providerName,
        name,
        tokens,
        share: rangeTotal === 0 ? 0 : tokens / rangeTotal,
      }
    })
    .sort((left, right) => right.tokens - left.tokens)

  // Different providers can serve the same model under the same display name
  // (hyphen/space/case variants included). Only those rows get the provider
  // suffix, so the common case stays a clean model name.
  const normalise = (label) => String(label).toLowerCase().replace(/[\s\-_./()]+/g, '')
  const nameCounts = new Map()
  for (const entry of resolvedModels) {
    const normalised = normalise(entry.name)
    nameCounts.set(normalised, (nameCounts.get(normalised) ?? 0) + 1)
  }
  const modelList = resolvedModels.map((entry) => ({
    ...entry,
    label: (nameCounts.get(normalise(entry.name)) ?? 0) > 1 && entry.providerName !== ''
      ? `${entry.name} · ${entry.providerName}`
      : entry.name,
  }))

  const trendModelIds = [...modelList.map((entry) => entry.key)]

  return {
    ok: true,
    generatedAt: Date.now(),
    range,
    today,
    totals: {
      tokens: totalTokens,
      peakDayTokens,
      peakDay,
      longestChatMs,
      currentStreak,
      longestStreak,
      sessions: sessions.length,
      activeDays: activeDays.length,
    },
    heatmap: { start: heatStart, end: heatEnd, days: heatDays },
    trend: { start: rangeStart, end: today, days: trendDays, models: trendModelIds },
    models: modelList,
    rangeTokens: rangeTotal,
  }
}

/**
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON body.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * @param {string} url - request URL.
 * @param {string} key - query parameter name.
 * @returns the value, or undefined.
 */
function queryParam(url, key) {
  try {
    return new URL(url, 'http://127.0.0.1').searchParams.get(key) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * The ids of Sessions that are live in this process. Their persisted revision
 * does not move while events are still buffered in memory, so they are re-read
 * on every request instead of being served from the fold cache.
 * @param {object} ctx - host plugin context.
 * @returns a Set of live Session ids.
 */
function liveSessionIds(ctx) {
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  const ids = new Set()
  try {
    if (sessions !== undefined && sessions !== null && typeof sessions.list === 'function') {
      for (const session of sessions.list()) {
        if (session !== null && typeof session === 'object' && typeof session.id === 'string') ids.add(session.id)
      }
    }
  } catch {
    // A store mid-teardown is simply treated as having no live Sessions.
  }
  return ids
}

/**
 * Load one Session's fold, reusing the cached one when its revision matches.
 * @param {object} ctx - host plugin context.
 * @param {object} snapshot - persistence snapshot (`{header, revision}`).
 * @param {object} cached - the cache entry for this Session, if any.
 * @returns `{ entry, reused }`.
 */
async function foldSnapshot(ctx, snapshot, cached) {
  const revision = snapshot.revision
  if (cached !== undefined && cached.revision === revision && cached.fold !== undefined) {
    return { entry: cached, reused: true }
  }
  const sessionQuery = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
  if (sessionQuery === undefined || sessionQuery === null || typeof sessionQuery.readSession !== 'function') {
    return { entry: cached, reused: cached !== undefined }
  }
  try {
    const log = await sessionQuery.readSession(snapshot.header.id)
    const fold = aggregateSession(log.session ?? snapshot.header, log.events ?? [])
    return { entry: { revision, fold }, reused: false }
  } catch (error) {
    // Keep the failure local to one Session: a corrupt or mid-migration log
    // must not take the dashboard down, and its revision stays cached so a
    // still log is not re-read on every request.
    return {
      entry: { revision, fold: null, error: error instanceof Error ? error.message : String(error) },
      reused: false,
    }
  }
}

/** Run `worker` over `items` with a fixed concurrency. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Host plugin body: routes only. The fold cache lives in the plugin closure, so
 * it is created and dropped with the plugin's fiber.
 * @param {object} ctx - host plugin context.
 */
export function apply(ctx) {
  /** @type {Map<string, {revision: string, fold: object|null, error?: string}>} */
  const cache = new Map()
  let cacheDirty = false
  let cacheLoaded = false
  let modelNamesCache = { at: 0, naming: null }

  const loadCache = () => {
    if (cacheLoaded) return
    cacheLoaded = true
    const saved = readJsonFile(cacheFile())
    if (saved === null || saved === undefined || saved.version !== CACHE_VERSION || typeof saved.sessions !== 'object' || saved.sessions === null) return
    for (const [id, entry] of Object.entries(saved.sessions)) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.revision !== 'string') continue
      cache.set(id, {
        revision: entry.revision,
        fold: entry.fold ?? null,
        ...entry.error === undefined ? {} : { error: entry.error },
      })
    }
  }

  const persistCache = () => {
    if (!cacheDirty) return
    cacheDirty = false
    const sessions = Object.create(null)
    for (const [id, entry] of cache) {
      sessions[id] = { revision: entry.revision, fold: entry.fold, ...entry.error === undefined ? {} : { error: entry.error } }
    }
    writeJsonFile(cacheFile(), { version: CACHE_VERSION, savedAt: new Date().toISOString(), sessions })
  }

  const resolveModelNames = async () => {
    const now = Date.now()
    if (modelNamesCache.naming !== null && now - modelNamesCache.at < MODEL_CACHE_MS) return modelNamesCache.naming
    // A provider catalog may sit behind a network round trip; the dashboard
    // must not wait on it. A timed-out try falls back to pretty ids and is not
    // cached, so a later request can complete the real catalog.
    const raced = await Promise.race([
      modelNames(ctx).then((naming) => ({ done: true, naming })),
      new Promise((resolve) => setTimeout(() => resolve({ done: false, naming: null }), 1500)),
    ])
    if (raced.done) modelNamesCache = { at: Date.now(), naming: raced.naming }
    return raced.naming ?? emptyCatalog()
  }

  /**
   * Fold the current Session corpus into per-Session aggregates, filling the
   * cache for new, changed, and live Sessions only.
   * @returns `{ folds, stats }`.
   */
  const collectFolds = async () => {
    loadCache()
    const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
    if (persistence === undefined || persistence === null || typeof persistence.list !== 'function') {
      throw new Error('session persistence is not available in this profile')
    }
    const snapshots = await persistence.list()
    const live = liveSessionIds(ctx)
    const present = new Set()
    const folds = []
    const queue = []
    let reusedCount = 0
    let readCount = 0
    for (const snapshot of snapshots) {
      if (snapshot === null || typeof snapshot !== 'object') continue
      const id = snapshot.header?.id
      if (typeof id !== 'string') continue
      present.add(id)
      const cached = cache.get(id)
      // A live Session's revision is frozen while its events are buffered, so
      // it is always re-read; everything else is revision-guarded.
      if (!live.has(id) && cached !== undefined && cached.revision === snapshot.revision && cached.fold !== null) {
        folds.push(cached.fold)
        reusedCount += 1
        continue
      }
      queue.push({ snapshot, cached })
    }
    const resolved = await mapLimit(queue, READ_CONCURRENCY, async ({ snapshot, cached }) => {
      const id = snapshot.header.id
      const result = await foldSnapshot(ctx, snapshot, cached)
      cache.set(id, result.entry)
      cacheDirty = true
      if (result.reused) reusedCount += 1
      else readCount += 1
      return result.entry.fold
    })
    for (const fold of resolved) if (fold !== null && fold !== undefined) folds.push(fold)
    for (const id of [...cache.keys()]) {
      if (!present.has(id)) {
        cache.delete(id)
        cacheDirty = true
      }
    }
    persistCache()
    return { folds, stats: { sessions: snapshots.length, reused: reusedCount, read: readCount } }
  }

  /** The last hello a browser half sent, so a load can be observed from outside. */
  let lastClientHello = null

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.hello,
    handler: (req, res) => {
      lastClientHello = {
        at: Date.now(),
        version: queryParam(req.url, 'ver') ?? '',
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 120) : '',
      }
      sendJson(res, 200, { ok: true })
    },
  }), 'dsh-token-usage: hello route')

  /** One fold collection in flight, so concurrent readers share the work. */
  let foldsInFlight = null

  const ensureFolds = () => {
    if (foldsInFlight === null) {
      foldsInFlight = collectFolds().finally(() => {
        foldsInFlight = null
      })
    }
    return foldsInFlight
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.overview,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'GET only' })
        return
      }
      try {
        const { folds, stats } = await ensureFolds()
        const range = Number(queryParam(req.url, 'range')) === 7 ? 7 : 30
        const naming = await resolveModelNames()
        const overview = buildOverview(folds, range, naming, localDayKey(Date.now()))
        const diag = queryParam(req.url, 'diag') === '1'
        sendJson(res, 200, diag
          ? { ...overview, cache: stats, client: lastClientHello, catalog: { providers: naming.providers } }
          : overview)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-token-usage: overview route')
}
