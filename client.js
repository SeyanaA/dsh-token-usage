/**
 * dsh-token-usage — browser half.
 *
 * The dashboard page: one full-width main-panel view registered as the
 * "Token 用量" entry under New Session in the left sidebar.
 *
 * It renders four things from the host's `/api/dsh-token-usage/overview`:
 *
 *   - five whole-history stat cards,
 *   - a GitHub-style activity heatmap of the trailing 365 days
 *     (每日 / 每周 / 累计),
 *   - a daily token trend line chart for the selected range (近 7 日 / 近 30 日),
 *   - a per-model share donut with token counts and percentages.
 *
 * Charts are hand-drawn SVG/CSS: the panel loads as a plain browser bundle, so
 * it must not depend on a chart library.
 */

window.__ModuleLoader__.load({
  id: 'dsh-token-usage',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-token-usage'

    /** The global-panel id; also the `main` view key and the CSS prefix source. */
    const PANEL_ID = 'dsh-token-usage'

    /** Where the host half serves the folded usage document. */
    const OVERVIEW_ROUTE = '/api/dsh-token-usage/overview'

    /** The host half's client-load observation route. */
    const HELLO_ROUTE = '/api/dsh-token-usage/hello'

    /** This half's version, sent with the hello. */
    const VERSION = '0.1.0'

    /** Accent + categorical palette for the model series. */
    const ACCENT = '#4d6bfe'
    const PALETTE = ['#4d6bfe', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#06b6d4', '#eab308', '#ec4899']

    const zh = {
      'panel.label': 'Token 用量',
    }
    const en = {
      'panel.label': 'Token Usage',
    }

    //#region formatting

    /** Strip trailing zeroes from a fixed-point string. */
    function trimZeros(value) {
      return value.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
    }

    /**
     * Format a token count the way the screenshots do: 亿 / 万 / raw.
     * @param {number} value - token count.
     * @returns the display string.
     */
    function fmtTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0'
      if (value >= 1e8) return trimZeros((value / 1e8).toFixed(2)) + '亿'
      if (value >= 1e4) return trimZeros((value / 1e4).toFixed(1)) + '万'
      return String(Math.round(value))
    }

    /**
     * @param {number} share - 0..1.
     * @returns the percentage string, one decimal at most.
     */
    function fmtShare(share) {
      if (typeof share !== 'number' || !Number.isFinite(share) || share <= 0) return '0%'
      return trimZeros((share * 100).toFixed(1)) + '%'
    }

    /**
     * @param {number} ms - duration in milliseconds.
     * @returns a compact Chinese duration, e.g. `3小时11分钟`.
     */
    function fmtDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '0分钟'
      const totalMinutes = Math.max(1, Math.round(ms / 60000))
      const days = Math.floor(totalMinutes / 1440)
      const hours = Math.floor((totalMinutes % 1440) / 60)
      const minutes = totalMinutes % 60
      const parts = []
      if (days > 0) parts.push(days + '天')
      if (hours > 0) parts.push(hours + '小时')
      if (minutes > 0 && days === 0) parts.push(minutes + '分钟')
      return parts.length === 0 ? '不到1分钟' : parts.join('')
    }

    /** `2026-10-25` → `10月25日`. */
    function fmtDayLabel(key) {
      const parts = String(key).split('-').map(Number)
      return `${parts[1] ?? ''}月${parts[2] ?? ''}日`
    }

    /** `2026-10-25` → `10月`. */
    function fmtMonthLabel(key) {
      const parts = String(key).split('-').map(Number)
      return `${parts[1] ?? ''}月`
    }

    //#endregion

    //#region heatmap model

    /** Weekday index with Monday = 0. */
    function mondayIndex(dayKey) {
      const date = new Date(dayKey + 'T00:00:00')
      return (date.getDay() + 6) % 7
    }

    /** Local day key shifted by whole days. */
    function shiftDayKey(dayKey, delta) {
      const date = new Date(dayKey + 'T00:00:00')
      date.setDate(date.getDate() + delta)
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${date.getFullYear()}-${month}-${day}`
    }

    /**
     * Turn the host's trailing-365-day series into aligned calendar cells.
     *
     * @param {readonly {d: string, t: number}[]} days - gap-filled daily totals.
     * @param {'day'|'week'|'cumulative'} mode - what each cell represents.
     * @returns the cell grid, month labels and the busiest value.
     */
    function buildHeatmap(days, mode) {
      const rows = Array.isArray(days) ? days : []
      if (rows.length === 0) return { cells: [], columns: 0, labels: [], max: 0 }
      const byDay = new Map(rows.map((row) => [row.d, row.t ?? 0]))

      // Weekly totals keyed by the Monday that starts the week.
      const weekTotals = new Map()
      if (mode === 'week') {
        for (const row of rows) {
          const monday = shiftDayKey(row.d, -mondayIndex(row.d))
          weekTotals.set(monday, (weekTotals.get(monday) ?? 0) + (row.t ?? 0))
        }
      }

      // Running total keyed by day.
      const cumulative = new Map()
      if (mode === 'cumulative') {
        let running = 0
        for (const row of rows) {
          running += row.t ?? 0
          cumulative.set(row.d, running)
        }
      }

      const valued = rows.map((row) => {
        const value = mode === 'week'
          ? (weekTotals.get(shiftDayKey(row.d, -mondayIndex(row.d))) ?? 0)
          : mode === 'cumulative'
            ? (cumulative.get(row.d) ?? 0)
            : (row.t ?? 0)
        return { d: row.d, v: value }
      })
      const max = Math.max(1, ...valued.map((cell) => cell.v))

      const cells = []
      const leading = mondayIndex(rows[0].d)
      for (let index = 0; index < leading; index += 1) cells.push(null)
      for (const cell of valued) {
        const level = cell.v <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((cell.v / max) * 4)))
        cells.push({ ...cell, level })
      }
      while (cells.length % 7 !== 0) cells.push(null)

      const columns = cells.length / 7
      const labels = []
      let lastMonth = ''
      for (let column = 0; column < columns; column += 1) {
        const day = cells.slice(column * 7, column * 7 + 7).find((cell) => cell !== null)
        if (day === undefined || day === null) {
          labels.push('')
          continue
        }
        const month = day.d.slice(0, 7)
        if (month !== lastMonth) {
          labels.push(fmtMonthLabel(day.d))
          lastMonth = month
        } else {
          labels.push('')
        }
      }
      return { cells, columns, labels, max }
    }

    //#endregion

    //#region charts

    /**
     * Monotone cubic through the points, emitted as cubic Béziers.
     *
     * A plain Catmull-Rom spline overshoots between neighbouring samples: a
     * series that drops to zero after a peak starts dipping *below* zero, which
     * drew the line under the chart's baseline. Fritsch–Carlson tangents keep
     * every segment inside the two values it connects, so a zero stays on the
     * axis and a peak never draws a phantom negative.
     */
    function smoothPath(points) {
      if (!Array.isArray(points) || points.length === 0) return ''
      if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`
      const deltas = []
      const slopes = []
      for (let index = 0; index < points.length - 1; index += 1) {
        const dx = points[index + 1][0] - points[index][0]
        const dy = points[index + 1][1] - points[index][1]
        deltas.push(dx)
        slopes.push(dx === 0 ? 0 : dy / dx)
      }
      const tangents = new Array(points.length)
      tangents[0] = slopes[0]
      tangents[points.length - 1] = slopes[slopes.length - 1]
      for (let index = 1; index < points.length - 1; index += 1) {
        const previous = slopes[index - 1]
        const next = slopes[index]
        if (previous * next <= 0) {
          tangents[index] = 0
          continue
        }
        const average = (previous + next) / 2
        const limit = 3 * Math.min(Math.abs(previous), Math.abs(next))
        tangents[index] = Math.abs(average) > limit ? Math.sign(average) * limit : average
      }
      let path = `M ${points[0][0]} ${points[0][1]}`
      for (let index = 0; index < points.length - 1; index += 1) {
        const dx = deltas[index]
        const x1 = points[index][0]
        const y1 = points[index][1]
        const x2 = points[index + 1][0]
        const y2 = points[index + 1][1]
        const c1x = x1 + dx / 3
        const c1y = y1 + (tangents[index] * dx) / 3
        const c2x = x2 - dx / 3
        const c2y = y2 - (tangents[index + 1] * dx) / 3
        path += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`
      }
      return path
    }

    /**
     * The five heat levels, as inline colours.
     *
     * The cells deliberately carry their colours inline instead of relying on
     * the injected stylesheet: a hot reload can re-run `apply` while the page
     * still holds an older `<style>` tag, and a theme token such as
     * `bg-layer-3` blends into a white card on light themes. Inline colours
     * keep the whole year visible in both cases.
     */
    const HEAT_COLORS = [
      'rgba(124,135,155,.22)',
      'rgba(77,107,254,.26)',
      'rgba(77,107,254,.46)',
      'rgba(77,107,254,.70)',
      'rgba(77,107,254,1)',
    ]

    /** The token-activity heatmap. */
    function Heatmap(props) {
      const [mode, setMode] = React.useState('day')
      const [tip, setTip] = React.useState(null)
      const model = buildHeatmap(props.days, mode)

      // Fill the card instead of leaving a small grid pinned to the left: the
      // cell pitch is derived from the measured card width, between a dense and
      // an airy bound, so a wide window gets the roomier look.
      const wrapRef = React.useRef(null)
      const [measured, setMeasured] = React.useState(880)
      React.useEffect(() => {
        const node = wrapRef.current
        if (node === null || node === undefined) return undefined
        const update = () => {
          const next = Math.max(320, Math.round(node.clientWidth || 880))
          setMeasured((previous) => (previous === next ? previous : next))
        }
        update()
        if (typeof ResizeObserver !== 'undefined') {
          const observer = new ResizeObserver(update)
          observer.observe(node)
          return () => observer.disconnect()
        }
        window.addEventListener('resize', update)
        return () => window.removeEventListener('resize', update)
      }, [])

      const columns = Math.max(1, model.columns)
      const gap = 4
      const pitch = Math.max(13, Math.min(20, Math.floor((measured + gap) / columns)))
      const cellSize = Math.max(9, pitch - gap)
      const tipWidth = 190

      const showTip = (event, cell) => {
        if (cell === null) {
          setTip(null)
          return
        }
        const grid = event.currentTarget.parentElement
        const box = grid === null || grid === undefined || typeof grid.getBoundingClientRect !== 'function'
          ? null
          : grid.getBoundingClientRect()
        const width = box === null ? 0 : box.width
        // Follow the pointer, clamped to the grid box so a cell at either edge
        // cannot push the tooltip out of the card.
        const left = Math.max(4, Math.min(Math.max(4, width - tipWidth), event.clientX - (box === null ? 0 : box.left) + 12))
        const relativeY = box === null ? 0 : event.clientY - box.top
        // A tooltip above a first-row cell would cover the cell being hovered,
        // so the top rows get theirs below the pointer instead.
        const rawTop = relativeY < 42 ? relativeY + 20 : relativeY - 36
        setTip({ left, top: Math.max(2, Math.min(Math.max(2, box === null ? 2 : box.height - 32), rawTop)), cell })
      }

      const tabs = [
        { id: 'day', label: '每日' },
        { id: 'week', label: '每周' },
        { id: 'cumulative', label: '累计' },
      ]

      return h('div', { className: 'dstu-card' }, [
        h('div', { key: 'head', className: 'dstu-cardHead' }, [
          h('span', { key: 'title', className: 'dstu-cardTitle' }, 'Token 活动'),
          h('div', { key: 'tabs', className: 'dstu-tabs' }, tabs.map((tab) => h('button', {
            key: tab.id,
            type: 'button',
            className: 'dstu-tab',
            'data-active': mode === tab.id ? '1' : '0',
            onClick: () => setMode(tab.id),
          }, tab.label))),
        ]),
        h('div', { key: 'heat', className: 'dstu-heatWrap', ref: wrapRef, onMouseLeave: () => setTip(null) }, [
          h('div', { key: 'scroll', className: 'dstu-heat' }, [
            h('div', {
              key: 'grid',
              className: 'dstu-heatGrid',
              style: {
                display: 'grid',
                gap: gap + 'px',
                gridTemplateRows: `repeat(7, ${cellSize}px)`,
                gridAutoFlow: 'column',
                gridAutoColumns: `${cellSize}px`,
              },
            }, model.cells.map((cell, index) => h('span', {
              key: index,
              className: 'dstu-heatCell',
              'data-level': cell === null ? 0 : cell.level,
              'data-hover': tip !== null && cell !== null && tip.cell.d === cell.d ? '1' : '0',
              style: {
                width: cellSize + 'px',
                height: cellSize + 'px',
                borderRadius: Math.max(2, Math.round(cellSize * 0.24)) + 'px',
                backgroundColor: HEAT_COLORS[cell === null ? 0 : cell.level],
                // Draw the hover ring inside the cell. An outline would sit
                // outside the box and the heatmap's scroll container clips the
                // top row's outside edge, cutting the ring's top line.
                boxShadow: tip !== null && cell !== null && tip.cell.d === cell.d
                  ? 'inset 0 0 0 2px var(--dsw-alias-state-business-primary, #4d6bfe)'
                  : undefined,
                // The padding cells before the first day and after the last one
                // keep the week shape without pretending to be days.
                visibility: cell === null ? 'hidden' : 'visible',
              },
              title: cell === null ? undefined : `${fmtDayLabel(cell.d)} · ${fmtTokens(cell.v)} tokens`,
              onMouseEnter: (event) => showTip(event, cell),
            }))),
            h('div', {
              key: 'months',
              className: 'dstu-heatMonths',
              style: {
                gap: gap + 'px',
                gridTemplateRows: '16px',
                gridAutoFlow: 'column',
                gridAutoColumns: `${cellSize}px`,
              },
            }, model.labels.map((label, index) => h('span', { key: index }, label))),
          ]),
          tip === null ? null : h('div', {
            key: 'tip',
            className: 'dstu-heatTip',
            style: {
              position: 'absolute',
              left: tip.left + 'px',
              top: tip.top + 'px',
              zIndex: 7,
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 8,
              padding: '6px 10px',
              borderRadius: 8,
              background: 'rgba(24,24,27,.95)',
              color: '#fff',
              fontSize: 11,
              lineHeight: 1.4,
              whiteSpace: 'nowrap',
              boxShadow: '0 8px 20px rgba(0,0,0,.35)',
              pointerEvents: 'none',
            },
          }, [
            h('span', { key: 'date', className: 'dstu-heatTipDate' }, fmtDayLabel(tip.cell.d)),
            h('span', { key: 'value', className: 'dstu-heatTipValue' }, `${fmtTokens(tip.cell.v)} tokens`),
          ]),
        ]),
      ])
    }

    /** The daily token trend chart. */
    function TrendChart(props) {
      const days = props.days ?? []
      const names = props.names ?? {}
      const modelIds = (props.models ?? []).slice(0, 6)
      const [hover, setHover] = React.useState(null)
      // Measure the card once and keep the SVG's user space the same size as its
      // box, so text and strokes are never stretched by preserveAspectRatio.
      const wrapRef = React.useRef(null)
      const [measured, setMeasured] = React.useState(880)
      React.useEffect(() => {
        const node = wrapRef.current
        if (node === null || node === undefined) return undefined
        const update = () => {
          const next = Math.max(480, Math.round(node.clientWidth || 880))
          setMeasured((previous) => (previous === next ? previous : next))
        }
        update()
        if (typeof ResizeObserver !== 'undefined') {
          const observer = new ResizeObserver(update)
          observer.observe(node)
          return () => observer.disconnect()
        }
        window.addEventListener('resize', update)
        return () => window.removeEventListener('resize', update)
      }, [])

      const width = measured
      const height = 282
      const padLeft = 66
      const padRight = 24
      const padTop = 14
      const padBottom = 32
      const innerWidth = width - padLeft - padRight
      const innerHeight = height - padTop - padBottom

      // A model used for a handful of tokens still draws a flat line on the
      // baseline and clutters the legend, so keep only series that carry at
      // least 1% of the range. Colours follow the host's model ordering, which
      // the donut uses too, so a model keeps its colour in both charts.
      const candidateIds = (Array.isArray(props.models) ? props.models : []).slice(0, 8)
      const colorIndex = new Map((Array.isArray(props.models) ? props.models : []).map((id, index) => [id, index]))
      const totals = candidateIds.map((id) => ({
        id,
        total: days.reduce((sum, day) => {
          const bucket = day.m !== undefined && day.m !== null ? (day.m[id] ?? 0) : 0
          return sum + bucket
        }, 0),
      }))
      const rangeTotal = totals.reduce((sum, item) => sum + item.total, 0)
      const visible = totals
        .filter((item) => item.total > 0 && (rangeTotal === 0 || item.total / rangeTotal >= 0.01))
        .sort((left, right) => right.total - left.total)
        .map((item) => item.id)
      const modelIdsToDraw = visible.length > 0
        ? visible.slice(0, 6)
        : totals.filter((item) => item.total > 0).slice(0, 3).map((item) => item.id)

      const series = modelIdsToDraw.map((id, index) => ({
        id,
        name: names[id] ?? String(id).replace('\u0001', ' · '),
        color: PALETTE[(colorIndex.get(id) ?? index) % PALETTE.length],
        values: days.map((day) => (day.m !== undefined && day.m !== null ? (day.m[id] ?? 0) : 0)),
      }))
      let max = 1
      for (const item of series) for (const value of item.values) if (value > max) max = value

      const x = (index) => padLeft + (days.length <= 1 ? innerWidth / 2 : (index / (days.length - 1)) * innerWidth)
      const y = (value) => padTop + innerHeight - (value / max) * innerHeight

      const gridLines = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
        value: max * ratio,
        y: padTop + innerHeight - ratio * innerHeight,
      }))

      const labelIndexes = []
      const labelCount = Math.min(6, days.length)
      for (let index = 0; index < labelCount; index += 1) {
        labelIndexes.push(Math.round((index / Math.max(1, labelCount - 1)) * (days.length - 1)))
      }

      const hoverDay = hover === null ? undefined : days[hover]
      // The tooltip is positioned in the measured card's own pixels and clamped
      // to its box, so hovering the last day cannot push it past the panel edge.
      const tooltipWidth = 236
      const hoverLeft = hover === null
        ? 0
        : Math.max(8, Math.min(Math.max(8, width - tooltipWidth - 8), x(hover) - tooltipWidth / 2))

      const tooltip = hoverDay === undefined ? null : h('div', {
        key: 'tip',
        className: 'dstu-tooltip',
        style: { left: hoverLeft + 'px', top: '8px', maxWidth: tooltipWidth + 'px' },
      }, [
        h('div', { key: 'date', className: 'dstu-tooltipDate' }, fmtDayLabel(hoverDay.d)),
        ...series.map((item) => {
          const value = hoverDay.m !== undefined && hoverDay.m !== null ? (hoverDay.m[item.id] ?? 0) : 0
          return h('div', { key: item.id, className: 'dstu-tooltipRow' }, [
            h('span', { key: 'dot', className: 'dstu-legendDot', style: { background: item.color } }),
            h('span', { key: 'name', className: 'dstu-tooltipName' }, item.name),
            h('span', { key: 'value', className: 'dstu-tooltipValue' }, `${fmtTokens(value)} tokens`),
          ])
        }),
        h('div', { key: 'total', className: 'dstu-tooltipTotal' }, `合计 ${fmtTokens(hoverDay.t ?? 0)} tokens`),
      ])

      const svg = h('svg', {
        className: 'dstu-svg',
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: 'none',
        role: 'img',
        'aria-label': '每日 Token 趋势图',
      }, [
        ...gridLines.map((line, index) => h('line', {
          key: `grid-${index}`,
          x1: padLeft,
          x2: width - padRight,
          y1: line.y,
          y2: line.y,
          className: 'dstu-gridLine',
        })),
        ...gridLines.map((line, index) => h('text', {
          key: `grid-label-${index}`,
          x: padLeft - 10,
          y: line.y + 4,
          textAnchor: 'end',
          className: 'dstu-axisLabel',
        }, fmtTokens(line.value))),
        ...series.map((item) => {
          const points = item.values.map((value, index) => [x(index), y(value)])
          return h('g', { key: item.id }, [
            h('path', {
              key: 'line',
              d: smoothPath(points),
              fill: 'none',
              stroke: item.color,
              strokeWidth: 2.2,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }),
            hover === null ? null : h('circle', {
              key: 'dot',
              cx: x(hover),
              cy: y(item.values[hover] ?? 0),
              r: 3.6,
              fill: item.color,
              stroke: 'var(--dsw-alias-bg-layer-1, #fff)',
              strokeWidth: 1.5,
            }),
          ])
        }),
        hover === null ? null : h('line', {
          key: 'guide',
          x1: x(hover),
          x2: x(hover),
          y1: padTop,
          y2: padTop + innerHeight,
          className: 'dstu-guideLine',
        }),
        ...labelIndexes.map((index) => h('text', {
          key: `x-${index}`,
          x: x(index),
          y: height - 10,
          textAnchor: index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle',
          className: 'dstu-axisLabel',
        }, days[index] === undefined ? '' : fmtDayLabel(days[index].d))),
        ...days.map((day, index) => {
          const left = index === 0 ? padLeft : (x(index - 1) + x(index)) / 2
          const right = index === days.length - 1 ? width - padRight : (x(index) + x(index + 1)) / 2
          return h('rect', {
            key: `hit-${day.d}`,
            x: left,
            y: padTop,
            width: Math.max(1, right - left),
            height: innerHeight,
            fill: 'transparent',
            onMouseEnter: () => setHover(index),
          })
        }),
      ])

      return h('div', { className: 'dstu-card' }, [
        h('div', { key: 'head', className: 'dstu-cardHead' }, [
          h('span', { key: 'title', className: 'dstu-cardTitle' }, '每日 Token 趋势图'),
        ]),
        h('div', { key: 'legend', className: 'dstu-legend' }, series.map((item) => h('span', {
          key: item.id,
          className: 'dstu-legendItem',
        }, [
          h('span', { key: 'dot', className: 'dstu-legendDot', style: { background: item.color } }),
          item.name,
        ]))),
        h('div', {
          key: 'chart',
          className: 'dstu-chartWrap',
          ref: wrapRef,
          onMouseLeave: () => setHover(null),
        }, [svg, tooltip]),
      ])
    }

    /** The per-model share donut and its legend. */
    function ModelShare(props) {
      const models = props.models ?? []
      const total = props.total ?? 0
      const size = 240
      const radius = 86
      const stroke = 26
      const center = size / 2
      const circumference = 2 * Math.PI * radius
      let offset = 0
      const arcs = []
      models.forEach((model, index) => {
        const share = total > 0 ? model.tokens / total : 0
        if (share <= 0) return
        const length = share * circumference
        arcs.push(h('circle', {
          key: model.key ?? model.id,
          cx: center,
          cy: center,
          r: radius,
          fill: 'none',
          stroke: PALETTE[index % PALETTE.length],
          strokeWidth: stroke,
          strokeDasharray: `${Math.max(0.5, length - 1.5)} ${circumference}`,
          strokeDashoffset: -offset * circumference,
          transform: `rotate(-90 ${center} ${center})`,
          strokeLinecap: 'butt',
        }))
        offset += share
      })
      const donut = h('svg', {
        className: 'dstu-donut',
        viewBox: `0 0 ${size} ${size}`,
        role: 'img',
        'aria-label': '模型用量占比',
      }, [
        h('circle', {
          key: 'track',
          cx: center,
          cy: center,
          r: radius,
          fill: 'none',
          stroke: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.18))',
          strokeWidth: stroke,
        }),
        ...arcs,
        h('text', {
          key: 'value',
          x: center,
          y: center - 2,
          textAnchor: 'middle',
          className: 'dstu-donutValue',
        }, fmtTokens(total)),
        h('text', {
          key: 'unit',
          x: center,
          y: center + 22,
          textAnchor: 'middle',
          className: 'dstu-donutUnit',
        }, 'tokens'),
      ])

      const legend = h('div', { className: 'dstu-donutLegend' }, models.length === 0
        ? [h('div', { key: 'empty', className: 'dstu-muted' }, '这段时间还没有模型用量')]
        : models.map((model, index) => h('div', { key: model.key ?? model.id, className: 'dstu-modelRow' }, [
          h('span', {
            key: 'dot',
            className: 'dstu-modelDot',
            style: { background: PALETTE[index % PALETTE.length] },
          }),
          h('div', { key: 'name', className: 'dstu-modelMeta' }, [
            h('div', { key: 'title', className: 'dstu-modelName', title: model.label ?? model.name }, model.label ?? model.name),
            h('div', { key: 'tokens', className: 'dstu-modelTokens' }, `${fmtTokens(model.tokens)} tokens`),
          ]),
          h('span', { key: 'share', className: 'dstu-modelShare' }, fmtShare(model.share)),
        ])))

      return h('div', { className: 'dstu-card' }, [
        h('div', { key: 'head', className: 'dstu-cardHead' }, [
          h('span', { key: 'title', className: 'dstu-cardTitle' }, '模型用量'),
        ]),
        h('div', { key: 'body', className: 'dstu-donutCard' }, [donut, legend]),
      ])
    }

    //#endregion

    //#region page

    /** One whole-history stat card. */
    function StatCard(props) {
      return h('div', { className: 'dstu-card dstu-stat', title: props.title ?? undefined }, [
        h('span', { key: 'value', className: 'dstu-statValue' }, props.value),
        h('span', { key: 'label', className: 'dstu-statLabel' }, props.label),
      ])
    }

    /** Refresh glyph. */
    function RefreshGlyph(props) {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        className: props?.className,
      }, [
        h('path', {
          key: 'arc',
          d: 'M13.2 6.2A5.4 5.4 0 1 0 13.4 9.8',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 'arrow',
          d: 'M13.4 3.2v3.2h-3.2',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ])
    }

    /** The full dashboard page. */
    function Dashboard() {
      const [range, setRange] = React.useState(30)
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [updatedAt, setUpdatedAt] = React.useState(0)

      const load = React.useCallback(async (nextRange, force) => {
        setBusy(true)
        setError('')
        try {
          const response = await fetch(
            OVERVIEW_ROUTE + '?range=' + String(nextRange) + (force ? '&refresh=1' : ''),
            { cache: 'no-store', headers: { accept: 'application/json' } },
          )
          if (!response.ok) throw new Error('HTTP ' + String(response.status))
          const payload = await response.json()
          if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
            throw new Error(payload !== null && typeof payload === 'object' && typeof payload.error === 'string'
              ? payload.error
              : '统计失败')
          }
          setData(payload)
          setUpdatedAt(Date.now())
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => {
        void load(range, false)
      }, [range, load])

      if (data === null) {
        // First paint has no data yet: the fetch is started by the effect below,
        // so an empty error is "still loading", never "failed".
        return h('div', { className: 'dstu-root' }, [
          h('div', { key: 'state', className: 'dstu-card dstu-center' }, error === ''
            ? [h('span', { key: 'spin', className: 'dstu-spinner' }), '正在读取会话用量…']
            : [
              '读取用量失败：' + error,
              h('button', {
                key: 'retry',
                type: 'button',
                className: 'dstu-refresh',
                onClick: () => void load(range, true),
              }, '重试'),
            ]),
        ])
      }

      const totals = data.totals ?? {}
      const names = {}
      for (const model of data.models ?? []) names[model.key ?? model.id] = model.label ?? model.name

      const statCards = [
        { key: 'total', label: '累计 Token 数', value: fmtTokens(totals.tokens), title: '全部会话累计' },
        {
          key: 'peak',
          label: '峰值 Token 数',
          value: fmtTokens(totals.peakDayTokens),
          title: totals.peakDay === null || totals.peakDay === undefined ? '单日最高' : `单日最高 · ${fmtDayLabel(totals.peakDay)}`,
        },
        { key: 'chat', label: '最长聊天时长', value: fmtDuration(totals.longestChatMs), title: '一次连续对话的最长时长' },
        { key: 'current', label: '当前连续天数', value: String(totals.currentStreak ?? 0) + '天' },
        { key: 'longest', label: '最长连续天数', value: String(totals.longestStreak ?? 0) + '天' },
      ]

      const rangeTabs = [
        { id: 7, label: '近 7 日' },
        { id: 30, label: '近 30 日' },
      ]

      const empty = (totals.tokens ?? 0) === 0

      return h('div', { className: 'dstu-root' }, [
        h('div', { key: 'stats', className: 'dstu-stats' }, statCards.map((card) => h(StatCard, {
          key: card.key,
          label: card.label,
          value: card.value,
          title: card.title,
        }))),

        h(Heatmap, { key: 'heatmap', days: data.heatmap?.days ?? [] }),

        h('div', { key: 'range', className: 'dstu-rangeRow' }, [
          h('span', { key: 'label', className: 'dstu-rangeLabel' }, '时间范围'),
          h('div', { key: 'tabs', className: 'dstu-seg' }, rangeTabs.map((tab) => h('button', {
            key: tab.id,
            type: 'button',
            className: 'dstu-segBtn',
            'data-active': range === tab.id ? '1' : '0',
            onClick: () => setRange(tab.id),
          }, tab.label))),
        ]),

        h(TrendChart, {
          key: 'trend',
          days: data.trend?.days ?? [],
          models: data.trend?.models ?? [],
          names,
        }),

        h(ModelShare, { key: 'models', models: data.models ?? [], total: data.rangeTokens ?? 0 }),

        empty
          ? h('div', { key: 'empty', className: 'dstu-muted' }, '还没有记录到 token 用量 —— 完成一次模型对话后刷新即可看到。')
          : null,

        h('div', { key: 'refresh', className: 'dstu-refreshRow' }, [
          h('span', { key: 'meta', className: 'dstu-muted' }, updatedAt > 0
            ? `更新于 ${new Date(updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
            : ''),
          h('button', {
            key: 'button',
            type: 'button',
            className: 'dstu-refresh',
            disabled: busy,
            onClick: () => void load(range, true),
          }, [h(RefreshGlyph, { key: 'icon' }), busy ? '刷新中…' : '刷新']),
        ]),
      ])
    }

    //#endregion

    //#region panel wiring

    /** The left-sidebar entry glyph. */
    function PanelGlyph(props) {
      const size = props?.size ?? 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      }, [
        h('path', {
          key: 'bar-1',
          d: 'M3 13V9.5',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 'bar-2',
          d: 'M8 13V5.5',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 'bar-3',
          d: 'M13 13V3',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      ])
    }

    /**
     * Inject the page stylesheet, or replace the text of the one an earlier
     * activation installed. HMR re-runs `apply` against the same document, so a
     * plain "already installed" early return would keep stale rules forever.
     */
    function ensureStyle() {
      const attr = 'dsh-token-usage-style'
      const existing = document.querySelector('style[' + attr + ']')
      const tag = existing !== null ? existing : document.createElement('style')
      tag.setAttribute(attr, '')
      tag.textContent = [
        '.dstu-root{display:flex;flex-direction:column;gap:16px;height:100%;overflow-y:auto;box-sizing:border-box;padding:22px 26px 36px;color:var(--dsw-alias-label-primary,#111)}',
        '.dstu-root *{box-sizing:border-box}',
        '.dstu-card{background:var(--dsw-alias-bg-layer-1,#1f1f22);border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.08));border-radius:16px;padding:20px}',
        '.dstu-stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}',
        '.dstu-stat{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:22px 14px;text-align:center}',
        '.dstu-statValue{font-size:28px;font-weight:650;line-height:1.15;letter-spacing:.2px}',
        '.dstu-statLabel{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
        '.dstu-cardHead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}',
        '.dstu-cardTitle{font-size:14px;font-weight:600}',
        '.dstu-tabs{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.14))}',
        '.dstu-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);font:inherit;font-size:12px;line-height:20px;padding:2px 12px;border-radius:8px;cursor:pointer}',
        '.dstu-tab[data-active="1"]{background:var(--dsw-alias-bg-layer-1,#2a2a2e);color:var(--dsw-alias-label-primary,#fff);box-shadow:0 1px 3px rgba(0,0,0,.28)}',
        '.dstu-heatWrap{position:relative}',
        '.dstu-heat{display:flex;flex-direction:column;gap:6px;overflow-x:auto;padding-bottom:2px}',
        '.dstu-heatGrid{display:grid;gap:3px}',
        '.dstu-heatCell{display:block;width:11px;height:11px;border-radius:3px;background:rgba(124,135,155,.22);transition:background .12s}',
        '.dstu-heatCell[data-hover="1"]{box-shadow:inset 0 0 0 2px var(--dsw-alias-state-business-primary,#4d6bfe)}',
        '.dstu-heatTip{position:absolute;z-index:7;pointer-events:none;display:inline-flex;align-items:baseline;gap:8px;padding:6px 10px;border-radius:8px;background:rgba(24,24,27,.95);color:#fff;font-size:11px;line-height:1.4;white-space:nowrap;box-shadow:0 8px 20px rgba(0,0,0,.35)}',
        '.dstu-heatTipDate{color:rgba(255,255,255,.62)}',
        '.dstu-heatTipValue{font-variant-numeric:tabular-nums}',
        '.dstu-heatCell[data-level="1"]{background:rgba(77,107,254,.28)}',
        '.dstu-heatCell[data-level="2"]{background:rgba(77,107,254,.48)}',
        '.dstu-heatCell[data-level="3"]{background:rgba(77,107,254,.72)}',
        '.dstu-heatCell[data-level="4"]{background:rgba(77,107,254,1)}',
        '.dstu-heatMonths{display:grid;height:16px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap;overflow:visible}',
        '.dstu-rangeRow{display:flex;align-items:center;justify-content:space-between;margin-top:6px}',
        '.dstu-rangeLabel{font-size:13px;font-weight:600}',
        '.dstu-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.14))}',
        '.dstu-segBtn{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);font:inherit;font-size:12px;line-height:20px;padding:2px 14px;border-radius:8px;cursor:pointer}',
        '.dstu-segBtn[data-active="1"]{background:var(--dsw-alias-bg-layer-1,#2a2a2e);color:var(--dsw-alias-label-primary,#fff);box-shadow:0 1px 3px rgba(0,0,0,.28)}',
        '.dstu-legend{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa0a6)}',
        '.dstu-legendItem{display:inline-flex;align-items:center;gap:6px}',
        '.dstu-legendDot{display:inline-block;flex:none;width:8px;height:8px;border-radius:50%}',
        '.dstu-chartWrap{position:relative;width:100%}',
        '.dstu-svg{display:block;width:100%;height:auto;overflow:visible}',
        '.dstu-gridLine{stroke:var(--dsw-alias-border-l4,rgba(128,128,128,.22));stroke-width:1;stroke-dasharray:3 4}',
        '.dstu-guideLine{stroke:var(--dsw-alias-border-l2,rgba(128,128,128,.4));stroke-width:1}',
        '.dstu-axisLabel{fill:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px}',
        '.dstu-tooltip{position:absolute;z-index:6;pointer-events:none;min-width:200px;padding:10px 12px;border-radius:10px;background:rgba(24,24,27,.95);border:1px solid rgba(255,255,255,.08);color:#fff;font-size:12px;line-height:1.6;box-shadow:0 12px 30px rgba(0,0,0,.45)}',
        '.dstu-tooltipDate{font-size:11px;color:rgba(255,255,255,.62);margin-bottom:4px}',
        '.dstu-tooltipRow{display:flex;align-items:center;gap:6px}',
        '.dstu-tooltipName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dstu-tooltipValue{flex:none;white-space:nowrap}',
        '.dstu-tooltipTotal{margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.72);font-size:11px}',
        '.dstu-donutCard{display:grid;grid-template-columns:280px minmax(0,1fr);gap:28px;align-items:center}',
        '.dstu-donut{display:block;width:100%;max-width:280px;height:auto}',
        '.dstu-donutValue{fill:var(--dsw-alias-label-primary,#fff);font-size:30px;font-weight:650}',
        '.dstu-donutUnit{fill:var(--dsw-alias-label-tertiary,#8a8f98);font-size:13px}',
        '.dstu-donutLegend{display:flex;flex-direction:column;gap:14px;min-width:0}',
        '.dstu-modelRow{display:flex;align-items:center;gap:10px;min-width:0}',
        '.dstu-modelDot{flex:none;width:10px;height:10px;border-radius:50%}',
        '.dstu-modelMeta{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
        '.dstu-modelName{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dstu-modelTokens{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
        '.dstu-modelShare{flex:none;width:62px;text-align:right;font-size:13px;color:var(--dsw-alias-label-secondary,#9aa0a6);font-variant-numeric:tabular-nums}',
        '.dstu-refreshRow{display:flex;align-items:center;justify-content:flex-end;gap:12px}',
        '.dstu-refresh{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l4,rgba(255,255,255,.16));background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);border-radius:10px;padding:7px 14px;font:inherit;font-size:12px;cursor:pointer}',
        '.dstu-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}',
        '.dstu-refresh:disabled{opacity:.55;cursor:default}',
        '.dstu-muted{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
        '.dstu-center{display:flex;align-items:center;justify-content:center;gap:10px;min-height:140px;font-size:13px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
        '@keyframes dstu-spin{to{transform:rotate(360deg)}}',
        '.dstu-spinner{width:14px;height:14px;border-radius:50%;border:2px solid rgba(77,107,254,.25);border-top-color:#4d6bfe;animation:dstu-spin .8s linear infinite}',
        '@media (max-width:1100px){.dstu-stats{grid-template-columns:repeat(3,minmax(0,1fr))}.dstu-donutCard{grid-template-columns:240px minmax(0,1fr)}}',
        '@media (max-width:720px){.dstu-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.dstu-donutCard{grid-template-columns:1fr}}',
      ].join('\n')
      if (existing === null) document.head.appendChild(tag)
    }

    /**
     * Register the sidebar entry and its main-panel view.
     * @param {object} ctx - client plugin context.
     */
    function apply(ctx) {
      ensureStyle()
      // Tell the host that a browser half mounted, and again once its slot
      // registrations are in. The two stage suffixes share the version field so
      // the host needs no extra route parameter, and a load can be verified
      // without looking at the screen. The local storage marker leaves the same
      // evidence on disk, for when the page is not connected to the event stream.
      const report = (stage) => {
        void fetch(HELLO_ROUTE + '?ver=' + encodeURIComponent(VERSION + '-' + stage), { cache: 'no-store' }).catch(() => undefined)
      }
      report('start')
      try {
        globalThis.localStorage?.setItem('dsh-token-usage:apply', String(Date.now()) + ':' + VERSION)
      } catch (error) {
        // Storage can be unavailable in a privacy-restricted renderer.
      }
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-token-usage: copy')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 10,
        label: () => t('panel.label'),
      }, PanelGlyph)), 'dsh-token-usage: panel entry')
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, Dashboard)), 'dsh-token-usage: dashboard view')
      // Reaches the host only when both registrations above returned normally.
      report('ready')
    }

    const inject = ['slots', 'locale']

    exports.apply = apply
    exports.inject = inject

    // Test surface for the repository's smoke tests; the shell never calls it.
    exports.__test = {
      VERSION,
      fmtTokens,
      fmtShare,
      fmtDuration,
      buildHeatmap,
      smoothPath,
      Heatmap,
      TrendChart,
      ModelShare,
      Dashboard,
    }

    return module.exports
  },
})
