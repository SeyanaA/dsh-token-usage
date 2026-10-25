#!/usr/bin/env node
/**
 * Host fold test: builds a synthetic Session log, folds it with the real
 * aggregateSession(), and asserts the whole-history and range figures the
 * dashboard renders.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')
const source = readFileSync(join(pluginDir, 'index.js'), 'utf8')
const start = source.indexOf('//#region guest session snapshot')
const end = source.indexOf('//#endregion', start)

// index.js is an ESM module with only node: imports, so it can be imported
// directly. The fold cache region is not needed here; importing the module
// gives us aggregateSession/buildOverview directly.
const mod = await import(join(pluginDir, 'index.js'))
const { aggregateSession, buildOverview, prettyModelName, localDayKey, modelKey } = mod

const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

const day = (offset) => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return date
}
const dayKey = (offset) => localDayKey(day(offset).getTime())
const at = (offset, hour, minute) => {
  const date = day(offset)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

const events = [
  { type: 'step/start', seq: 0, time: at(-1, 9, 0), data: { turn: 1, step: 1 } },
  {
    type: 'request/header',
    seq: 1,
    time: at(-1, 9, 0),
    data: { turn: 1, step: 1, header: { config: { provider: 'p', model: 'model-a' } } },
  },
  { type: 'assistant/message', seq: 2, time: at(-1, 9, 2), data: { turn: 1, step: 1, usage: { totalTokens: 1000 } } },
  { type: 'step/start', seq: 3, time: at(-1, 9, 5), data: { turn: 1, step: 2 } },
  {
    type: 'request/header',
    seq: 4,
    time: at(-1, 9, 5),
    data: { turn: 1, step: 2, header: { config: { provider: 'p', model: 'model-b' } } },
  },
  { type: 'assistant/message', seq: 5, time: at(-1, 9, 7), data: { turn: 1, step: 2, usage: { totalTokens: 500 } } },
  // A second day, far enough away to be its own chat block.
  { type: 'step/start', seq: 6, time: at(0, 10, 0), data: { turn: 2, step: 1 } },
  {
    type: 'request/header',
    seq: 7,
    time: at(0, 10, 0),
    data: { turn: 2, step: 1, header: { config: { provider: 'p', model: 'model-a' } } },
  },
  { type: 'assistant/message', seq: 8, time: at(0, 10, 3), data: { turn: 2, step: 1, usage: { totalTokens: 2000 } } },
]

const header = { id: 'session-test', createdAt: at(-1, 9, 0) }
const fold = aggregateSession(header, events)
const keyA = modelKey('p', 'model-a')
const keyB = modelKey('p', 'model-b')
check(fold.totalTokens === 3500, `fold total ${fold.totalTokens}, expected 3500`)
check(fold.models[keyA] === 3000, `model-a ${fold.models[keyA]}, expected 3000`)
check(fold.models[keyB] === 500, `model-b ${fold.models[keyB]}, expected 500`)
check(fold.days[dayKey(-1)] === 1500, `day -1 tokens ${fold.days[dayKey(-1)]}, expected 1500`)
check(fold.longestBlockMs > 0 && fold.longestBlockMs < 10 * 60 * 1000, 'longest block should be the first day only')

const names = { 'model-a': 'Model A', 'model-b': 'Model B' }
const overview = buildOverview([fold], 7, names, dayKey(0))
check(overview.totals.tokens === 3500, 'overview tokens')
check(overview.totals.peakDayTokens === 2000, 'overview peak day')
check(overview.totals.currentStreak === 2, `current streak ${overview.totals.currentStreak}`)
check(overview.totals.longestStreak === 2, `longest streak ${overview.totals.longestStreak}`)
check(overview.models.length === 2, 'overview should list both models in range')
check(overview.models[0].name === 'Model A' && overview.models[0].tokens === 3000, 'top model entry')
check(overview.models[0].key === keyA && overview.models[0].provider === 'p', 'top model keeps provider identity')
check(overview.models[0].label === 'Model A', 'a unique model name needs no provider suffix')
check(overview.trend.models[0] === keyA, 'trend series reuse aggregation keys')
check(Math.abs(overview.models[0].share - 3000 / 3500) < 1e-9, 'top model share')
check(overview.trend.days.length === 7, 'trend range length')

// The heatmap covers twelve whole calendar months ending with the current one,
// so the current month's not-yet-reached days are already in the grid.
const fmt = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const windowStart = new Date()
windowStart.setDate(1)
windowStart.setMonth(windowStart.getMonth() - 11)
const windowEnd = new Date()
windowEnd.setDate(1)
windowEnd.setMonth(windowEnd.getMonth() + 1)
windowEnd.setDate(0)
check(overview.heatmap.days[0].d === fmt(windowStart), `heatmap starts at ${fmt(windowStart)}, got ${overview.heatmap.days[0].d}`)
check(overview.heatmap.days[overview.heatmap.days.length - 1].d === fmt(windowEnd), `heatmap ends at ${fmt(windowEnd)}, got ${overview.heatmap.days[overview.heatmap.days.length - 1].d}`)
check(overview.heatmap.days.length >= 365 && overview.heatmap.days.length <= 366, 'heatmap should be a whole 12-month year')
check(overview.heatmap.days.some((day) => day.d === dayKey(0)), 'heatmap must include today')
const currentMonth = dayKey(0).slice(0, 7)
check(overview.heatmap.days.filter((day) => day.d.startsWith(currentMonth)).length === new Date(windowEnd.getFullYear(), windowEnd.getMonth() + 1, 0).getDate(), 'heatmap must contain every day of the current month')
check(prettyModelName('deepseek-v4.1-flash') === 'DeepSeek-V4.1-Flash', 'fallback display name')

// Two providers serving the same display name must be annotated, while unique
// names stay bare.
const firstFold = aggregateSession({ id: 'session-test-1b' }, [
  {
    type: 'request/header',
    time: at(0, 11, 0),
    data: { turn: 1, step: 1, header: { config: { provider: 'p', model: 'model-a' } } },
  },
  { type: 'assistant/message', time: at(0, 11, 2), data: { turn: 1, step: 1, usage: { totalTokens: 1000 } } },
])
const secondFold = aggregateSession({ id: 'session-test-2' }, [
  {
    type: 'request/header',
    time: at(0, 11, 0),
    data: { turn: 1, step: 1, header: { config: { provider: 'q', model: 'model-a' } } },
  },
  { type: 'assistant/message', time: at(0, 11, 2), data: { turn: 1, step: 1, usage: { totalTokens: 1000 } } },
])
const collision = buildOverview([firstFold, secondFold], 7, { 'model-a': 'Model A' }, dayKey(0))
check(collision.models.length === 2, 'collision overview should keep both provider rows')
check(collision.models.every((entry) => entry.name === 'Model A'), 'collision rows keep the display name')
check(collision.models.every((entry) => entry.label.includes(' · ')), 'collision rows must carry a provider suffix')
const labels = collision.models.map((entry) => entry.label).sort()
check(labels[0].endsWith('· P') && labels[1].endsWith('· Q'), 'collision suffix should be the provider label: ' + labels.join(' | '))

// A live catalog name wins over the id fallback for the suffix.
const catalogued = buildOverview([firstFold, secondFold], 7, {
  providers: { p: 'OpenCode', q: 'OpenCode Go' },
  models: { 'model-a': 'Model A' },
  providerModels: { p: { 'model-a': 'Model A' }, q: { 'model-a': 'Model A' } },
}, dayKey(0))
const cataloguedLabels = catalogued.models.map((entry) => entry.label).sort()
check(cataloguedLabels.some((label) => label.endsWith('· OpenCode')), 'provider catalog name should annotate: ' + cataloguedLabels.join(' | '))
check(cataloguedLabels.some((label) => label.endsWith('· OpenCode Go')), 'second provider catalog name should annotate: ' + cataloguedLabels.join(' | '))

// A provider whose catalog name is just its raw id falls back to a readable
// label (opencode-go → OpenCode, deepseek-official → DeepSeek).
const rawFolds = ['opencode-go', 'deepseek-official'].map((provider, index) => aggregateSession(
  { id: `session-raw-${index}` },
  [
    {
      type: 'request/header',
      time: at(0, 12, 0),
      data: { turn: 1, step: 1, header: { config: { provider, model: 'model-a' } } },
    },
    { type: 'assistant/message', time: at(0, 12, 2), data: { turn: 1, step: 1, usage: { totalTokens: 1000 } } },
  ],
))
const rawCatalog = buildOverview(rawFolds, 7, { 'model-a': 'Model A' }, dayKey(0))
const rawLabels = rawCatalog.models.map((entry) => entry.label).sort()
check(rawLabels.includes('Model A · OpenCode'), 'raw provider id should still read as OpenCode: ' + rawLabels.join(' | '))
check(rawLabels.includes('Model A · DeepSeek'), 'deepseek-official should read as DeepSeek: ' + rawLabels.join(' | '))



if (failures.length > 0) {
  console.error('host-fold: FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('host-fold: PASS (fold + overview + streak + range)')
