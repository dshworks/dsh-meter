/**
 * The account side of the meter: DeepSeek's `GET /user/balance`, read on the
 * host and served to the Web UI without the key ever leaving this process.
 *
 * Two facts come back from one request. The obvious one is how much is left.
 * The load-bearing one is `currency`: an account is billed against exactly one
 * of DeepSeek's two published rate cards, and this is the only authoritative
 * signal of which — better than a config field the user has to know to set, and
 * far better than guessing from the UI language.
 *
 * A live account lists BOTH currencies, only one of them funded, so the funded
 * row is the answer and a wholly unfunded account has no answer to give.
 *
 * Nothing here polls. The reader is pulled by the surface — the card asks when
 * a human opens it — and a TTL keeps a burst of hovers down to one request.
 */

/** Errors the surface renders differently; anything else is `unreachable`. */
const ERRORS = {
  NO_KEY: 'no-key',
  UNAUTHORIZED: 'unauthorized',
  UNSUPPORTED: 'unsupported',
  UNREACHABLE: 'unreachable',
}

/**
 * Pick the row that describes this account's billing.
 *
 * A funded row wins. With nothing funded the currency is genuinely unknown, so
 * the first row is reported with a zero balance rather than inventing a side.
 * @param {object[]} rows - `balance_infos` from the API.
 * @returns {object | undefined} the chosen row, or undefined when the list is empty.
 */
export function chooseBalanceRow(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return undefined
  const amount = row => Number.parseFloat(String(row?.total_balance ?? '').trim())
  const funded = rows.filter(row => Number.isFinite(amount(row)) && amount(row) > 0)
  return funded.length > 0 ? funded[0] : rows[0]
}

/**
 * Normalize one API response into the wire value the Web UI reads. Amounts
 * arrive as strings and are parsed once here; an unparseable amount is dropped
 * rather than printed as `NaN`.
 * @param {object} payload - the decoded `GET /user/balance` body.
 * @returns {object} the snapshot fields, without `checkedAt`.
 */
export function readBalance(payload) {
  const row = chooseBalanceRow(payload?.balance_infos)
  if (row === undefined) return { error: ERRORS.UNSUPPORTED }
  const number = (text) => {
    const parsed = Number.parseFloat(String(text ?? '').trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const currency = typeof row.currency === 'string' ? row.currency.toLowerCase() : undefined
  return {
    ...currency === undefined ? {} : { currency },
    ...number(row.total_balance) === undefined ? {} : { total: number(row.total_balance) },
    ...number(row.granted_balance) === undefined ? {} : { granted: number(row.granted_balance) },
    ...number(row.topped_up_balance) === undefined ? {} : { toppedUp: number(row.topped_up_balance) },
    available: payload?.is_available === true,
  }
}

/**
 * A pull-driven, TTL-cached balance reader.
 * @param {object} options - `resolveKey`, `baseUrl`, `ttlMs`, `timeoutMs`, and an injectable `fetchImpl`.
 * @returns {{ read: (now?: number) => Promise<object> }} the reader; `read` never rejects.
 */
export function createBalanceReader({ resolveKey, baseUrl, ttlMs, timeoutMs, fetchImpl = fetch }) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/user/balance`
  /** @type {object | undefined} last settled snapshot, error snapshots included. */
  let cached
  /** @type {Promise<object> | undefined} in-flight request, so a burst of hovers costs one call. */
  let pending

  const fetchOnce = async (now) => {
    const key = await resolveKey()
    if (key === undefined || key === '') return { error: ERRORS.NO_KEY, checkedAt: now }
    const abort = new AbortController()
    const timer = setTimeout(() => { abort.abort() }, timeoutMs)
    try {
      const response = await fetchImpl(endpoint, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: abort.signal,
      })
      if (response.status === 401 || response.status === 403) return { error: ERRORS.UNAUTHORIZED, checkedAt: now }
      if (!response.ok) return { error: ERRORS.UNSUPPORTED, checkedAt: now }
      // A relay that does not implement this endpoint answers 200 with HTML;
      // that is `unsupported`, not a broken account.
      const payload = await response.json().catch(() => undefined)
      if (payload === undefined) return { error: ERRORS.UNSUPPORTED, checkedAt: now }
      return { ...readBalance(payload), checkedAt: now }
    } catch {
      return { error: ERRORS.UNREACHABLE, checkedAt: now }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    /**
     * Current snapshot, refetching only past the TTL.
     * @param {number} [now] - clock injection point for tests.
     * @returns {Promise<object>} the snapshot; failures are snapshots too.
     */
    async read(now = Date.now()) {
      if (cached !== undefined && now - cached.checkedAt < ttlMs) return cached
      pending ??= fetchOnce(now).then((snapshot) => {
        cached = snapshot
        pending = undefined
        return snapshot
      })
      return await pending
    },
  }
}

export { ERRORS as BALANCE_ERRORS }
