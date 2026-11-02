#!/usr/bin/env node
/**
 * Client render test: loads the browser bundle under a mock module loader and
 * a minimal React, checks the slot registrations and the two-stage hello, then
 * renders the three charts and the page's loading state without throwing.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')
const code = readFileSync(join(pluginDir, 'client.js'), 'utf8')

const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

const fakeElement = () => ({
  setAttribute() {}, getAttribute() { return null }, appendChild() {}, remove() {},
  textContent: '', style: {}, addEventListener() {}, removeEventListener() {},
  querySelector() { return null }, querySelectorAll() { return [] }, parentElement: null,
})
globalThis.document = {
  head: { appendChild() {} },
  body: { appendChild() {} },
  documentElement: fakeElement(),
  cookie: '',
  createElement: () => fakeElement(),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
}
const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: () => ({ current: null }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useLayoutEffect: () => {},
  useSyncExternalStore: (getSnapshot) => getSnapshot(),
}
const hellos = []
globalThis.fetch = async (url) => {
  hellos.push(String(url))
  return { ok: true, json: async () => ({ ok: true }) }
}
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
const loaded = {}
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded.id = id
      loaded.module = factory((name) => {
        if (name === 'react') return React
        throw new Error('unexpected require: ' + name)
      })
    },
  },
}
// eslint-disable-next-line no-eval
eval(code)

check(loaded.id === 'dsh-token-usage', `bundle id ${String(loaded.id)}`)
const registrations = []
const ctx = {
  effect(fn, label) { try { const dispose = fn(); if (typeof dispose === 'function') dispose() } catch (error) { failures.push(label + ': ' + error) } },
  slots: {
    inject(name, callback) { callback(); return () => {} },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  },
  locale: { register() { return () => {} }, bind() { return (key) => key } },
}
loaded.module.apply(ctx)
check(registrations.some((entry) => entry.options.name === 'sidebar.panellist' && entry.options.id === 'dsh-token-usage'), 'sidebar entry not registered')
check(registrations.some((entry) => entry.options.name === 'main' && entry.options.key === 'dsh-token-usage'), 'main dashboard view not registered')
check(hellos.some((url) => url.includes('-start')), 'no start hello')
check(hellos.some((url) => url.includes('-ready')), 'no ready hello after registrations')

const api = loaded.module.__test
check(api !== undefined, 'no test surface')
check(api.fmtTokens(100000000) === '1亿', 'fmtTokens 1e8')
check(api.fmtTokens(55711000) === '5571.1万', 'fmtTokens 55.711M')
check(api.fmtDuration(11460000) === '3小时11分钟', 'fmtDuration')
check(api.fmtShare(0.5) === '50%', 'fmtShare')

// A series that falls to zero after a peak must never draw below the axis:
// the monotone spline keeps every emitted y inside the two values it connects.
const bump = api.smoothPath([[0, 0], [10, 100], [20, 0], [30, 0], [40, 80], [50, 0]])
const numbers = bump.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
const ys = numbers.filter((_, index) => index % 2 === 1)
check(ys.length > 10, 'smoothPath emitted no coordinates')
check(ys.every((value) => value >= -1e-6 && value <= 100 + 1e-6), 'smoothPath overshoots the series range: ' + ys.filter((value) => value < -1e-6 || value > 100 + 1e-6).slice(0, 4).join(','))
check(ys.every((value) => value !== 0 ? true : true), 'noop')

const days = Array.from({ length: 365 }, (_, index) => {
  const date = new Date()
  date.setDate(date.getDate() - (364 - index))
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return { d: key, t: index % 9 === 0 ? (index % 4 + 1) * 12000 : 0 }
})
const heat = api.buildHeatmap(days, 'day')
check(heat.cells.length % 7 === 0, 'heat cells not whole weeks')
check(heat.cells.filter(Boolean).length === 365, 'heat cells should cover 365 days')
check(heat.labels.length === heat.columns, 'month labels misaligned')
check(api.buildHeatmap(days, 'week').cells.filter(Boolean).length === 365, 'week mode days')
check(api.buildHeatmap(days, 'cumulative').max > 0, 'cumulative mode max')

const trendDays = Array.from({ length: 30 }, (_, index) => {
  const date = new Date()
  date.setDate(date.getDate() - (29 - index))
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return { d: key, t: 1000 + index * 10, m: { 'p\u0001model-a': 1000 + index * 10 } }
})
const overview = {
  ok: true,
  range: 30,
  totals: { tokens: 1e8, peakDayTokens: 5.5e7, peakDay: trendDays[0].d, longestChatMs: 11460000, currentStreak: 2, longestStreak: 6, sessions: 3, activeDays: 10 },
  heatmap: { days },
  trend: { days: trendDays, models: ['p\u0001model-a'] },
  models: [
    { key: 'p\u0001model-a', id: 'model-a', provider: 'p', providerName: 'P', name: 'Model A', label: 'Model A', tokens: 5e7, share: 0.6 },
    { key: 'q\u0001model-a', id: 'model-a', provider: 'q', providerName: 'Q', name: 'Model A', label: 'Model A · Q', tokens: 3.3e7, share: 0.4 },
  ],
  rangeTokens: 8.3e7,
}
const names = { 'p\u0001model-a': 'Model A' }

const collectText = (node, out = []) => {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (typeof node === 'object' && Array.isArray(node.children)) collectText(node.children, out)
  return out
}
const walk = (node, visit) => {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  if (typeof node !== 'object') return
  visit(node)
  if (Array.isArray(node.children)) for (const child of node.children) walk(child, visit)
}

const heatTree = api.Heatmap({ days })
const trendTree = api.TrendChart({ days: trendDays, models: ['p\u0001model-a'], names })
const donutTree = api.ModelShare({ models: overview.models, total: overview.rangeTokens })
check(collectText(heatTree).join(' ').includes('Token 活动'), 'heatmap title missing')
check(collectText(trendTree).join(' ').includes('每日 Token 趋势图'), 'trend title missing')
check(collectText(donutTree).join(' ').includes('模型用量'), 'donut title missing')
check(collectText(donutTree).join(' ').includes('Model A'), 'donut legend missing model')
check(collectText(donutTree).join(' ').includes('Model A · Q'), 'same-name models must be annotated with their provider')
const slices = []
walk(donutTree, (node) => {
  if (node.type === 'circle' && typeof node.props?.onMouseEnter === 'function') slices.push(node)
})
const hoverableSlices = overview.models.filter((model) => model.tokens > 0).length
check(slices.length === hoverableSlices, `every donut slice should be hoverable (${slices.length}/${hoverableSlices})`)
check(slices.every((node) => node.props?.style?.cursor === 'pointer'), 'donut slices should show a pointer cursor')
check(
  slices.some((node) => Array.isArray(node.children) && node.children.some((child) => child?.type === 'title' && collectText(child).join('').includes('Model A'))),
  'donut slices should carry a native title with the model label',
)
for (const slice of slices) {
  // Shape check: the handler must survive without a mounted ref (null layout box).
  slice.props.onMouseEnter({ clientX: 16, clientY: 16 })
  slice.props.onMouseLeave()
}

const cells = []
walk(heatTree, (node) => { if (node.props?.className === 'dstu-heatCell') cells.push(node) })
check(cells.length === heat.cells.length, 'rendered heat cell count')
check(
  cells.every((node) => typeof node.props?.style?.backgroundColor === 'string' && node.props.style.backgroundColor.length > 0),
  'every heat cell must carry an inline colour (the year grid stays visible even when a theme token is near-white)',
)
check(
  cells.filter((node) => node.props?.style?.backgroundColor === 'rgba(124,135,155,.22)').length > 300,
  'the year grid should show hundreds of empty-day cells',
)
const paths = []
walk(trendTree, (node) => { if (node.type === 'path' && typeof node.props?.d === 'string' && node.props.d.length > 10) paths.push(node.props.d) })
check(paths.length >= 1, 'trend chart has no series path')

// The two average cards: range total ÷ range days, and today's total ÷ elapsed hours.
const noon = new Date(2026, 10, 2, 12, 0, 0)
const averageBase = {
  range: 7,
  rangeTokens: 7000,
  today: '2026-11-02',
  trend: { days: [{ d: '2026-11-01', t: 100 }, { d: '2026-11-02', t: 2400 }] },
}
const sevenDayAverage = api.buildTokenAverages(averageBase, noon.getTime())
check(sevenDayAverage.rangeDays === 7 && sevenDayAverage.dailyAverage === 1000, 'seven-day average must divide by 7')
check(sevenDayAverage.todayTokens === 2400, 'today tokens come from the trend day')
check(Math.abs(sevenDayAverage.hourlyAverage - 200) < 1e-9, 'hourly average must divide by elapsed hours')
const thirtyDayAverage = api.buildTokenAverages({ ...averageBase, range: 30, rangeTokens: 30000 }, noon.getTime())
check(thirtyDayAverage.rangeDays === 30 && thirtyDayAverage.dailyAverage === 1000, 'thirty-day average must divide by 30')
const midnightAverage = api.buildTokenAverages(
  { range: 7, rangeTokens: 0, today: '2026-11-02', trend: { days: [{ d: '2026-11-02', t: 1200 }] } },
  new Date(2026, 10, 2, 0, 0, 0).getTime(),
)
check(midnightAverage.hourlyAverage === 1200, 'before an hour has passed the divisor is clamped to 1')
const emptyAverage = api.buildTokenAverages(
  { range: 7, rangeTokens: 0, today: '2026-11-03', trend: { days: [{ d: '2026-11-02', t: 900 }] } },
  noon.getTime(),
)
check(emptyAverage.dailyAverage === 0 && emptyAverage.todayTokens === 0 && emptyAverage.hourlyAverage === 0, 'empty data averages are zero')
const unitCard = api.StatCard({ value: '100', unit: '/天', label: '每日平均' })
check(collectText(unitCard).join('').includes('/天'), 'stat cards should render their unit')

// Per-model colour overrides drive the donut, the legend pickers and the trend.
const colorMap = { 'p\u0001model-a': '#123456' }
check(api.colorForModel('p\u0001model-a', 0, {}) === '#4d6bfe', 'default model colour')
check(api.colorForModel('p\u0001model-a', 0, colorMap) === '#123456', 'override model colour')
check(api.colorForModel('p\u0001model-a', 2, { bad: 'x' }) === '#f59e0b', 'invalid override falls back to palette')
const pickedColours = []
const coloredDonut = api.ModelShare({
  models: overview.models,
  total: overview.rangeTokens,
  colors: colorMap,
  onPickColor: (key, color) => pickedColours.push([key, color]),
  onResetColors: () => pickedColours.push(['reset']),
})
const coloredArcs = []
walk(coloredDonut, (node) => {
  if (node.type === 'circle' && typeof node.props?.stroke === 'string' && node.props.stroke.startsWith('#')) coloredArcs.push(node.props.stroke)
})
check(coloredArcs.includes('#123456'), 'donut arcs should use the chosen colour')
const colourInputs = []
walk(coloredDonut, (node) => { if (node.type === 'input' && node.props?.type === 'color') colourInputs.push(node) })
const colourInput = colourInputs.find((node) => node.props?.value === '#123456')
check(colourInput !== undefined, 'legend colour picker should show the chosen colour')
check(String(colourInput?.props?.title ?? '').includes('颜色'), 'legend colour picker should explain itself')
colourInput.props.onChange({ target: { value: '#00ff00' } })
check(pickedColours.some(([key, value]) => key === 'p\u0001model-a' && value === '#00ff00'), 'colour picker change should be reported')
const colourButtons = []
walk(coloredDonut, (node) => { if (node.type === 'button') colourButtons.push(node) })
const resetButton = colourButtons.find((node) => collectText(node).join('').includes('恢复默认颜色'))
check(resetButton !== undefined, 'reset-colours button should appear when overrides exist')
resetButton.props.onClick()
check(pickedColours.some(([key]) => key === 'reset'), 'reset should be reported')
const coloredTrend = api.TrendChart({ days: trendDays, models: ['p\u0001model-a'], names, colors: colorMap })
const trendStrokes = []
walk(coloredTrend, (node) => { if (node.type === 'path' && typeof node.props?.stroke === 'string') trendStrokes.push(node.props.stroke) })
check(trendStrokes.includes('#123456'), 'trend line should use the chosen colour')

// The dashboard toolbar carries the two explicit actions.
check(/^\d{2}-\d{2} \d{2}:\d{2}$/.test(api.fmtDateTime(Date.now())), 'fmtDateTime shape')
const toolbarText = collectText(api.DashboardToolbar({ busy: false, updatedAt: Date.now(), clearedAt: 0 })).join(' ')
check(toolbarText.includes('清除统计'), 'toolbar clear button copy missing')
check(toolbarText.includes('刷新'), 'toolbar refresh button copy missing')
const busyToolbar = collectText(api.DashboardToolbar({ busy: true, updatedAt: 0, clearedAt: 0 })).join(' ')
check(busyToolbar.includes('刷新中…'), 'busy toolbar should show the refresh progress label')
const clearedToolbar = collectText(api.DashboardToolbar({ busy: false, updatedAt: 0, clearedAt: Date.now() })).join(' ')
check(clearedToolbar.includes('统计起点'), 'toolbar should show the statistics origin after a clear')
const toolbarButtons = []
walk(api.DashboardToolbar({}), (node) => { if (node.type === 'button') toolbarButtons.push(node) })
check(toolbarButtons.length === 2, `toolbar should have two buttons, got ${toolbarButtons.length}`)
const clearButton = toolbarButtons.find((node) => collectText(node).join('').includes('清除统计'))
const refreshButton = toolbarButtons.find((node) => collectText(node).join('').includes('刷新'))
check(clearButton !== undefined && refreshButton !== undefined, 'toolbar buttons are not identifiable')
let clearedClicks = 0
let refreshedClicks = 0
api.DashboardToolbar({ onClear: () => { clearedClicks += 1 }, onRefresh: () => { refreshedClicks += 1 } })
const wired = []
walk(api.DashboardToolbar({ onClear: () => { clearedClicks += 1 }, onRefresh: () => { refreshedClicks += 1 } }), (node) => {
  if (node.type === 'button') wired.push(node)
})
wired.find((node) => collectText(node).join('').includes('清除统计')).props.onClick()
wired.find((node) => collectText(node).join('').includes('刷新')).props.onClick()
check(clearedClicks === 1 && refreshedClicks === 1, 'toolbar callbacks are not wired')

// The page's first paint (data null, no error) must be the loading card.
const pageText = collectText(api.Dashboard({})).join(' ')
check(pageText.includes('正在读取会话用量'), 'first paint is not the loading state: ' + pageText.slice(0, 80))

if (failures.length > 0) {
  console.error('client-render: FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('client-render: PASS (slots + two-stage hello + charts + toolbar + averages + model colours + first paint)')
