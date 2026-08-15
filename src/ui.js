/**
 * dsh-meter — browser half.
 *
 * One line under the composer, in the seat the harness reserves for ambient
 * conversation readouts, plus a detail card on hover or focus. The line
 * answers the three questions a time-of-use rate card creates: what has this
 * session cost, which tariff am I standing in, and when does it change.
 *
 * Money arrives finished from the `costMeter` session projection — this half
 * owns no price table and no fold. What it owns is the clock: the tariff
 * schedule is wall-clock state, invisible to a log-derived projection, so the
 * countdown and the day strip are computed here from the shared core.
 *
 * `scripts/build-client.mjs` inlines lib/core.js above this file and wraps
 * both in the module-loader factory; nothing here imports.
 */

/** Dictionary namespace owned by this plugin. */
const NS = 'costMeter'

const en = {
  'meter.flat': 'flat rate',
  'meter.peak': 'peak',
  'meter.offpeak': 'off-peak',
  'meter.switchIn': '{tariff} in {countdown}',
  'meter.timeOfUseIn': 'time-of-use in {countdown}',
  'meter.noRate': '{count} requests · no published rate',
  'meter.title': 'Session cost',
  'meter.requests': '{count} requests',
  'meter.requestOne': '1 request',
  'meter.tariffNow': 'Tariff · local',
  'meter.until': '{tariff} until {time}',
  'meter.cacheHits': 'cache hits',
  'meter.freshInput': 'fresh input',
  'meter.output': 'output',
  'meter.cacheSaved': 'Cache reuse saved {amount} — {percent}% of prompt tokens were hits.',
  'meter.cacheCold': 'No cache hits yet. A stable prompt prefix bills at {rate} of the miss rate.',
  'meter.ifPeak': 'Same tokens all-peak {peak}, all-off-peak {offpeak}.',
  'meter.ifNewRates': 'Under the rates starting {date}: {offpeak} off-peak, {peak} peak.',
  'meter.unpriced': '{count} requests on {models} have no published rate and are not counted.',
  'meter.source': 'Estimated from reported tokens at DeepSeek list prices. The invoice is authoritative.',
}

const zh = {
  'meter.flat': '统一价',
  'meter.peak': '高峰',
  'meter.offpeak': '空闲',
  'meter.switchIn': '{countdown}后转{tariff}',
  'meter.timeOfUseIn': '{countdown}后启用峰谷价',
  'meter.noRate': '{count} 次请求 · 无公开价格',
  'meter.title': '本会话花费',
  'meter.requests': '{count} 次请求',
  'meter.requestOne': '1 次请求',
  'meter.tariffNow': '时段价 · 本地时间',
  'meter.until': '{tariff}，{time} 结束',
  'meter.cacheHits': '缓存命中',
  'meter.freshInput': '未命中输入',
  'meter.output': '输出',
  'meter.cacheSaved': '缓存复用省下 {amount}——{percent}% 的输入命中缓存。',
  'meter.cacheCold': '尚无缓存命中。前缀稳定时命中价仅为未命中价的 {rate}。',
  'meter.ifPeak': '同样的 token 全高峰 {peak}，全空闲 {offpeak}。',
  'meter.ifNewRates': '{date} 起的新价：空闲 {offpeak}，高峰 {peak}。',
  'meter.unpriced': '{count} 次请求使用 {models}，无公开价格，未计入。',
  'meter.source': '按 DeepSeek 官方价目与上报 token 估算，实际以账单为准。',
}

const CSS = `
.dshMeterRoot{display:block;max-width:var(--dsh-chat-content-width);width:100%;margin:0 auto;box-sizing:border-box;
  padding:0 calc(var(--dsh-composer-side-clearance) + 16px) 2px;text-align:center;font-size:12px;line-height:20px;
  color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshMeterLine{display:inline-flex;align-items:center;gap:0;border-radius:6px;padding:0 6px;margin:0 -6px;
  cursor:default;outline:none;max-width:100%}
.dshMeterLine:hover,.dshMeterLine:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.dshMeterLine:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}
.dshMeterCost{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dshMeterSep{color:var(--dsw-alias-separator-primary);margin:0 10px}
.dshMeterPeak{color:var(--dsw-alias-state-warn-primary)}
.dshMeterOffpeak{color:var(--dsw-alias-state-success-primary)}
.dshMeterFlat{color:var(--dsw-alias-label-tertiary)}

/* Panel material is the harness's own popover recipe (ContextMeter.module.css):
   a plugin surface should belong to the product, not announce itself. */
.dshMeterCard{position:fixed;z-index:100;width:328px;box-sizing:border-box;padding:14px 14px 12px;
  border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu);
  box-shadow:var(--dsw-shadow-lv3);text-align:left;white-space:normal;
  max-height:calc(100vh - 96px);overflow-y:auto;
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:default}
.dshMeterHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.dshMeterHeadLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.dshMeterTotal{color:var(--dsw-alias-label-primary);font-size:20px;line-height:26px;font-weight:600;
  font-variant-numeric:tabular-nums}
.dshMeterSub{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;margin-top:2px}
.dshMeterRule{height:1px;background:var(--dsw-alias-border-l1);margin:12px -14px}

.dshMeterStripHead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}
.dshMeterStripNow{font-variant-numeric:tabular-nums}
/* Off-peak reads as quiet neutral and peak as the warm signal: the strip is
   there to show when the meter runs double, not to paint every hour. */
.dshMeterStrip{position:relative;display:flex;gap:2px;height:10px}
.dshMeterCell{flex:1;border-radius:2px;background:var(--dsw-alias-border-l3)}
.dshMeterCell[data-peak="1"]{background:var(--dsw-alias-state-warn-primary);opacity:.75}
.dshMeterNow{position:absolute;top:-3px;bottom:-3px;width:2px;border-radius:1px;
  background:var(--dsw-alias-label-primary);transform:translateX(-1px)}
.dshMeterTicks{position:relative;height:14px;margin-top:3px;color:var(--dsw-alias-label-caption);
  font-size:10px;line-height:14px;font-variant-numeric:tabular-nums}
.dshMeterTick{position:absolute;top:0;transform:translateX(-50%)}

.dshMeterRow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:2px 0}
.dshMeterRowLabel{color:var(--dsw-alias-label-tertiary)}
.dshMeterRowTokens{color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;
  margin-left:auto;padding-right:10px}
.dshMeterRowCost{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dshMeterModels{margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1)}
.dshMeterNote{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;margin-top:6px}
.dshMeterNote:first-of-type{margin-top:10px}
.dshMeterFoot{color:var(--dsw-alias-label-caption);font-size:10px;line-height:15px;margin-top:10px;
  padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}
@media (prefers-reduced-motion:no-preference){.dshMeterCard{animation:dshMeterIn 120ms ease-out}}
@keyframes dshMeterIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
`

/** Inject the plugin stylesheet once, the way built harness bundles do. */
function installStyles() {
  if (typeof document === 'undefined') return
  const tagId = 'dsh-meter/meter.css'
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-meter'
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** Fill `{name}` placeholders; the fallback path when no locale service is installed. */
function fill(template, params) {
  let text = template
  for (const key of Object.keys(params ?? {})) text = text.split(`{${key}}`).join(String(params[key]))
  return text
}

/** Translate through the framework seat, falling back to this plugin's own English copy. */
function translator(t) {
  return (key, params) => {
    if (typeof t === 'function') {
      const translated = t(key, params)
      // A missing key echoes back as the key itself in the harness dictionaries.
      if (typeof translated === 'string' && translated !== key) return translated
    }
    return fill(en[key] ?? key, params)
  }
}

/** Model ids read as product names in a one-line summary: deepseek-v4-pro -> V4-Pro. */
function shortModel(model) {
  return model.replace(/^deepseek-/, '').replace(/(^|-)([a-z])/g, (_all, dash, letter) => dash + letter.toUpperCase())
}

/**
 * The 24 local-hour cells of the tariff day, each labelled from the UTC hour at
 * its midpoint so a half-hour timezone still lands in the right window.
 */
function localTariffCells(now) {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const schedule = tariffSchedule()
  const cells = []
  for (let hour = 0; hour < 24; hour++) {
    const middle = new Date(midnight.getTime() + (hour + 0.5) * 3_600_000)
    cells.push(schedule[middle.getUTCHours()])
  }
  return { midnight: midnight.getTime(), cells }
}

/**
 * Local-clock label for an instant. A change that is not today carries its date:
 * before the switchover the next change is more than a day out, and a bare
 * `09:00` would read as this morning.
 */
function clockLabel(epochMs, now) {
  const date = new Date(epochMs)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const sameDay = new Date(now).toDateString() === date.toDateString()
  return sameDay ? time : `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

/**
 * The rect the card is anchored above: the whole composer stack, not this one
 * line. The dock sits under the composer card, so a card opening upward from
 * the line itself would land on top of the input the user is about to type in.
 * The stack is the outermost ancestor that still ends where this line ends.
 */
function anchorRect(element) {
  // The scrollport and the app frame also end at the viewport bottom, so the
  // walk stops at the first ancestor taller than a composer strip could be
  // rather than latching onto the whole page.
  const STACK_HEIGHT_LIMIT = 400
  let rect = element.getBoundingClientRect()
  let node = element.parentElement
  for (let depth = 0; depth < 6 && node !== null; depth++) {
    const candidate = node.getBoundingClientRect()
    if (candidate.height > STACK_HEIGHT_LIMIT) break
    if (candidate.height > 0 && Math.abs(candidate.bottom - rect.bottom) <= 16) rect = candidate
    node = node.parentElement
  }
  return rect
}

/** The tariff day strip: 24 local hours coloured by window, with a live now marker. */
function TariffStrip({ now }) {
  const { midnight, cells } = localTariffCells(now)
  const dayFraction = Math.min(1, Math.max(0, (now - midnight) / 86_400_000))
  return React.createElement(
    'div',
    null,
    React.createElement(
      'div',
      { className: 'dshMeterStrip' },
      cells.map((tariff, hour) =>
        React.createElement('div', {
          key: hour,
          className: 'dshMeterCell',
          'data-peak': tariff === 'peak' ? '1' : '0',
        })),
      React.createElement('div', {
        className: 'dshMeterNow',
        style: { left: `${dayFraction * 100}%` },
      }),
    ),
    React.createElement(
      'div',
      { className: 'dshMeterTicks' },
      [0, 6, 12, 18, 24].map(hour =>
        React.createElement('span', {
          key: hour,
          className: 'dshMeterTick',
          style: {
            left: `${(hour / 24) * 100}%`,
            transform: hour === 0 ? 'none' : hour === 24 ? 'translateX(-100%)' : 'translateX(-50%)',
          },
        }, hour === 24 ? '24' : String(hour).padStart(2, '0'))),
    ),
  )
}

/** One breakdown row: what was billed, how many tokens, and what it cost. */
function BreakdownRow({ label, tokens, cost, currency }) {
  return React.createElement(
    'div',
    { className: 'dshMeterRow' },
    React.createElement('span', { className: 'dshMeterRowLabel' }, label),
    React.createElement('span', { className: 'dshMeterRowTokens' }, `${formatTokens(tokens)} tok`),
    React.createElement('span', { className: 'dshMeterRowCost' }, formatMoney(cost, currency)),
  )
}

/** The hover card: the total, the tariff clock, where the money went, and what it could have been. */
function MeterCard({ value, now, t, position }) {
  const currency = value.currency
  const clock = nextTariffChange(now)
  const tariffName = t(`meter.${clock.tariff === 'flat' ? 'flat' : clock.tariff}`)
  const promptTokens = value.tokens.hit + value.tokens.miss
  const hitShare = promptTokens === 0 ? 0 : Math.round((value.tokens.hit / promptTokens) * 100)
  const saved = value.counterfactual.noCache - value.cost
  const models = value.models.map(entry => shortModel(entry.model)).join(', ')

  const notes = []
  if (value.tokens.hit > 0) {
    notes.push(t('meter.cacheSaved', { amount: formatMoney(saved, currency), percent: hitShare }))
  } else if (promptTokens > 0) {
    notes.push(t('meter.cacheCold', { rate: '1/50' }))
  }
  if (clock.tariff === 'flat') {
    notes.push(t('meter.ifNewRates', {
      date: new Date(TIME_OF_USE_FROM).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      offpeak: formatMoney(value.counterfactual.offpeak, currency),
      peak: formatMoney(value.counterfactual.peak, currency),
    }))
  } else {
    notes.push(t('meter.ifPeak', {
      peak: formatMoney(value.counterfactual.peak, currency),
      offpeak: formatMoney(value.counterfactual.offpeak, currency),
    }))
  }
  if (value.unpricedRequests > 0) {
    notes.push(t('meter.unpriced', {
      count: value.unpricedRequests,
      models: value.models.filter(entry => !entry.priced).map(entry => entry.model).join(', '),
    }))
  }

  return React.createElement(
    'div',
    { className: 'dshMeterCard', style: position, role: 'tooltip' },
    React.createElement(
      'div',
      { className: 'dshMeterHead' },
      React.createElement('span', { className: 'dshMeterHeadLabel' }, t('meter.title')),
      React.createElement('span', { className: 'dshMeterTotal' }, formatMoney(value.cost, currency)),
    ),
    React.createElement('div', { className: 'dshMeterSub' },
      `${value.requests === 1 ? t('meter.requestOne') : t('meter.requests', { count: value.requests })}`
      + `${models === '' ? '' : ` · ${models}`}`),
    React.createElement('div', { className: 'dshMeterRule' }),
    React.createElement(
      'div',
      { className: 'dshMeterStripHead' },
      React.createElement('span', { className: 'dshMeterHeadLabel' }, t('meter.tariffNow')),
      React.createElement(
        'span',
        { className: `dshMeterStripNow dshMeter${clock.tariff === 'flat' ? 'Flat' : clock.tariff === 'peak' ? 'Peak' : 'Offpeak'}` },
        t('meter.until', { tariff: tariffName, time: clockLabel(clock.at, now) }),
      ),
    ),
    React.createElement(TariffStrip, { now }),
    React.createElement('div', { className: 'dshMeterRule' }),
    React.createElement(BreakdownRow, {
      label: t('meter.cacheHits'), tokens: value.tokens.hit, cost: value.byBucket.hit, currency,
    }),
    React.createElement(BreakdownRow, {
      label: t('meter.freshInput'), tokens: value.tokens.miss, cost: value.byBucket.miss, currency,
    }),
    React.createElement(BreakdownRow, {
      label: t('meter.output'), tokens: value.tokens.out, cost: value.byBucket.out, currency,
    }),
    // Per-model rows only earn their space once the session actually used more
    // than one model; the header already names a single one.
    value.models.length < 2
      ? null
      : React.createElement(
        'div',
        { className: 'dshMeterModels' },
        value.models.map(entry => React.createElement(BreakdownRow, {
          key: entry.model,
          label: shortModel(entry.model),
          tokens: entry.miss + entry.hit + entry.out,
          cost: entry.cost,
          currency,
        })),
      ),
    notes.map((note, index) => React.createElement('div', { key: index, className: 'dshMeterNote' }, note)),
    React.createElement('div', { className: 'dshMeterFoot' }, t('meter.source')),
  )
}

/**
 * The composer-dock readout: cost, the tariff standing over it, and the
 * countdown to the next change.
 */
function CostMeterLine({ useProjection, t: translate }) {
  const value = useProjection('costMeter')
  const t = translator(translate)
  const [now, setNow] = React.useState(() => Date.now())
  const [card, setCard] = React.useState(null)
  const anchor = React.useRef(null)
  const closeTimer = React.useRef(null)

  // The countdown is the reason this surface exists, so it ticks while mounted.
  // Half-minute cadence keeps a minute-resolution readout honest without
  // rendering on a timer the eye can see.
  React.useEffect(() => {
    const id = setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { clearInterval(id) }
  }, [])

  const place = React.useCallback(() => {
    const element = anchor.current
    if (element === null) return
    const rect = anchorRect(element)
    const width = 328
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8)
    setCard({ left, bottom: Math.max(8, window.innerHeight - rect.top + 8) })
  }, [])

  React.useEffect(() => {
    if (card === null) return
    const reposition = () => { place() }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [card === null, place])

  React.useEffect(() => () => { if (closeTimer.current !== null) clearTimeout(closeTimer.current) }, [])

  const open = () => {
    if (closeTimer.current !== null) { clearTimeout(closeTimer.current) ; closeTimer.current = null }
    setNow(Date.now())
    place()
  }
  // A grace delay lets the pointer cross the gap between line and card.
  const close = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => { setCard(null) ; closeTimer.current = null }, 120)
  }

  if (value === undefined || value.requests === 0) return null

  const clock = nextTariffChange(now)
  const tariffClass = clock.tariff === 'peak' ? 'dshMeterPeak' : clock.tariff === 'offpeak' ? 'dshMeterOffpeak' : 'dshMeterFlat'
  const countdown = formatCountdown(clock.at - now)
  const trailing = clock.tariff === 'flat'
    ? t('meter.timeOfUseIn', { countdown })
    : t('meter.switchIn', { tariff: t(`meter.${clock.next}`), countdown })
  const separator = () => React.createElement('span', { className: 'dshMeterSep', 'aria-hidden': 'true' }, '|')

  return React.createElement(
    'div',
    { className: 'dshMeterRoot' },
    React.createElement(
      'span',
      {
        className: 'dshMeterLine',
        ref: anchor,
        tabIndex: 0,
        onMouseEnter: open,
        onMouseLeave: close,
        onFocus: open,
        onBlur: close,
      },
      value.unpricedRequests === value.requests
        ? React.createElement('span', { className: 'dshMeterCost' }, t('meter.noRate', { count: value.requests }))
        : React.createElement('span', { className: 'dshMeterCost' }, formatMoney(value.cost, value.currency)),
      separator(),
      React.createElement('span', { className: tariffClass }, t(`meter.${clock.tariff === 'flat' ? 'flat' : clock.tariff}`)),
      separator(),
      React.createElement('span', null, trailing),
      // The card is a React child of this span but a DOM child of body, so
      // React's enter/leave traversal already counts it as inside: one pair of
      // handlers covers the line and the card, and the pointer can cross the
      // gap between them without closing.
      card === null
        ? null
        : ReactDOM.createPortal(React.createElement(MeterCard, { value, now, t, position: card }), document.body),
    ),
  )
}

/** Slot and locale services this surface needs. */
const inject = ['slots']

/**
 * Client plugin body: one entry in the composer dock, ordered after the
 * harness stats line rather than replacing it.
 * @param {object} ctx - client root context.
 */
function apply(ctx) {
  installStyles()
  const locale = ctx.get('locale')
  if (locale !== undefined) ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-meter: dictionaries')
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'cost-meter', order: 10, locale: NS },
    CostMeterLine,
  ))
}
