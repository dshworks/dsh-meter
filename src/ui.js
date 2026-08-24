/**
 * dsh-meter — browser half.
 *
 * One line under the composer, in the seat the harness reserves for ambient
 * conversation readouts, plus a detail card on hover or focus. The line answers
 * the three questions a time-of-use rate card creates: what has this session
 * cost, which tariff am I standing in, and when does it change.
 *
 * Money arrives finished from the `costMeter` session projection, priced
 * against both published rate cards — this half owns no price table and no
 * fold. What it owns is everything a log-derived projection cannot see: the
 * wall clock (the countdown and the tariff strip) and the account (`GET
 * /dsh-meter/balance`, whose `currency` decides which rate card to show).
 *
 * Design language, so the surfaces stay one instrument: numerals are the
 * subject and always set in the theme's mono face, tabular, with the currency
 * symbol dimmed; labels are chrome, 10px uppercase with wide tracking; sections
 * are divided by hairlines, never nested boxes; and colour carries exactly two
 * meanings — amber for peak, brand blue for the one moving part.
 *
 * `scripts/build-client.mjs` inlines lib/core.js above this file and wraps both
 * in the module-loader factory; nothing here imports.
 */

/** Dictionary namespace owned by this plugin. */
const NS = 'costMeter'

/** Host route serving the account snapshot; the key never reaches the browser. */
const BALANCE_ROUTE = '/dsh-meter/balance'

/** How stale a balance snapshot may be before a card opening refetches it. */
const BALANCE_STALE_MS = 300_000

const en = {
  'meter.flat': 'flat rate',
  'meter.peak': 'peak',
  'meter.offpeak': 'off-peak',
  'meter.switchIn': '{tariff} in {countdown}',
  'meter.timeOfUseIn': 'time-of-use in {countdown}',
  'meter.noRate': '{count} requests · no published rate',
  'meter.session': 'session',
  'meter.requests': '{count} requests',
  'meter.requestOne': '1 request',
  'meter.tariff': 'tariff',
  'meter.until': '{tariff} until {time}',
  'meter.cacheHits': 'cache hits',
  'meter.freshInput': 'fresh input',
  'meter.output': 'output',
  'meter.balance': 'balance',
  'meter.balanceParts': 'granted {granted} · topped up {toppedUp}',
  'meter.balanceEmpty': 'this account cannot spend right now',
  'meter.balanceRejected': 'balance: the API key was rejected',
  'meter.cacheSaved': 'Cache reuse saved {amount} — {percent}% of prompt tokens were hits.',
  'meter.cacheCold': 'No cache hits yet. A stable prompt prefix bills at 1/{factor} of the miss rate.',
  'meter.ifPeak': 'Same tokens all-peak {peak}, all-off-peak {offpeak}.',
  'meter.ifNewRates': 'Under the rates starting {date}: {offpeak} off-peak, {peak} peak.',
  'meter.unpriced': '{count} requests on {models} have no published rate and are not counted.',
  'meter.source': 'Estimated from reported tokens at DeepSeek list prices. The invoice is authoritative.',

  // The settings section: the same instrument, readable before a session exists.
  'meter.nav': 'Meter',
  'meter.now': 'now',
  'meter.localZone': 'your time · {zone}',
  'meter.week': 'this week',
  'meter.peakHours': '{count} peak hours a week',
  'meter.weekendNote': 'Weekends bill off-peak all day, on the Beijing clock — so the weekend turns over at 16:00 UTC, not at your midnight.',
  'meter.rateCard': 'rate card',
  'meter.perMillion': 'per 1M tokens · {currency}',
  'meter.colHit': 'cache hit',
  'meter.colMiss': 'cache miss',
  'meter.colOut': 'output',
  'meter.cacheRatio': 'A cache hit costs 1/{factor} of a miss, so a stable prompt prefix is worth more than the tariff.',
  'meter.balanceUnavailable': 'The balance route is off, or this account has no published balance.',
  'meter.untilClock': 'until {time}',
  'meter.noSession': 'Session cost appears under the composer once a session bills its first request.',
  // Hour-slot hover. In English these are the plain tariff words; the Chinese
  // dictionary spends them on the pun the vendor's own name makes available.
  'meter.slotPeak': 'peak',
  'meter.slotOffpeak': 'off-peak',
  'meter.slotFlat': 'flat rate',
  'meter.slotHour': '{hour} · {tariff}',
  'meter.slotDayHour': '{day} {hour} · {tariff}',
  'meter.mon': 'Mon',
  'meter.tue': 'Tue',
  'meter.wed': 'Wed',
  'meter.thu': 'Thu',
  'meter.fri': 'Fri',
  'meter.sat': 'Sat',
  'meter.sun': 'Sun',
}

const zh = {
  'meter.flat': '统一价',
  'meter.peak': '高峰',
  'meter.offpeak': '空闲',
  'meter.switchIn': '{countdown}后转{tariff}',
  'meter.timeOfUseIn': '{countdown}后启用峰谷价',
  'meter.noRate': '{count} 次请求 · 无公开价格',
  'meter.session': '本会话',
  'meter.requests': '{count} 次请求',
  'meter.requestOne': '1 次请求',
  'meter.tariff': '时段价',
  'meter.until': '{tariff}，{time} 结束',
  'meter.cacheHits': '缓存命中',
  'meter.freshInput': '未命中输入',
  'meter.output': '输出',
  'meter.balance': '余额',
  'meter.balanceParts': '赠送 {granted} · 充值 {toppedUp}',
  'meter.balanceEmpty': '该账号当前无法扣费',
  'meter.balanceRejected': '余额：API key 被拒绝',
  'meter.cacheSaved': '缓存复用省下 {amount}——{percent}% 的输入命中缓存。',
  'meter.cacheCold': '尚无缓存命中。前缀稳定时命中价仅为未命中价的 1/{factor}。',
  'meter.ifPeak': '同样的 token 全高峰 {peak}，全空闲 {offpeak}。',
  'meter.ifNewRates': '{date} 起的新价：空闲 {offpeak}，高峰 {peak}。',
  'meter.unpriced': '{count} 次请求使用 {models}，无公开价格，未计入。',
  'meter.source': '按 DeepSeek 官方价目与上报 token 估算，实际以账单为准。',

  'meter.nav': '峰谷价',
  'meter.now': '当前',
  'meter.localZone': '本地时间 · {zone}',
  'meter.week': '本周',
  'meter.peakHours': '每周 {count} 小时高峰',
  'meter.weekendNote': '周末全天按空闲价计费，按北京时间算——所以周末在 UTC 16:00 换挡，不是你的午夜。',
  'meter.rateCard': '价目表',
  'meter.perMillion': '每 100 万 token · {currency}',
  'meter.colHit': '缓存命中',
  'meter.colMiss': '未命中',
  'meter.colOut': '输出',
  'meter.cacheRatio': '命中价仅为未命中价的 1/{factor}，前缀稳定比挑时段更值钱。',
  'meter.balanceUnavailable': '余额接口已关闭，或该账号没有公开余额。',
  'meter.untilClock': '{time} 结束',
  'meter.noSession': '会话花费在输入框下方显示，需要该会话产生第一次计费请求。',
  // 彩蛋：峰谷是电力时段价的老词，而「文峰」正好是 DeepSeek 创始人梁文锋的谐音。
  'meter.slotPeak': '文峰',
  'meter.slotOffpeak': '文谷',
  'meter.slotFlat': '统一价',
  'meter.slotHour': '{hour} · {tariff}',
  'meter.slotDayHour': '{day} {hour} · {tariff}',
  'meter.mon': '周一',
  'meter.tue': '周二',
  'meter.wed': '周三',
  'meter.thu': '周四',
  'meter.fri': '周五',
  'meter.sat': '周六',
  'meter.sun': '周日',
}

const CSS = `
.dshMeterRoot{display:block;max-width:var(--dsh-chat-content-width);width:100%;margin:0 auto;box-sizing:border-box;
  padding:0 calc(var(--dsh-composer-side-clearance) + 16px) 2px;text-align:center;font-size:12px;line-height:20px;
  color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshMeterLine{display:inline-flex;align-items:center;border-radius:6px;padding:0 7px;margin:0 -7px;
  cursor:default;outline:none;max-width:100%;transition:background-color 120ms ease-out}
.dshMeterLine:hover,.dshMeterLine:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.dshMeterLine:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}
.dshMeterNum{font-family:var(--ds-font-family-code);font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-secondary);letter-spacing:-.01em}
.dshMeterSym{opacity:.55}
.dshMeterSep{color:var(--dsw-alias-separator-primary);margin:0 10px}
.dshMeterPeak{color:var(--dsw-alias-state-warn-primary)}
.dshMeterOffpeak{color:var(--dsw-alias-label-secondary)}
.dshMeterFlat{color:var(--dsw-alias-label-tertiary)}

.dshMeterCard{position:fixed;z-index:100;width:336px;box-sizing:border-box;padding:13px 14px 11px;
  border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu);
  box-shadow:var(--dsw-shadow-lv3);text-align:left;white-space:normal;
  max-height:calc(100vh - 96px);overflow-y:auto;
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:default}
.dshMeterKey{display:block;font-size:10px;line-height:14px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--dsw-alias-label-caption)}
.dshMeterHead{display:flex;align-items:flex-end;justify-content:space-between;gap:12px}
.dshMeterTotal{font-family:var(--ds-font-family-code);font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary);font-size:21px;line-height:24px;font-weight:600;letter-spacing:-.02em}
.dshMeterSub{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;margin-top:3px}
.dshMeterRule{height:1px;background:var(--dsw-alias-border-l1);margin:11px -14px}

.dshMeterStripHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px}
.dshMeterStripNow{font-size:11px;line-height:14px}
.dshMeterStrip{position:relative;display:flex;gap:2px;height:8px}
.dshMeterCell{flex:1;border-radius:1px;background:var(--dsw-alias-border-l3)}
.dshMeterCell[data-peak="1"]{background:var(--dsw-alias-state-warn-primary);opacity:.8}
.dshMeterNow{position:absolute;top:-4px;bottom:-4px;width:2px;border-radius:1px;
  background:var(--dsw-alias-state-business-primary);transform:translateX(-1px)}
.dshMeterTicks{position:relative;height:13px;margin-top:4px;color:var(--dsw-alias-label-caption);
  font-family:var(--ds-font-family-code);font-size:9px;line-height:13px;font-variant-numeric:tabular-nums}
.dshMeterTick{position:absolute;top:0}

.dshMeterRow{display:flex;align-items:baseline;gap:10px;padding:2px 0}
.dshMeterRowKey{font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}
.dshMeterRowTok{font-family:var(--ds-font-family-code);font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:auto}
.dshMeterRowCost{font-family:var(--ds-font-family-code);font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-secondary);min-width:74px;text-align:right}
.dshMeterModels{margin-top:5px;padding-top:5px;border-top:1px dashed var(--dsw-alias-border-l1)}
.dshMeterBalance{display:flex;align-items:flex-end;justify-content:space-between;gap:10px}
.dshMeterBalanceNum{font-family:var(--ds-font-family-code);font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary);font-size:14px;line-height:18px}
.dshMeterNote{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;margin-top:6px}
.dshMeterNote:first-of-type{margin-top:9px}
.dshMeterWarn{color:var(--dsw-alias-state-warn-label)}
.dshMeterFoot{color:var(--dsw-alias-label-caption);font-size:10px;line-height:15px;margin-top:9px;
  padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}
@media (prefers-reduced-motion:no-preference){
  .dshMeterCard{animation:dshMeterIn 110ms ease-out}
}
@keyframes dshMeterIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}

/* The settings section. Same instrument, more room: the strip becomes a week,
   the rate card becomes readable, and nothing is boxed — hairlines only, so the
   panel sits inside the shell's own rhythm instead of stacking a card in it. */
.dshMeterPanel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshMeterPanelRule{height:1px;background:var(--dsw-alias-border-l1);margin:20px 0}
.dshMeterSectionHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:9px}
.dshMeterSectionHead .dshMeterSub{margin-top:0}
.dshMeterNowTariff{font-size:23px;line-height:28px;font-weight:600;letter-spacing:-.02em}
.dshMeterNowClock{font-family:var(--ds-font-family-code);font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary);font-size:12px}

.dshMeterGrid{display:flex;flex-direction:column;gap:3px}
.dshMeterGridRow{display:flex;align-items:center;gap:9px}
.dshMeterGridDay{flex:none;width:30px;font-size:10px;line-height:14px;letter-spacing:.04em;
  color:var(--dsw-alias-label-caption);text-align:right}
.dshMeterGridRow[data-today="1"] .dshMeterGridDay{color:var(--dsw-alias-label-secondary)}
.dshMeterGridCells{position:relative;display:flex;gap:2px;height:9px;flex:1}
.dshMeterGridRow[data-today="1"] .dshMeterCell{opacity:1}
.dshMeterGridRow[data-today="0"] .dshMeterCell{opacity:.62}
.dshMeterGridAxis{margin-top:1px}
.dshMeterGridAxis .dshMeterTicks{flex:1;margin-top:0}

.dshMeterTable{display:flex;flex-direction:column}
.dshMeterTableRow{display:grid;grid-template-columns:1fr 62px repeat(3,minmax(0,72px));
  align-items:baseline;gap:8px;padding:3px 0}
.dshMeterTableRow>span:nth-child(n+3){text-align:right}
.dshMeterTableRow .dshMeterNum{text-align:right}
.dshMeterTableRow[data-first="1"]{border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px}
.dshMeterTableRow[data-first="1"]:first-of-type{border-top:0}
.dshMeterTableHead{font-size:10px;line-height:14px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--dsw-alias-label-caption);padding-bottom:4px}
.dshMeterTableModel{color:var(--dsw-alias-label-primary)}
.dshMeterFootQuiet{color:var(--dsw-alias-label-caption);font-size:10px;line-height:15px;margin-top:5px}
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

/**
 * Which published rate card to show, in descending order of authority:
 * the operator's configuration, then the currency DeepSeek denominates the
 * account in, then the interface language as a last resort.
 * @param {string} preferred - the projection's configured preference.
 * @param {object} [balance] - the account snapshot, when one has arrived.
 * @returns {string} `usd` or `cny`.
 */
function pickCurrency(preferred, balance) {
  if (preferred === 'usd' || preferred === 'cny') return preferred
  if (balance?.currency === 'usd' || balance?.currency === 'cny') return balance.currency
  const language = typeof navigator === 'undefined' ? '' : (navigator.language ?? '')
  return language.toLowerCase().startsWith('zh') ? 'cny' : 'usd'
}

/** Module-scope snapshot: one account, shared by every mounted meter. */
let balanceCache
/** In-flight read, so a burst of sessions or hovers costs one request. */
let balancePending

/**
 * Read the account snapshot, refetching only past the staleness window.
 * @param {boolean} force - refetch a stale snapshot (a card opening does).
 * @returns {Promise<object | undefined>} the snapshot, or undefined when the route is absent.
 */
function loadBalance(force) {
  const age = balanceCache === undefined ? Number.POSITIVE_INFINITY : Date.now() - balanceCache.at
  if (age < BALANCE_STALE_MS) return Promise.resolve(balanceCache.value)
  // Stale but present: only a card opening pays for a refresh; a mount settles
  // for what is already known.
  if (balanceCache !== undefined && !force) return Promise.resolve(balanceCache.value)
  balancePending ??= fetch(BALANCE_ROUTE, { headers: { accept: 'application/json' } })
    .then(response => (response.ok ? response.json() : undefined))
    .catch(() => undefined)
    .then((value) => {
      balanceCache = { value, at: Date.now() }
      balancePending = undefined
      return value
    })
  return balancePending
}

/** The account snapshot, read once per mount and refreshed when the card opens. */
function useBalance(cardOpen) {
  const [balance, setBalance] = React.useState(() => balanceCache?.value)
  React.useEffect(() => {
    let live = true
    void loadBalance(cardOpen).then((value) => { if (live) setBalance(value) })
    return () => { live = false }
  }, [cardOpen])
  return balance
}

/** Model ids read as product names in a one-line summary: deepseek-v4-pro -> V4-Pro. */
function shortModel(model) {
  return model.replace(/^deepseek-/, '').replace(/(^|-)([a-z])/g, (_all, dash, letter) => dash + letter.toUpperCase())
}

/**
 * A money figure with its symbol dimmed, so the digits carry the line.
 * `format` chooses the convention: a padded total by default, a published rate
 * where the number is a quotation rather than a sum.
 */
function Money({ amount, currency, className, format }) {
  const text = (format ?? formatMoney)(amount, currency)
  const symbol = CURRENCY_SYMBOL[currency] ?? ''
  const cut = text.indexOf(symbol)
  return React.createElement(
    'span',
    { className: `dshMeterNum${className === undefined ? '' : ` ${className}`}` },
    cut < 0
      ? text
      : [
        text.slice(0, cut),
        React.createElement('span', { key: 'sym', className: 'dshMeterSym' }, symbol),
        text.slice(cut + symbol.length),
      ],
  )
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

/** `09:00` for an hour index, the label both slot readouts share. */
const hourLabel = hour => `${String(hour).padStart(2, '0')}:00`

/**
 * What one hour cell says when the pointer rests on it. The tariff word comes
 * from the dictionary rather than the tariff name, so a locale is free to spend
 * it on something of its own.
 */
function slotTitle(t, tariff, hour, day) {
  const params = { hour: hourLabel(hour), tariff: t(`meter.slot${tariff === 'peak' ? 'Peak' : tariff === 'flat' ? 'Flat' : 'Offpeak'}`) }
  return day === undefined ? t('meter.slotHour', params) : t('meter.slotDayHour', { ...params, day })
}

/** The tariff day as an instrument face: 24 local hours, peak in amber, a live now-caret. */
function TariffStrip({ now, t }) {
  const midnight = localMidnight(now)
  const [cells] = localTariffDays(midnight, 1)
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
          title: slotTitle(t, tariff, hour),
        })),
      React.createElement('div', { className: 'dshMeterNow', style: { left: `${dayFraction * 100}%` } }),
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
        }, String(hour).padStart(2, '0'))),
    ),
  )
}

/** One breakdown row: what was billed, how many tokens, and what it cost. */
function BreakdownRow({ label, tokens, cost, currency, plain }) {
  return React.createElement(
    'div',
    { className: 'dshMeterRow' },
    React.createElement('span', { className: plain === true ? undefined : 'dshMeterRowKey' }, label),
    React.createElement('span', { className: 'dshMeterRowTok' }, `${formatTokens(tokens)} tok`),
    React.createElement(Money, { amount: cost, currency, className: 'dshMeterRowCost' }),
  )
}

/** The account row: what is left, and how much of it expires. */
function BalanceBlock({ balance, currency, t, bare }) {
  if (balance === undefined || balance.error !== undefined) {
    if (balance?.error !== 'unauthorized') return null
    return React.createElement('div', { className: 'dshMeterNote dshMeterWarn' }, t('meter.balanceRejected'))
  }
  if (typeof balance.total !== 'number') return null
  const shown = balance.currency ?? currency
  return React.createElement(
    'div',
    null,
    // The card stacks this under the breakdown and needs its own divider; the
    // settings panel already ruled the section off.
    bare === true ? null : React.createElement('div', { className: 'dshMeterRule' }),
    React.createElement(
      'div',
      { className: 'dshMeterBalance' },
      React.createElement('span', { className: 'dshMeterKey' }, t('meter.balance')),
      React.createElement(Money, {
        amount: balance.total,
        currency: shown,
        className: 'dshMeterBalanceNum',
      }),
    ),
    balance.total === 0 || balance.available === false
      ? React.createElement('div', { className: 'dshMeterSub dshMeterWarn' }, t('meter.balanceEmpty'))
      : typeof balance.granted === 'number' && balance.granted > 0
        ? React.createElement('div', { className: 'dshMeterSub' }, t('meter.balanceParts', {
          granted: formatMoney(balance.granted, shown),
          toppedUp: formatMoney(balance.toppedUp ?? 0, shown),
        }))
        : null,
  )
}

/** The hover card: the total, the tariff clock, where the money went, the account, and what it could have been. */
function MeterCard({ value, balance, currency, now, t, position }) {
  const priced = value.money[currency]
  const clock = nextTariffChange(now)
  const tariffName = t(`meter.${clock.tariff === 'flat' ? 'flat' : clock.tariff}`)
  const promptTokens = value.tokens.hit + value.tokens.miss
  const hitShare = promptTokens === 0 ? 0 : Math.round((value.tokens.hit / promptTokens) * 100)
  const saved = priced.counterfactual.noCache - priced.cost
  const models = value.models.map(entry => shortModel(entry.model)).join(', ')

  const notes = []
  if (value.tokens.hit > 0) {
    notes.push(t('meter.cacheSaved', { amount: formatMoney(saved, currency), percent: hitShare }))
  } else if (promptTokens > 0) {
    notes.push(t('meter.cacheCold', { factor: CACHE_DISCOUNT }))
  }
  if (clock.tariff === 'flat') {
    notes.push(t('meter.ifNewRates', {
      date: new Date(TIME_OF_USE_FROM).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      offpeak: formatMoney(priced.counterfactual.offpeak, currency),
      peak: formatMoney(priced.counterfactual.peak, currency),
    }))
  } else {
    notes.push(t('meter.ifPeak', {
      peak: formatMoney(priced.counterfactual.peak, currency),
      offpeak: formatMoney(priced.counterfactual.offpeak, currency),
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
      React.createElement('span', { className: 'dshMeterKey' }, t('meter.session')),
      React.createElement(Money, { amount: priced.cost, currency, className: 'dshMeterTotal' }),
    ),
    React.createElement('div', { className: 'dshMeterSub' },
      `${value.requests === 1 ? t('meter.requestOne') : t('meter.requests', { count: value.requests })}`
      + `${models === '' ? '' : ` · ${models}`}`),
    React.createElement('div', { className: 'dshMeterRule' }),
    React.createElement(
      'div',
      { className: 'dshMeterStripHead' },
      React.createElement('span', { className: 'dshMeterKey' }, t('meter.tariff')),
      React.createElement(
        'span',
        {
          className: `dshMeterStripNow dshMeter${clock.tariff === 'flat' ? 'Flat' : clock.tariff === 'peak' ? 'Peak' : 'Offpeak'}`,
        },
        t('meter.until', { tariff: tariffName, time: clockLabel(clock.at, now) }),
      ),
    ),
    React.createElement(TariffStrip, { now, t }),
    React.createElement('div', { className: 'dshMeterRule' }),
    React.createElement(BreakdownRow, {
      label: t('meter.cacheHits'), tokens: value.tokens.hit, cost: priced.byBucket.hit, currency,
    }),
    React.createElement(BreakdownRow, {
      label: t('meter.freshInput'), tokens: value.tokens.miss, cost: priced.byBucket.miss, currency,
    }),
    React.createElement(BreakdownRow, {
      label: t('meter.output'), tokens: value.tokens.out, cost: priced.byBucket.out, currency,
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
          plain: true,
          label: shortModel(entry.model),
          tokens: entry.miss + entry.hit + entry.out,
          cost: priced.modelCost[entry.model] ?? 0,
          currency,
        })),
      ),
    React.createElement(BalanceBlock, { balance, currency, t }),
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
  const balance = useBalance(card !== null)

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
    const width = 336
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
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setNow(Date.now())
    place()
  }
  // A grace delay lets the pointer cross the gap between line and card.
  const close = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      setCard(null)
      closeTimer.current = null
    }, 120)
  }

  if (value === undefined || value.requests === 0) return null

  const currency = pickCurrency(value.preferred, balance)
  const clock = nextTariffChange(now)
  const tariffClass = clock.tariff === 'peak' ? 'dshMeterPeak' : clock.tariff === 'offpeak' ? 'dshMeterOffpeak' : 'dshMeterFlat'
  const countdown = formatCountdown(clock.at - now)
  const trailing = clock.tariff === 'flat'
    ? t('meter.timeOfUseIn', { countdown })
    : t('meter.switchIn', { tariff: t(`meter.${clock.next}`), countdown })
  const separator = key => React.createElement('span', { key, className: 'dshMeterSep', 'aria-hidden': 'true' }, '|')

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
        ? React.createElement('span', { className: 'dshMeterNum' }, t('meter.noRate', { count: value.requests }))
        : React.createElement(Money, { amount: value.money[currency].cost, currency }),
      separator('s1'),
      React.createElement('span', { className: tariffClass }, t(`meter.${clock.tariff === 'flat' ? 'flat' : clock.tariff}`)),
      separator('s2'),
      React.createElement('span', null, trailing),
      // The card is a React child of this span but a DOM child of body, so
      // React's enter/leave traversal already counts it as inside: one pair of
      // handlers covers the line and the card, and the pointer can cross the
      // gap between them without closing.
      card === null
        ? null
        : ReactDOM.createPortal(
          React.createElement(MeterCard, { value, balance, currency, now, t, position: card }),
          document.body,
        ),
    ),
  )
}

/* ------------------------------------------------------------------ *
 * The settings section.
 *
 * The dock line is honest but conditional: it needs a session, and a session
 * that has already billed something. That makes the one question this plugin
 * exists to answer — what does an hour cost, and when is it cheap — unaskable
 * until after you have spent money on it. This surface answers it cold.
 *
 * It is deliberately not a form. Two config knobs exist and both live in the
 * plugin's own configuration, where the harness already edits plugin config;
 * inventing a second write path for them would be the settings-page reflex
 * rather than the content. What is here is the instrument: the tariff standing
 * now, the shape of the week, the published card, the account.
 * ------------------------------------------------------------------ */

/** Weekday dictionary keys in display order, Monday first. */
const WEEKDAY_KEYS = ['meter.mon', 'meter.tue', 'meter.wed', 'meter.thu', 'meter.fri', 'meter.sat', 'meter.sun']


/** The reader's UTC offset, written the way a clock face would carry it. */
function zoneLabel(epochMs) {
  const minutes = -new Date(epochMs).getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  const whole = Math.abs(minutes)
  const rest = whole % 60
  return `UTC${sign}${Math.floor(whole / 60)}${rest === 0 ? '' : `:${String(rest).padStart(2, '0')}`}`
}

/**
 * The week as a shape: seven local days by twenty-four hours, peak in amber.
 *
 * The card's strip answers "when does today change"; this answers "when is the
 * cheap time", which is a weekly question now that weekends bill off-peak all
 * day. Laid out in the reader's own days rather than the vendor's, because a
 * grid whose rows are Beijing days asks a reader in California to do the
 * arithmetic the strip exists to spare them — the tariff of each cell still
 * comes from `tariffAt`, so the two clocks cannot disagree.
 */
function WeekGrid({ now, t }) {
  const start = localWeekStart(now)
  const rows = localTariffDays(start, 7)
  const today = Math.floor((localMidnight(now) - start) / 86_400_000)
  const dayFraction = (now - localMidnight(now)) / 86_400_000
  const peakHours = rows.flat().filter(tariff => tariff === 'peak').length

  return React.createElement(
    'div',
    null,
    React.createElement(
      'div',
      { className: 'dshMeterSectionHead' },
      React.createElement('span', { className: 'dshMeterKey' }, t('meter.week')),
      React.createElement('span', { className: 'dshMeterSub' }, t('meter.peakHours', { count: peakHours })),
    ),
    React.createElement(
      'div',
      { className: 'dshMeterGrid' },
      rows.map((cells, day) =>
        React.createElement(
          'div',
          { key: day, className: 'dshMeterGridRow', 'data-today': day === today ? '1' : '0' },
          React.createElement('span', { className: 'dshMeterGridDay' }, t(WEEKDAY_KEYS[day])),
          React.createElement(
            'div',
            { className: 'dshMeterGridCells' },
            cells.map((tariff, hour) =>
              React.createElement('div', {
                key: hour,
                className: 'dshMeterCell',
                'data-peak': tariff === 'peak' ? '1' : '0',
                title: slotTitle(t, tariff, hour, t(WEEKDAY_KEYS[day])),
              })),
            day === today
              ? React.createElement('div', { className: 'dshMeterNow', style: { left: `${dayFraction * 100}%` } })
              : null,
          ),
        )),
      React.createElement(
        'div',
        { className: 'dshMeterGridRow dshMeterGridAxis' },
        React.createElement('span', { className: 'dshMeterGridDay' }),
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
            }, String(hour).padStart(2, '0'))),
        ),
      ),
    ),
    React.createElement('div', { className: 'dshMeterNote' }, t('meter.weekendNote')),
  )
}

/**
 * The published card in the currency this account is billed in. Two live
 * tariffs per model; `flat` is retired and stays out, so no row here is a price
 * anyone can still pay.
 */
function RateTable({ currency, t }) {
  const models = Object.keys(RATES)
  return React.createElement(
    'div',
    null,
    React.createElement(
      'div',
      { className: 'dshMeterSectionHead' },
      React.createElement('span', { className: 'dshMeterKey' }, t('meter.rateCard')),
      React.createElement('span', { className: 'dshMeterSub' }, t('meter.perMillion', { currency: currency.toUpperCase() })),
    ),
    React.createElement(
      'div',
      { className: 'dshMeterTable' },
      React.createElement(
        'div',
        { className: 'dshMeterTableRow dshMeterTableHead' },
        React.createElement('span', null),
        React.createElement('span', null),
        React.createElement('span', null, t('meter.colHit')),
        React.createElement('span', null, t('meter.colMiss')),
        React.createElement('span', null, t('meter.colOut')),
      ),
      models.flatMap(model =>
        ['offpeak', 'peak'].map((tariff, index) =>
          React.createElement(
            'div',
            { key: `${model}-${tariff}`, className: 'dshMeterTableRow', 'data-first': index === 0 ? '1' : '0' },
            React.createElement('span', { className: 'dshMeterTableModel' }, index === 0 ? shortModel(model) : ''),
            React.createElement(
              'span',
              { className: tariff === 'peak' ? 'dshMeterPeak' : 'dshMeterOffpeak' },
              t(`meter.${tariff}`),
            ),
            ...['hit', 'miss', 'out'].map(bucket =>
              React.createElement(Money, {
                key: bucket,
                amount: RATES[model][tariff][currency][bucket],
                currency,
                format: formatRate,
              })),
          ))),
    ),
    React.createElement('div', { className: 'dshMeterNote' }, t('meter.cacheRatio', { factor: CACHE_DISCOUNT })),
  )
}

/**
 * The section body. Every reading here is a pure function of the clock and the
 * published card, except the balance — which uses the same pull-driven reader
 * the card does, so opening settings costs at most one upstream request.
 */
function MeterSettingsSection({ t: translate }) {
  const t = translator(translate)
  const [now, setNow] = React.useState(() => Date.now())
  const balance = useBalance(true)

  // Open on the panel, the countdown is the moving part; the same half-minute
  // cadence the dock line ticks at.
  React.useEffect(() => {
    const id = setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { clearInterval(id) }
  }, [])

  const currency = pickCurrency('auto', balance)
  const clock = nextTariffChange(now)
  const tariffClass = clock.tariff === 'peak' ? 'dshMeterPeak' : clock.tariff === 'offpeak' ? 'dshMeterOffpeak' : 'dshMeterFlat'
  const countdown = formatCountdown(clock.at - now)

  return React.createElement(
    'div',
    { className: 'dshMeterPanel' },
    React.createElement(
      'div',
      { className: 'dshMeterSectionHead' },
      React.createElement('span', { className: 'dshMeterKey' }, t('meter.now')),
      React.createElement('span', { className: 'dshMeterSub' }, t('meter.localZone', { zone: zoneLabel(now) })),
    ),
    React.createElement(
      'div',
      { className: 'dshMeterHead' },
      React.createElement('span', { className: `dshMeterNowTariff ${tariffClass}` }, t(`meter.${clock.tariff}`)),
      React.createElement(
        'span',
        { className: 'dshMeterNowClock' },
        clock.tariff === 'flat'
          ? t('meter.timeOfUseIn', { countdown })
          : t('meter.switchIn', { tariff: t(`meter.${clock.next}`), countdown }),
      ),
    ),
    // The head already names the tariff and the countdown gives the relative
    // answer; this line owes the reader only the absolute one.
    React.createElement('div', { className: 'dshMeterSub' }, t('meter.untilClock', { time: clockLabel(clock.at, now) })),

    React.createElement('div', { className: 'dshMeterPanelRule' }),
    React.createElement(WeekGrid, { now, t }),

    React.createElement('div', { className: 'dshMeterPanelRule' }),
    React.createElement(RateTable, { currency, t }),

    React.createElement('div', { className: 'dshMeterPanelRule' }),
    // `BalanceBlock` renders nothing for an account the route cannot read, and
    // a heading over an empty space reads as a fault in the panel rather than
    // an answer about the account — so the panel says which it is.
    balance !== undefined && balance.error === undefined && typeof balance.total === 'number'
      ? React.createElement(BalanceBlock, { balance, currency, t, bare: true })
      : React.createElement(
        'div',
        null,
        React.createElement('span', { className: 'dshMeterKey' }, t('meter.balance')),
        balance?.error === 'unauthorized'
          ? React.createElement('div', { className: 'dshMeterNote dshMeterWarn' }, t('meter.balanceRejected'))
          : React.createElement('div', { className: 'dshMeterNote' }, t('meter.balanceUnavailable')),
      ),

    React.createElement('div', { className: 'dshMeterFoot' }, t('meter.noSession')),
    React.createElement('div', { className: 'dshMeterFootQuiet' }, t('meter.source')),
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
  // The nav label is resolved by the settings shell outside any component, so
  // it cannot read the `t` prop and binds the namespace directly. Re-read on
  // every call rather than captured: the shell re-resolves labels when the
  // locale revision changes, and a captured string would keep the old language.
  const navLabel = translator(locale === undefined ? undefined : locale.bind(NS))
  // Separately injected: a composition can carry the dock without the settings
  // shell, or the reverse, and neither absence should cost the other surface.
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'meter', order: 20, label: () => navLabel('meter.nav'), locale: NS },
    MeterSettingsSection,
  ))
}
