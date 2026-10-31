// cache-watch: karanb192/cache-tax 2.3.1 (MIT) with a hold card. A cold send
// is held above the prompt with its price and three buttons, instead of being
// dropped with the price as text. Everything else is upstream's.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, RenderElement } from 'claude-code'
import type { Held, Receipt, ResumeNote, Snapshot } from '../types'
import { statusIcons } from './status-icons'

const TTL_1H_MS = 60 * 60 * 1000
const TTL_5M_MS = 5 * 60 * 1000
const PING_AFTER_MS = 55 * 60 * 1000
const MIN_PING_MS = 60 * 1000
const MAX_RETRIES = 3
const AUTO_WARM_MS = 3 * 60 * 60 * 1000
const RESUME_TIP = "A cold cache means the AI has to re-read everything in the session all over again. If the juice isn't worth the squeeze, consider starting a fresh chat."
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
const BIG_TOKENS = 50000
const PING_PROMPT = 'Reply with the single word: warm'
const KEY_DEADLINE = 'deadline'
const KEY_EVERY = 'every'
const KEY_GUARD = 'guard'
const KEY_ALWAYS = 'always'
const KEY_FOOTER = 'footer'
/** The relay's prompts reach the session as this plugin's, from a phone that shows no card. */
const RELAY_PLUGIN = 'cc-relay'
const KEY_QUEUED = 'queued'

const LONG_PROMPT_TOKENS = 100000

// $ per million tokens, [cache read, 1h cache write, output], list prices October 2026.
// More specific families first: a model id takes the first row it matches.
const PRICES: Array<[string | RegExp, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['mythos-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['mythos-5', 1, 20, 50],
  ['opus-5-5', 0.2, 8, 20],
  ['opus-5', 0.5, 10, 25],
  // Opus 4 and 4.1 in every spelling (claude-opus-4-1-20250805, claude-opus-4@20250514, the -0 and -1 aliases), never Opus 4.5 and later.
  [/opus-4(?:-[01])?(?:$|[^-\d]|-20\d{6})/, 1.5, 30, 75],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5-5', 0.1, 4, 10],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku-5-5', 0.01, 0.2, 0.5],
  ['3-5-haiku', 0.08, 1.6, 4],
  ['haiku-3-5', 0.08, 1.6, 4],
  ['haiku', 0.1, 2, 5],
]

// A request whose prompt, cache reads and writes included, is over 100k tokens pays these instead.
const LONG_PRICES: Array<[string, number, number, number]> = [
  ['haiku-5-5', 0.05, 1, 2.5],
]

type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }
type GuardMode = 'refuse' | 'warn'

export type State = {
  hasBand: boolean
  sid: string
  deadline: number
  every: number
  always: boolean
  lastRequestAt: number
  lastModel: string | null
  ctx: number
  compacted: boolean
  resumedAt: number
  transcript: number
  guard: GuardMode
  ackedAt: number
  coldWritePending: boolean
  misses: Miss[]
  pending: { cancel: () => void } | null
  last: PingRecord | null
  stopped: string | null
  /** Why the pending cold write went through without the card, for its receipt. */
  note: string | null
  waitForTurn: boolean
  retries: number
  retryReason: string
  gen: number
  tick: number
  offs: number
  turnOffs: number | null
  inFlight: boolean
  stepWrites: StepWrites | null
  steps: number
  endingSid: string
  /** The prompt cache's lifetime in this session, and what chose it. */
  ttlMs: number
  ttlSource: string
  /** The default window: bare /keepwarm, always. */
  windowMs: number
  /** The `always` option; the stored switch, once set, wins over it. */
  alwaysOption: boolean
  /** Minutes after midnight past which no automatic window opens or lasts; null for none. */
  cutoffMinutes: number | null
  /** Whether a cold send may be compacted first. Compaction must be cheap on a cold cache, as JetCompact's is. */
  coldCompact: boolean
  /** Messages waiting for the compaction under way, oldest first; null when none runs. */
  compacting: string[] | null
  /** The context before the compaction a send just went through, for its receipt; 0 when none. */
  compactedFrom: number
  /** Compactions seen: a turn clears `compacted`, so only a count says one happened. */
  compactions: number
  /** A main turn is under way: `turnId` does not say so for a plugin's prompt, and compaction refuses then. */
  running: boolean
}

/** What this turn's main requests wrote before any compaction it saw, priced per request where the steps reported usage. */
type StepWrites = { tokens: number; usd: number; priced: boolean }

function priceOf(model: string | null, promptTokens: number): [number, number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  if (promptTokens > LONG_PROMPT_TOKENS) {
    for (const [family, read, write, output] of LONG_PRICES) if (m.includes(family)) return [read, write, output]
  }
  for (const [family, read, write, output] of PRICES) {
    if (typeof family === 'string' ? m.includes(family) : family.test(m)) return [read, write, output]
  }
  return null
}

const isTruthy = (value: unknown) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())

export type TtlInputs = {
  force5m: boolean
  ttlEnv?: string
  setting?: unknown
  enable1h: boolean
  messagesTtl?: string
  /** An API key or a cloud provider, not a subscription. `$.session.identity` answers managed mods only, so the environment says. */
  thirdParty: boolean
  overLimit: boolean
}

/** Claude Code's order of choice. */
export function resolveTtl(c: TtlInputs): { ms: number; source: string } {
  const pick = (): ['5m' | '1h', string] => {
    if (c.force5m) return ['5m', 'FORCE_PROMPT_CACHING_5M']
    if (c.ttlEnv === '5m' || c.ttlEnv === '1h') return [c.ttlEnv, 'CLAUDE_CODE_PROMPT_CACHE_TTL']
    if (c.setting === '5m' || c.setting === '1h') return [c.setting, 'promptCacheTtl setting']
    if (c.enable1h) return ['1h', 'ENABLE_PROMPT_CACHING_1H']
    if (c.thirdParty) return ['5m', 'automatic']
    return c.overLimit ? ['5m', 'subscription past its limits'] : ['1h', 'subscription']
  }
  const [ttl, source] = pick()
  if (ttl === '1h' && c.messagesTtl === '5m') return { ms: TTL_5M_MS, source: `${source}, held by CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL` }
  return { ms: ttl === '5m' ? TTL_5M_MS : TTL_1H_MS, source }
}

/** Reads the session's cache lifetime. Past its limits a subscription drops to five minutes mid-session, so a ping reads it again. */
async function readTtl($: EngineInterface, s: State) {
  const [force5m, ttlEnv, messagesTtl, enable1h, settings, usage, ...thirdParty] = await Promise.all([
    $.env.get('FORCE_PROMPT_CACHING_5M'),
    $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    $.env.get('CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL'),
    $.env.get('ENABLE_PROMPT_CACHING_1H'),
    $.settings.read().catch(() => null),
    $.session.usage().catch(() => null),
    $.env.get('ANTHROPIC_API_KEY'),
    $.env.get('CLAUDE_CODE_USE_BEDROCK'),
    $.env.get('CLAUDE_CODE_USE_VERTEX'),
    $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
  ])
  const ttl = resolveTtl({
    force5m: isTruthy(force5m),
    ttlEnv,
    messagesTtl,
    enable1h: isTruthy(enable1h),
    setting: settings?.promptCacheTtl,
    thirdParty: thirdParty.some(Boolean),
    overLimit: (usage?.rateLimits ?? []).some(r => r.percentUsed >= 100),
  })
  s.ttlMs = ttl.ms
  s.ttlSource = ttl.source
}

/** A 24-hour `HH:MM` as minutes after midnight; anything else means no cutoff. */
export function parseCutoff(value: unknown): number | null {
  const m = typeof value === 'string' ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim()) : null
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** How long an automatic window opened now may last: `ms`, cut at today's cutoff; 0 from the cutoff until midnight. */
export function autoWindow(s: Pick<State, 'cutoffMinutes'>, now: number, ms: number): number {
  if (s.cutoffMinutes == null) return ms
  return Math.max(0, Math.min(ms, new Date(now).setHours(0, s.cutoffMinutes, 0, 0) - now))
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

function fmtUsd(usd: number | null): string {
  return usd == null ? 'n/a' : '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

function coldUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[1] / 1e6 : null
}

function warmUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[0] / 1e6 : null
}

/** Everything a fork bills: the cache read, any cache write, uncached input at the base rate (half the 1h write rate), and the output. */
function pingUsd(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, price: [number, number, number]): number {
  return (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * price[1] + u.input_tokens * price[1] / 2 + u.output_tokens * price[2]) / 1e6
}

/** The read-only upper bound: pings at the cache-read rate that cost as much as one cold write of the same context. */
function breakEvenPings(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  if (!price || s.ctx <= 0) return null
  return Math.floor(price[1] / price[0])
}

function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= s.ttlMs
}

function guardText(s: State, now: number): string {
  const price = priceOf(s.lastModel, s.ctx)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  const warm = warmUsd(s)
  return `the prompt cache went cold ${fmtDuration(now - s.lastRequestAt - s.ttlMs)} ago. Sending this re-writes ` +
    `up to ${s.ctx.toLocaleString('en-US')} tokens at ${rate} = ${fmtUsd(coldUsd(s))}` +
    (warm == null ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`) + '.'
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/** /clear starts a new conversation in the same process; nothing priced before it still exists. */
export function resetForClear(s: State) {
  s.ctx = 0
  s.lastRequestAt = 0
  s.compacted = false
  s.resumedAt = 0
  s.transcript = 0
  s.ackedAt = 0
  s.coldWritePending = false
  s.misses = []
  s.waitForTurn = false
  s.stepWrites = null
  s.steps = 0
  outdate(s)
  disarm(s)
}

/** Applies a resumed session's fields to the state; returns the line to log, if any. */
export function seedFromResume(s: State, e: ResumeFields, now: number): string | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
  if (typeof e.seconds_since_last_response === 'number') {
    s.lastRequestAt = now - e.seconds_since_last_response * 1000
    s.resumedAt = 0
  }
  if (typeof e.model === 'string') s.lastModel = e.model
  s.compacted = false
  if (e.prompt_cache_likely_expired !== true || s.ctx < BIG_TOKENS) return null
  const usd = typeof e.estimated_cache_write_usd === 'number' ? fmtUsd(e.estimated_cache_write_usd) : fmtUsd(coldUsd(s))
  return `resuming cold. The first message re-writes ${s.ctx.toLocaleString('en-US')} tokens, about ${usd}. ${RESUME_TIP}`
}

/** The resume card's figures: Claude Code's own estimate of the cold write when the resume carried one, else the price table's. */
export function resumeNoteFrom(s: State, estimate: unknown): ResumeNote {
  const price = priceOf(s.lastModel, s.ctx)
  const engine = typeof estimate === 'number' && s.ctx > 0
  return {
    tokens: s.ctx,
    rate: engine ? `$${Number((estimate / s.ctx * 1e6).toPrecision(2))}/MTok` : price ? `$${price[1]}/MTok` : 'the cache-write rate',
    coldUsd: engine ? estimate : coldUsd(s),
    warmUsd: warmUsd(s),
  }
}

/** The row above the prompt: keepwarm's status while a window is armed, else the cache clock on its own. */
export function rowText(s: State, now: number): string | undefined {
  const keepwarm = statusText(s, now)
  if (keepwarm) return keepwarm
  if (!s.lastRequestAt || s.compacted) return undefined
  return isCold(s, now) ? `cold for ${fmtDuration(now - s.lastRequestAt - s.ttlMs)}` : `goes cold in ${fmtDuration(s.lastRequestAt + s.ttlMs - now)}`
}

/** A transcript resumed without the time of its last response: that response came after its first launch, so an hour after that launch the cache may be cold. */
function mayBeCold(s: State, now: number): boolean {
  return s.resumedAt > 0 && !s.lastRequestAt && now - s.resumedAt >= s.ttlMs
}

/** The line for a resumed session whose last response time never arrived: the cache may be cold, and this is what that would cost. */
function unknownText(s: State): string {
  const price = priceOf(s.lastModel, s.ctx)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  return `resumed with up to ${s.ctx.toLocaleString('en-US')} tokens of context and no time of its last response, so the cache may be cold. ` +
    `If it is, this message re-writes them at ${rate} = ${fmtUsd(coldUsd(s))}.`
}

/** The conversation was summarized: the next request is the first over the new prefix, and a ping out for the old one is dropped. */
function markCompacted(s: State) {
  s.compacted = true
  s.transcript = 0
  s.ackedAt = 0
  outdate(s)
}

function statusText(s: State, now: number): string | undefined {
  if (s.stopped) return `keepwarm stopped: ${s.stopped}`
  if (!s.deadline) return undefined
  const pingText = s.last ? ` · last ping read ${fmtTok(s.last.read)} ${fmtUsd(s.last.usd)}` : ''
  const nextText = !s.lastRequestAt ? ' · waiting for the first turn'
    : s.compacted ? ' · waiting for the first turn after compaction'
    : isCold(s, now) ? ` · cold now, first ping ${fmtDuration(s.every)} after the next turn`
    : s.waitForTurn ? ' · nothing to fork yet, first ping after the next turn'
    : s.retries ? ` · API busy, ping retry ${s.retries} of ${MAX_RETRIES}`
    : s.every >= s.ttlMs ? ` · no pings on a ${fmtDuration(s.ttlMs)} cache`
    : ` · ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
  return `keepwarm ${fmtDuration(s.deadline - now)} left${nextText}${pingText}`
}

function updateStatus($: EngineInterface, s: State, now: number) {
  if (s.hasBand) $.ui.invalidate('ui.render')
  else $.ui.status(rowText(s, now))
}

/**
 * The status in the prompt footer, beside the app's own mode labels (`SessionMode`), instead of a
 * row in the band. The Code tab draws a Box and coloured Text there but drops an Svg, and cuts the
 * label at about 26 characters, so it says less than the row did: `/keepwarm status` has the rest.
 */
export type FooterMode = 'on' | 'off'

export type FooterLabel = { state: 'warm' | 'cold' | null; detail: string; sep: ' · ' | ' ' }

/**
 * A warm cache always reads `cache warm · 2h07m left`: how long it stays warm, keepwarm's window while
 * one runs, else until its hour runs out. A cold one reads `cache cold for 6m`. Before the first turn
 * there is no state: `cache · keepwarm 2h07m` or `cache · keepwarm stopped`. 24 characters at most,
 * because the font's digits differ in width and `cache warm · keepwarm 6h00m` (27) was cut where
 * `… 5h58m` fitted.
 */
export function footerLabel(s: State, now: number): FooterLabel | undefined {
  if (s.deadline && now >= s.deadline) return undefined
  if (!s.lastRequestAt || s.compacted) {
    if (s.deadline) return { state: null, detail: `keepwarm ${fmtDuration(s.deadline - now)}`, sep: ' · ' }
    return s.stopped ? { state: null, detail: 'keepwarm stopped', sep: ' · ' } : undefined
  }
  if (isCold(s, now)) return { state: 'cold', detail: `for ${fmtDuration(now - s.lastRequestAt - s.ttlMs)}`, sep: ' ' }
  const left = s.deadline ? s.deadline - now : s.lastRequestAt + s.ttlMs - now
  return { state: 'warm', detail: `${fmtDuration(left)} left`, sep: ' · ' }
}

export const isBandSurface = (surface: unknown) => surface === 'terminal' || surface === 'desktop'

/** Whether a surface that draws the band is attached now. session.start's own `surface` is null when a host such as the desktop app runs the session. */
async function hasBandSurface($: EngineInterface): Promise<boolean> {
  try {
    return (await $.session.surfaces()).some(isBandSurface)
  } catch {
    return false
  }
}

/** How soon the row next changes: each minute while a countdown shows, every 5 minutes while the cache sits cold with keepwarm off. */
export function tickDelay(s: State, now: number): number {
  return s.deadline || (s.lastRequestAt && !isCold(s, now)) ? 60 * 1000 : 5 * 60 * 1000
}

/** The row's tick: it redraws, or the status entry is rewritten where no band draws, then schedules the next. */
async function tick($: EngineInterface, s: State) {
  const now = await $.clock.now()
  updateStatus($, s, now)
  $.clock.after(tickDelay(s, now), () => { void tick($, s) })
}

/** Cancels the timer. Every new timer is set right after this, so the tick also says the schedule changed. */
function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
  s.tick++
}

/** Outdates any ping in flight: /clear, a resume, compaction or stop replaced the state it was sent for. Re-arming or extending the window does not, so a ping out at that moment still counts; a main request outdates it through the request clock. */
function outdate(s: State) {
  s.gen++
}

// The window and its ping period belong to the session that armed them, so a
// second session, or one resumed from another transcript, never inherits them
// and cannot turn them off. The always switch and the guard mode stay global.
function deadlineKey(s: State): string {
  return `${KEY_DEADLINE}:${s.sid}`
}

function everyKey(s: State): string {
  return `${KEY_EVERY}:${s.sid}`
}

/** Clears this session's own dead window and the bare keys a store written before 2.1.1 still holds. Other sessions' keys are never touched: a read followed by a delete cannot be made atomic against their renewal. */
async function prune($: EngineInterface, s: State, now: number) {
  for (const key of [KEY_DEADLINE, deadlineKey(s)]) {
    const deadline = await $.store.get(key)
    if (deadline === undefined) continue
    if (typeof deadline === 'number' && deadline > now) continue
    await $.store.delete(key)
    await $.store.delete(KEY_EVERY + key.slice(KEY_DEADLINE.length))
  }
}

async function stop($: EngineInterface, s: State, why: string | null, forgetAlways = false) {
  // Set before any await, so a window being opened at the same moment sees the off and does not write itself back.
  if (forgetAlways) {
    s.always = false
    s.offs++
  }
  s.deadline = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  s.retries = 0
  outdate(s)
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  // With the always option on, only a stored false keeps /keepwarm off across sessions.
  if (forgetAlways) await (s.alwaysOption ? $.store.set(KEY_ALWAYS, false) : $.store.delete(KEY_ALWAYS))
  updateStatus($, s, await $.clock.now())
}

/** The conversation ended under /clear or an in-process resume. The next one's id cannot be read until the engine has switched, so the state is left unseated. */
async function endConversation($: EngineInterface, s: State, reason: 'clear' | 'resume') {
  // Claimed before any await: a second end or a classic start for the same conversation finds it already gone, and an
  // end cut short by its budget leaves no timer and no old id behind, only the keys below.
  const keys = [deadlineKey(s), everyKey(s)]
  const ending = s.sid
  resetForClear(s)
  s.sid = ''
  s.endingSid = ending
  // /clear ends the conversation the window was armed for. A resume carries the window on to the next one, under its
  // id: the old id's keys go here, or a /keepwarm off there could never find them and the old session would re-arm them.
  if (reason === 'clear') {
    s.deadline = 0
    s.every = PING_AFTER_MS
    s.stopped = null
    s.retries = 0
  }
  for (const key of keys) await $.store.delete(key)
  if (reason === 'clear') updateStatus($, s, await $.clock.now())
}

/** Reads the session the process runs now: its id, its model and the engine's figures for its context. Returns the time read with them. */
async function seat($: EngineInterface, s: State, id?: string): Promise<number> {
  s.sid = id ?? await $.session.id()
  s.endingSid = ''
  s.lastModel = await $.session.model()
  const usage = await $.session.usage()
  const now = await $.clock.now()
  if (usage.context.tokens) s.ctx = usage.context.tokens
  // A resumed transcript's last response came somewhere between its first launch and now; only the resume fields say where.
  s.resumedAt = !s.lastRequestAt && usage.context.tokens ? usage.startedAt : 0
  return now
}

/** Seats the state in the conversation that followed a /clear or a resume, once, and arms what always or a window opened meanwhile asks for. */
async function reseat($: EngineInterface, s: State) {
  if (s.sid) return
  const id = await $.session.id()
  // The host still answers with the conversation being ended: the next one is not there to seat yet, so nothing is
  // seated under the old id, and a window opened meanwhile waits in memory for the id it belongs to.
  if (id === s.endingSid) return
  const left = `${KEY_QUEUED}:${s.endingSid}`
  const now = await seat($, s, id)
  // Messages waiting on a compaction follow the person into this conversation, after any queued here; the old copy goes last.
  if (s.compacting) {
    const here = await $.store.get(queueKey(s))
    if (Array.isArray(here)) s.compacting.push(...here.filter(text => typeof text === 'string'))
    await $.store.set(queueKey(s), s.compacting)
    await $.store.delete(left)
  } else await sendQueued($, s)
  if (s.always) await armAlways($, s, now)
  // A window carried over, or armed while the conversation was ending, is written under this id.
  else if (s.deadline) await startWindow($, s, s.deadline - now, s.every)
  else updateStatus($, s, now)
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  s.retries = 0
  if (!s.deadline) return
  const now = await $.clock.now()
  // A timer set while the clock was read, such as a retry, is replaced here, never left running beside this one;
  // from this line to the assignment below nothing awaits.
  disarm(s)
  s.retries = 0
  if (now >= s.deadline) return stop($, s, null)
  // A cold window still needs expiry cleanup, but must not send a model request.
  if (s.lastRequestAt && !s.compacted && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + s.ttlMs - now
    // Waiting for a turn sends nothing, but wakes when the cache goes cold so the row says so.
    if (s.waitForTurn) s.pending = $.clock.after(Math.min(s.deadline - now, untilCold), () => { void arm($, s) })
    else {
      const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
      s.pending = $.clock.after(delay, () => { void ping($, s) })
    }
  } else {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  }
  updateStatus($, s, now)
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  // Read before the clock: a subscription that just went past its limits has five minutes, and a ping on that pays the whole write.
  await readTtl($, s).catch(() => undefined)
  const tick = s.tick
  const now = await $.clock.now()
  // A timer set or cancelled while the clock was read (an extension, a retry, a turn) owns the window now;
  // if that left no timer, a window still open is armed again rather than left without one.
  if (s.tick !== tick) return s.pending || s.inFlight ? undefined : arm($, s)
  // One fork at a time: the one already out re-arms when it settles. Checked after the await, and set
  // below with no await in between, so two timers can never both send.
  if (s.inFlight) return
  if (now >= s.deadline) return arm($, s)
  if (isCold(s, now)) return arm($, s)
  if (s.compacted || s.waitForTurn || !s.lastRequestAt) return arm($, s)
  // A request since this timer was set moved the clock; schedule from it.
  if (now - s.lastRequestAt < s.every - 1000) return arm($, s)
  // A host that slept past a retry's slot must not send it inside the last minute.
  if (s.retries && now >= s.lastRequestAt + s.ttlMs - MIN_PING_MS) return stop($, s, s.retryReason + afterRetries(s.retries))
  const gen = s.gen
  const sentAt = s.lastRequestAt
  s.inFlight = true
  const sent = await $.model.fork({ prompt: PING_PROMPT }).then(reply => ({ reply }), (err: unknown) => ({ err }))
  const at = await $.clock.now()
  s.inFlight = false
  // Checked after the last await. A stop, /clear, resume or compaction, or a main request that moved the
  // cache clock, replaced what this fork was sent for: its reply is dropped and the window armed afresh.
  if (gen !== s.gen || s.lastRequestAt !== sentAt) return s.pending ? undefined : arm($, s)
  if ('err' in sent) return stop($, s, `the ping failed, ${sent.err instanceof Error ? sent.err.message : String(sent.err)}`)
  const reply = sent.reply
  if (reply === null) return stop($, s, 'the engine did not send the ping, either the snapshot was cold or the API call failed')
  if (reply.isAnswered === false) {
    // A restarted process has no conversation to fork until its first turn; the window waits for one instead of ending.
    if (reply.reason === 'nothing-to-fork') {
      s.waitForTurn = true
      return arm($, s)
    }
    const reason = reply.reason === 'api-error' ? `the API call failed${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping returned no text'
    // A busy or failing API is usually brief; retry while a ping can still land a minute before the cache goes cold.
    if (reply.reason === 'api-error' && (reply.status === null || reply.status === 429 || reply.status >= 500)) {
      const wait = MIN_PING_MS * 2 ** s.retries
      if (s.retries < MAX_RETRIES && at + wait < Math.min(s.deadline, s.lastRequestAt + s.ttlMs - MIN_PING_MS)) {
        s.retries++
        s.retryReason = reason
        // Replaces any timer set while the fork was out, such as a window extension's, so only the retry fires.
        disarm(s)
        s.pending = $.clock.after(wait, () => { void ping($, s) })
        updateStatus($, s, at)
        return
      }
    }
    return stop($, s, reason + afterRetries(s.retries))
  }
  const u = reply.usage
  const price = priceOf(s.lastModel, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
  // A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke.
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = price ? pingUsd(u, price) : null
  s.last = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  if (!warm) return stop($, s, `the ping read ${fmtTok(u.cache_read_input_tokens)} and wrote ${fmtTok(u.cache_creation_input_tokens)} tokens (${fmtUsd(usd)}), the cache was already gone`)
  s.lastRequestAt = now
  await remember($, s)
  await arm($, s)
}

function afterRetries(n: number): string {
  return n ? ` after ${n} ${n === 1 ? 'retry' : 'retries'}` : ''
}

/** The reply to an arming command; on a cold cache it says when the first ping can come. */
/** How long keepwarm holds the cache after a paid cold write: the rolling window when always is on, and never past the cutoff. */
function holdMs(s: State, now: number): number {
  return autoWindow(s, now, s.always ? s.windowMs : AUTO_WARM_MS)
}

/** The always switch: the stored value once a command set one, else the option. */
async function readAlways($: EngineInterface, s: State): Promise<boolean> {
  const stored = await $.store.get(KEY_ALWAYS)
  return stored === undefined ? s.alwaysOption : stored === true
}

/** Opens the rolling window; a longer one stays. Past the cutoff none opens, and a window restored from before it just runs on. */
async function armAlways($: EngineInterface, s: State, now: number, offs = s.offs) {
  const window = autoWindow(s, now, s.windowMs)
  if (window) await startWindow($, s, Math.max(window, s.deadline - now), PING_AFTER_MS, offs)
  else if (s.deadline) await arm($, s)
}

function armedText(s: State, now: number, windowMs: number): string {
  if (s.every >= s.ttlMs) return `keepwarm on for ${fmtDuration(windowMs)}, but this session's ${fmtDuration(s.ttlMs)} cache goes cold before a ping can reach it, so none is sent`
  if (isCold(s, now)) return `keepwarm on for ${fmtDuration(windowMs)}. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(s.every)} after each idle stretch keeps the cache read, not re-written`
}

// A /keepwarm off after `offs` was read wins: the window it cancelled is not written back. A caller that awaited
// before deciding to open a window passes the count it read first.
async function startWindow($: EngineInterface, s: State, windowMs: number, every: number, offs = s.offs) {
  if (s.offs !== offs) return
  const now = await $.clock.now()
  if (s.offs !== offs) return
  const deadline = now + windowMs
  s.every = every
  s.deadline = deadline
  s.stopped = null
  // Unseated, between a conversation's end and the host reporting the next, the window has no id to be written under; the seat writes it.
  if (!s.sid) return arm($, s)
  if (every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
  await $.store.set(deadlineKey(s), deadline)
  if (s.offs !== offs) {
    // Remove only what this call wrote; a window armed after the off is left alone.
    if ((await $.store.get(deadlineKey(s))) === deadline) {
      await $.store.delete(deadlineKey(s))
      if (!s.deadline) await $.store.delete(everyKey(s))
    }
    return
  }
  await arm($, s)
}

function card(s: State, now: number): string {
  const lines: string[] = []
  lines.push(`${s.lastModel ?? 'model not seen yet'}`)
  if (s.compacted) lines.push('state       reset by compaction, waiting for the first turn')
  else if (s.resumedAt) lines.push(mayBeCold(s, now) ? 'state       unknown, resumed without the time of its last response' : `state       resumed without the time of its last response, warm for up to ${fmtDuration(s.resumedAt + s.ttlMs - now)} more`)
  else if (!s.lastRequestAt) lines.push('state       no request yet this session')
  else if (isCold(s, now)) lines.push(`state       COLD, last request ${fmtDuration(now - s.lastRequestAt)} ago`)
  else lines.push(`state       warm, ${fmtDuration(s.lastRequestAt + s.ttlMs - now)} left`)
  lines.push(`lifetime    ${fmtDuration(s.ttlMs)} (${s.ttlSource})`)
  lines.push(`context     ${s.ctx.toLocaleString('en-US')} tokens`)
  lines.push(`cold cost   ${fmtUsd(coldUsd(s))} to re-write it (warm turn ${fmtUsd(warmUsd(s))})`)
  const always = s.always ? ' (always)' : ''
  const idle = s.always ? 'off until the next turn, which arms 6h00m (always)' : 'off (/keepwarm to arm it for 6h00m)'
  lines.push(`keepwarm    ${s.deadline ? (statusText(s, now) ?? '').replace(/^keepwarm /, 'on, ') + always : s.stopped ? `stopped, ${s.stopped}${always}` : idle}`)
  const pings = breakEvenPings(s)
  if (pings != null) lines.push(`break-even  up to ${pings} pings at the read rate cost one cold write, about ${fmtDuration(pings * s.every)} of idle at one ping per ${fmtDuration(s.every)}`)
  lines.push(`guard       ${s.guard === 'refuse' ? 'refuse once (/cache-watch guard warn to only show the price)' : 'warn only (/cache-watch guard refuse to be stopped once)'}`)
  const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  lines.push(`session     ${s.misses.length} cold write${s.misses.length === 1 ? '' : 's'} paid, ${fmtUsd(paid)}`)
  return lines.join('\n')
}

// ---- The hold card ----

const held = atom({ plugin: 'cache-watch', key: 'held' } as const, null)
const showStatus = atom({ plugin: 'cache-watch', key: 'showStatus' } as const, false)
const receipt = atom({ plugin: 'cache-watch', key: 'receipt' } as const, null)
const resumed = atom({ plugin: 'cache-watch', key: 'resumed' } as const, null)
const snapshot = atom({ plugin: 'cache-watch', key: 'snapshot' } as const, null)

async function remember($: EngineInterface, s: State) {
  const { sid, lastRequestAt, lastModel, ctx, compacted, ackedAt, last, stopped } = s
  const misses = [...s.misses]
  await update($, snapshot, () => ({ sid, lastRequestAt, lastModel, ctx, compacted, ackedAt, misses, last, stopped }))
}

/** Puts back what the mod knew before a reload, when it was about this conversation. */
export function restore(s: State, saved: Snapshot | null, sid: string) {
  // A copy: the host keeps the saved value, and misses grows in place.
  if (saved?.sid === sid) Object.assign(s, structuredClone(saved))
}

/** How long a cold resume waits for a band before it logs its plain line instead: the desktop app attaches after the session starts. */
export const RESUME_LOG_AFTER_MS = 3000
export const RECEIPT_MS = 15 * 60 * 1000
export const HELD_DROP = 'Held by Cache Watch. Choose an option above the prompt box, or send it again to pay.'
export const COMPACT_WAIT_MS = 2 * 60 * 1000
export const COMPACTING_DROP = 'Cache Watch: the cache is cold, so this session compacts first and your message follows.'
const QUOTE_MAX = 160

export function heldFrom(s: State, text: string): Held {
  const price = priceOf(s.lastModel, s.ctx)
  return { text, tokens: s.ctx, rate: price ? `$${price[1]}/MTok` : 'the cache-write rate', coldUsd: coldUsd(s), warmUsd: warmUsd(s) }
}

/** Whether the send came from someone at a terminal or the desktop app, who sees the card. Remote Control, schedules, notifications and other sessions do not. */
export function isAttended(origin: PromptOrigin): boolean {
  return origin.kind === 'composer' || origin.kind === 'sdk' || origin.kind === 'unclassified'
}

/** Whether a person sent this from a phone: over Remote Control, or through the Telegram relay. They see no card, and would wait on it for nothing. */
export function isRemote(origin: PromptOrigin): boolean {
  return origin.kind === 'bridge' || (origin.kind === 'plugin' && origin.name === RELAY_PLUGIN)
}

/** A plugin's resend expands no @file mention and carries no pasted item, so those prompts keep the refuse-once path. */
export function canHold(text: string, attachments: readonly unknown[] | undefined): boolean {
  return !(attachments && attachments.length > 0) && !/(^|\s)@\S/.test(text)
}

/** The held message on one line, cut with an ellipsis past QUOTE_MAX characters. */
export function quoted(text: string): string {
  // The renderer refuses control and format characters, and a refused tree loses the whole card.
  const one = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()
  return one.length > QUOTE_MAX ? one.slice(0, QUOTE_MAX - 1).trimEnd() + '…' : one
}

/** The warm bar's length against the cold one: their price ratio, kept long enough to see. */
export function warmShare(h: Held): number {
  if (h.coldUsd == null || h.warmUsd == null || h.coldUsd <= 0) return 0.04
  return Math.min(1, Math.max(0.025, h.warmUsd / h.coldUsd))
}

function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// The SVG is drawn as an image, so it cannot read the theme: the module picks the palette.
// Panel and track are translucent so they sit on whatever the band's background is.
const PALETTE = {
  dark: { panel: '#000000', panelOpacity: 0.22, track: '#ffffff', trackOpacity: 0.09, label: '#d6d3c9', caption: '#a3a097', cold: '#e58a62', warm: '#7ccf9c', icon: '#a3a097' },
  light: { panel: '#141413', panelOpacity: 0.045, track: '#141413', trackOpacity: 0.09, label: '#3b3934', caption: '#6a675f', cold: '#c15f3c', warm: '#2e7a4c', icon: '#6a675f' },
}
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

export function statsAlt(h: Held): string {
  return `Send it now: ${fmtUsd(h.coldUsd)}, re-writes up to ${h.tokens.toLocaleString('en-US')} tokens at ${h.rate}. ` +
    `A warm turn: ${fmtUsd(h.warmUsd)}, what it would have cost.`
}

/** The two price columns as one SVG, so the figures can be large; mod text has no size. */
export function statsSvg(h: Held, light: boolean): string {
  const p = PALETTE[light ? 'light' : 'dark']
  const W = 680
  const H = 132
  const PAD = 24
  const COL = (W - 3 * PAD) / 2
  const column = (x: number, label: string, figure: string, color: string, share: number, caption: string) => {
    const size = Math.max(10.5, Math.min(13, COL / (caption.length * 0.52)))
    return `<text x="${x}" y="34" font-size="14" font-weight="600" fill="${p.label}">${esc(label)}</text>` +
      `<text x="${x}" y="74" font-size="32" font-weight="700" fill="${color}" style="font-variant-numeric:tabular-nums">${esc(figure)}</text>` +
      `<rect x="${x}" y="88" width="${COL}" height="6" rx="3" fill="${p.track}" fill-opacity="${p.trackOpacity}"/>` +
      `<rect x="${x}" y="88" width="${(COL * share).toFixed(1)}" height="6" rx="3" fill="${color}"/>` +
      `<text x="${x}" y="116" font-size="${size.toFixed(1)}" fill="${p.caption}">${esc(caption)}</text>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">` +
    `<rect width="${W}" height="${H}" rx="12" fill="${p.panel}" fill-opacity="${p.panelOpacity}"/>` +
    column(PAD, 'Send it now', fmtUsd(h.coldUsd), p.cold, 1, `re-writes up to ${h.tokens.toLocaleString('en-US')} tokens at ${h.rate}`) +
    column(PAD * 2 + COL, 'A warm turn', fmtUsd(h.warmUsd), p.warm, warmShare(h), 'what it would have cost') +
    '</svg>'
}

/**
 * The compact card's two price rows as one short Svg: desktop Text is proportional, so block-glyph
 * bars break into dotted fragments there. Captions are the first thing to go when the band is narrow.
 */
export function compactStatsSvg(h: Held, light: boolean, width: number): string {
  const p = PALETTE[light ? 'light' : 'dark']
  const W = Math.round(width)
  const H = 44
  const withCaptions = W >= 560
  const barX = 150
  const barEnd = withCaptions ? W - 270 : W - 4
  const barW = Math.max(40, barEnd - barX)
  const row = (y: number, label: string, figure: string, color: string, share: number, caption: string) =>
    `<text x="0" y="${y}" font-size="12.5" fill="${p.label}">${esc(label)}</text>` +
    `<text x="92" y="${y}" font-size="13" font-weight="700" fill="${color}" style="font-variant-numeric:tabular-nums">${esc(figure)}</text>` +
    `<rect x="${barX}" y="${y - 7}" width="${barW}" height="6" rx="3" fill="${p.track}" fill-opacity="${p.trackOpacity}"/>` +
    `<rect x="${barX}" y="${y - 7}" width="${Math.max(6, barW * share).toFixed(1)}" height="6" rx="3" fill="${color}"/>` +
    (withCaptions ? `<text x="${barX + barW + 12}" y="${y}" font-size="12" fill="${p.caption}">${esc(caption)}</text>` : '')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">` +
    row(16, 'Send it now', fmtUsd(h.coldUsd), p.cold, 1, `re-writes up to ${h.tokens.toLocaleString('en-US')} tokens at ${h.rate}`) +
    row(38, 'A warm turn', fmtUsd(h.warmUsd), p.warm, warmShare(h), 'what it would have cost') +
    '</svg>'
}

export function pauseSvg(light: boolean): string {
  const c = PALETTE[light ? 'light' : 'dark'].icon
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round">` +
    '<circle cx="8" cy="8" r="6.75"/><path d="M6.5 5.5v5M9.5 5.5v5"/></svg>'
}

export function shieldSvg(light: boolean): string {
  const c = PALETTE[light ? 'light' : 'dark'].warm
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` +
    '<path d="M8 1.75 13.25 3.75v3.9c0 3.05-2.2 5.35-5.25 6.6-3.05-1.25-5.25-3.55-5.25-6.6v-3.9Z"/><path d="m5.6 8.1 1.65 1.65 3.15-3.3"/></svg>'
}

async function release($: EngineInterface) {
  await update($, held, () => null)
  await update($, showStatus, () => false)
}

async function payAndSend($: EngineInterface, s: State) {
  const h = await read($, held)
  if (!h) return
  await release($)
  if (h.isPreview) return
  // The resend is the paid cold write: turn.complete scores it and arms keepwarm.
  s.ackedAt = 0
  s.coldWritePending = true
  await $.prompt.submit({ text: h.text, asUser: true })
}

async function startFresh($: EngineInterface) {
  const h = await read($, held)
  if (!h) return
  await release($)
  if (h.isPreview) return
  try {
    await $.command.run({ command: 'clear' })
  } catch {
    $.ui.toast('cache-watch: the conversation was not cleared. Type /clear, then send your message.')
  }
  // The message waits in the box for the new conversation, to send or edit.
  await $.prompt.fill({ text: h.text })
}

/** Start fresh from the resume card: nothing is held, so it only clears. */
async function freshFromResume($: EngineInterface) {
  await update($, resumed, () => null)
  try {
    await $.command.run({ command: 'clear' })
  } catch {
    $.ui.toast('cache-watch: the conversation was not cleared. Type /clear to start fresh.')
  }
}

/** The state after a compaction of the main conversation, whoever raised it: `$.session.compact` skips its caller's own hook. */
async function afterCompact($: EngineInterface, s: State) {
  await release($)
  markCompacted(s)
  s.compactions++
  s.ctx = 0
  disarm(s)
  await arm($, s)
  await remember($, s)
}

/**
 * Compacts between turns. A hook cannot: both calls refuse inside `prompt.submit`, whose turn they would wait on.
 * An SDK session, as the desktop app runs, has no `$.session.compact`; `/compact` there resolves once it is done, and its
 * session.compact reaches this mod's hook. Resolves whether it compacted; a refusal, from JetCompact or the engine, is false.
 * One that outlasts COMPACT_WAIT_MS counts as not done, because messages wait on the answer; the engine still runs a prompt
 * only once it is idle, so a late compaction lands ahead of them.
 */
async function compactNow($: EngineInterface, s: State): Promise<boolean> {
  const seen = s.compactions
  let late = false
  const compact = async () => {
    try {
      const { skip } = await $.session.compact()
      if (skip === undefined) await afterCompact($, s)
    } catch {
      if (!late) await $.command.run({ command: 'compact' }).catch(() => undefined)
    }
  }
  await Promise.race([compact(), new Promise<void>(done => { $.clock.after(COMPACT_WAIT_MS, () => { late = true; done() }) })])
  return s.compactions !== seen
}

const queueKey = (s: State) => `${KEY_QUEUED}:${s.sid}`

/** Keeps a dropped message where a reload or a restart cannot lose it: the engine no longer has it. */
async function enqueue($: EngineInterface, s: State, text: string) {
  s.compacting = [...(s.compacting ?? []), text]
  await $.store.set(queueKey(s), s.compacting)
}

/**
 * Compacts, then sends what waited for it. Sent whatever the compaction did: a message that vanished would cost more than a
 * cold write. After a /clear in the meantime it goes to the new conversation, as it would have had it come a moment later.
 */
async function compactThenSend($: EngineInterface, s: State, why: string) {
  const before = s.ctx
  const key = queueKey(s)
  const compacted = await compactNow($, s)
  let texts = s.compacting ?? []
  s.compacting = null
  const owner = queueKey(s)
  if (owner === key) {
    s.ackedAt = 0
    if (compacted) {
      s.compactedFrom = before
      s.note = `Compacted from ${fmtTok(before)} tokens first, ${why}.`
    } else {
      s.coldWritePending = true
      s.note = 'The compaction did not go through, so this may have paid the whole write.'
    }
    $.ui.log(compacted ? `compacted from ${fmtTok(before)} tokens before sending, ${why}.` : 'the compaction did not go through, so the message may have gone out cold.')
  }
  // Each leaves the queue before it goes, so a reload here sends none twice.
  while (texts.length) {
    const [text, ...rest] = texts as [string, ...string[]]
    texts = rest
    await $.store.set(owner, rest)
    await $.prompt.submit({ text, asUser: true })
  }
  await $.store.delete(owner)
  await $.store.delete(key)
}

/** Sends what a reload or a restart caught between a message's drop and its resend, once the session is in that conversation. */
async function sendQueued($: EngineInterface, s: State) {
  const queued = await $.store.get(queueKey(s))
  if (s.compacting || !Array.isArray(queued) || !queued.length) return
  s.compacting = queued.filter(text => typeof text === 'string')
  $.clock.after(0, () => { void compactThenSend($, s, 'because a message was waiting for it') })
}

async function compactAndSend($: EngineInterface, s: State) {
  const h = await read($, held)
  if (!h) return
  await release($)
  if (h.isPreview) return
  await enqueue($, s, h.text)
  await compactThenSend($, s, 'as you chose on the card')
}

/** Compact from the resume card: nothing is held, so the next message is simply small. */
async function compactFromResume($: EngineInterface, s: State) {
  await update($, resumed, () => null)
  if (!(await compactNow($, s))) $.ui.toast('cache-watch: the conversation was not compacted.')
}

/** A surface that never drew the band gets the resume note as the plain line upstream logged. */
async function resumeFallback($: EngineInterface, s: State, line: string) {
  if (s.hasBand || !(await read($, resumed))) return
  await update($, resumed, () => null)
  $.ui.log(line)
}

export function receiptText(r: Receipt): string {
  const keep = r.warmForMs > 0 ? ` Keepwarm holds the cache for ${fmtDuration(r.warmForMs)}.` : ''
  return `Cold write paid: ${fmtUsd(r.usd)} for ${fmtTok(r.tokens)} tokens.${keep}`
}

/** A terminal bar: the filled cells and the track left after them. */
export function bar(share: number, cells: number): [string, string] {
  const filled = Math.max(1, Math.min(cells, Math.round(cells * share)))
  return ['█'.repeat(filled), '░'.repeat(cells - filled)]
}

export function freshState(): State {
  return {
    hasBand: false, sid: '', deadline: 0, every: PING_AFTER_MS, always: false, lastRequestAt: 0, lastModel: null, ctx: 0, compacted: false,
    resumedAt: 0, transcript: 0, guard: 'refuse', ackedAt: 0, coldWritePending: false, misses: [], pending: null, last: null, stopped: null, note: null,
    waitForTurn: false, retries: 0, retryReason: '', gen: 0, tick: 0, offs: 0, turnOffs: null, inFlight: false, stepWrites: null, steps: 0, endingSid: '',
    ttlMs: TTL_1H_MS, ttlSource: 'not read yet', windowMs: DEFAULT_WINDOW_MS, alwaysOption: false, cutoffMinutes: null, coldCompact: false, compacting: null, compactedFrom: 0, compactions: 0, running: false,
  }
}

export const register: Register = (on, options) => {
  const s = freshState()
  const windowMinutes = Number(options.windowMinutes)
  if (windowMinutes > 0) s.windowMs = windowMinutes * 60 * 1000
  s.alwaysOption = options.always === true
  s.cutoffMinutes = parseCutoff(options.cutoffTime)
  s.coldCompact = options.coldCompact === true
  let light = false
  let noColor = false
  let footer: FooterMode = 'on'
  // Where the footer has drawn: the band drops its row only on a surface whose footer has shown up.
  const footerSeen = { count: 0, surface: '', modes: [] as readonly string[] }

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      light = typeof result.value === 'string' && result.value.startsWith('light')
      if (s.hasBand) $.ui.invalidate('ui.render')
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // next(e) rejects when nothing sits beneath (colorwheel); an empty Box keeps this band drawing.
    const rest = await next(e).catch(() => $.ui.resolve(e).Box({ children: [] }))
    if (!s.hasBand && isBandSurface(e.surface)) {
      // The desktop app attaches after session.start, which saw no surface; its first band draw says it is here.
      s.hasBand = true
      $.clock.after(0, () => { $.ui.status(undefined) })
    }
    if (!s.hasBand || e.props.hasSurvey) return rest
    const now = await $.clock.now()
    const h = await read($, held)
    if (h) {
      const { Box, Text, Button, Markdown } = $.ui.resolve(e)
      const isOpen = await read($, showStatus)
      const theme = light ? 'light' : 'dark'
      const cold = noColor ? undefined : 'claude'
      const warm = noColor ? undefined : 'success'
      // Short alts: one builder reports an Svg with an empty alt does not draw on the desktop.
      const icon = e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: statusIcons[theme].cold.svg, width: 40, height: 40, alt: 'Cache Watch' })
        : e.surface === 'terminal' && !noColor ? $.ui.resolve(e).Image({ source: { png: statusIcons[theme].cold.png }, columns: 3, rows: 1, alt: '[>]' })
        : Text({ color: cold, bold: true, children: ['[>]'] })
      const pause = e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: pauseSvg(light), width: 16, height: 16, alt: 'On hold' })
        : Text({ dimColor: true, children: ['‖'] })
      const shield = e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: shieldSvg(light), width: 16, height: 16, alt: 'Keepwarm' })
        : Text({ color: warm, children: ['✓'] })
      // A band taller than maxRows scrolls in its own window, which could hide the buttons. The full card
      // is about 23 rows on the desktop (its price panel draws taller than text rows) and 17 in a terminal.
      const compact = e.props.maxRows < (e.surface === 'desktop' ? 24 : 18)
      let stats
      if (e.surface === 'desktop' && !compact) {
        // An Svg without width and height keeps a 300 by 150 frame (nakadadev). About 8 px per column, less the card's padding.
        const width = Math.max(320, Math.min(680, e.props.bodyColumns * 8 - 48))
        stats = $.ui.resolve(e).Svg({ source: statsSvg(h, light), alt: statsAlt(h), width, height: Math.round(width * 132 / 680) })
      } else if (e.surface === 'desktop') {
        // Compact on the desktop: two thin bars in one short Svg, never block glyphs in proportional Text.
        const width = Math.max(280, Math.min(680, e.props.bodyColumns * 8 - 32))
        stats = $.ui.resolve(e).Svg({ source: compactStatsSvg(h, light, width), alt: statsAlt(h), width, height: 44 })
      } else {
        const cells = Math.max(6, Math.min(24, Math.floor((e.props.bodyColumns - 40) / 2)))
        const [coldFill, coldTrack] = bar(1, cells)
        const [warmFill, warmTrack] = bar(warmShare(h), cells)
        stats = Box({ flexDirection: 'column', children: [
          Text({ children: [
            Text({ dimColor: true, children: ['Send it now  '] }),
            Text({ color: cold, bold: true, children: [fmtUsd(h.coldUsd).padEnd(8)] }),
            Text({ color: cold, children: [coldFill] }),
            Text({ dimColor: true, children: [coldTrack, `  re-writes up to ${h.tokens.toLocaleString('en-US')} tokens at ${h.rate}`] }),
          ] }),
          Text({ children: [
            Text({ dimColor: true, children: ['A warm turn  '] }),
            Text({ color: warm, bold: true, children: [fmtUsd(h.warmUsd).padEnd(8)] }),
            Text({ color: warm, children: [warmFill] }),
            Text({ dimColor: true, children: [warmTrack, '  what it would have cost'] }),
          ] }),
        ] })
      }
      const statusCard = isOpen ? [Markdown({ key: 'status-card', dimColor: true, text: '```\n' + card(s, now) + '\n```' })] : []
      const coldFor = h.isPreview ? 'preview, nothing is held' : `cold for ${fmtDuration(now - s.lastRequestAt - s.ttlMs)}`
      const holdCard = compact ? Box({ flexDirection: 'column', borderStyle: 'round', borderColor: 'subtle', paddingX: 1, children: [
        Text({ wrap: 'truncate-end', children: [
          Text({ color: cold, bold: true, children: ['CACHE WATCH'] }),
          Text({ dimColor: true, children: [' · '] }),
          Text({ bold: true, children: ['Your message is on hold'] }),
          Text({ dimColor: true, children: [` · ${coldFor}`] }),
        ] }),
        stats,
        Text({ wrap: 'truncate-end', children: [`On hold: “${quoted(h.text)}”`] }),
        ...statusCard,
      ] }) : Box({ flexDirection: 'column', borderStyle: 'round', borderColor: 'subtle', paddingX: 2, paddingY: 1, gap: 1, children: [
        Box({ flexDirection: 'row', gap: 2, alignItems: 'center', children: [
          Box({ flexShrink: 0, children: [icon] }),
          Box({ flexDirection: 'column', children: [
            Text({ color: cold, bold: true, children: ['CACHE WATCH'] }),
            Text({ bold: true, children: ['Your message is on hold'] }),
            Text({ dimColor: true, children: [h.isPreview
              ? 'Preview: nothing is held. Any button closes it.'
              : `The prompt cache went cold ${fmtDuration(now - s.lastRequestAt - s.ttlMs)} ago.`] }),
          ] }),
        ] }),
        stats,
        Box({ flexDirection: 'column', children: [
          Box({ flexDirection: 'row', gap: 1, alignItems: 'center', children: [
            Box({ flexShrink: 0, children: [pause] }),
            Text({ wrap: 'wrap', children: [`On hold: “${quoted(h.text)}”`] }),
          ] }),
          Box({ flexDirection: 'row', gap: 1, alignItems: 'center', children: [
            Box({ flexShrink: 0, children: [shield] }),
            Text({ wrap: 'wrap', children: [`Pay once and keepwarm then holds the cache for ${fmtDuration(holdMs(s, now))}.`] }),
          ] }),
        ] }),
        ...statusCard,
      ] })
      const buttons = Box({ flexDirection: 'row', gap: 2, alignItems: 'center', children: [
        Button({ key: 'pay', label: 'Pay and send', variant: 'primary', onPress: () => { void payAndSend($, s) } }),
        ...(s.coldCompact ? [Button({ key: 'compact', label: 'Compact and send', onPress: () => { void compactAndSend($, s) } })] : []),
        Button({ key: 'fresh', label: 'Start fresh', onPress: () => { void startFresh($) } }),
        Button({ key: 'status', label: isOpen ? 'Hide cache status' : 'Show cache status', plain: true, onPress: () => { void update($, showStatus, open => !open) } }),
      ] })
      return Box({ flexDirection: 'column', gap: compact ? 0 : 1, children: [rest, holdCard, buttons] })
    }
    // A cold resume's note, styled like the compact hold card, in place of a transcript line no hook can restyle.
    const note = await read($, resumed)
    const notice: RenderElement[] = []
    if (note) {
      const { Box, Text, Button } = $.ui.resolve(e)
      const figures: Held = { ...note, text: '' }
      let stats
      if (e.surface === 'desktop') {
        const width = Math.max(280, Math.min(680, e.props.bodyColumns * 8 - 32))
        stats = $.ui.resolve(e).Svg({ source: compactStatsSvg(figures, light, width), alt: statsAlt(figures), width, height: 44 })
      } else {
        const cells = Math.max(6, Math.min(24, Math.floor((e.props.bodyColumns - 40) / 2)))
        const [coldFill, coldTrack] = bar(1, cells)
        const [warmFill, warmTrack] = bar(warmShare(figures), cells)
        stats = Box({ flexDirection: 'column', children: [
          Text({ children: [
            Text({ dimColor: true, children: ['Send it now  '] }),
            Text({ color: noColor ? undefined : 'claude', bold: true, children: [fmtUsd(figures.coldUsd).padEnd(8)] }),
            Text({ color: noColor ? undefined : 'claude', children: [coldFill] }),
            Text({ dimColor: true, children: [coldTrack, `  re-writes up to ${figures.tokens.toLocaleString('en-US')} tokens at ${figures.rate}`] }),
          ] }),
          Text({ children: [
            Text({ dimColor: true, children: ['A warm turn  '] }),
            Text({ color: noColor ? undefined : 'success', bold: true, children: [fmtUsd(figures.warmUsd).padEnd(8)] }),
            Text({ color: noColor ? undefined : 'success', children: [warmFill] }),
            Text({ dimColor: true, children: [warmTrack, '  what it would have cost'] }),
          ] }),
        ] })
      }
      const coldFor = s.lastRequestAt && isCold(s, now) ? ` · cold for ${fmtDuration(now - s.lastRequestAt - s.ttlMs)}` : ''
      notice.push(
        Box({ key: 'resume', flexDirection: 'column', borderStyle: 'round', borderColor: 'subtle', paddingX: 1, children: [
          Text({ wrap: 'truncate-end', children: [
            Text({ color: noColor ? undefined : 'claude', bold: true, children: ['CACHE WATCH'] }),
            Text({ dimColor: true, children: [' · '] }),
            Text({ bold: true, children: ['Resuming a cold chat'] }),
            Text({ dimColor: true, children: [coldFor] }),
          ] }),
          stats,
          Text({ wrap: 'wrap', children: [RESUME_TIP] }),
        ] }),
        Box({ key: 'resume-buttons', flexDirection: 'row', gap: 2, alignItems: 'center', children: [
          ...(s.coldCompact ? [Button({ key: 'resume-compact', label: 'Compact', onPress: () => { void compactFromResume($, s) } })] : []),
          Button({ key: 'resume-fresh', label: 'Start fresh', onPress: () => { void freshFromResume($) } }),
          Button({ key: 'resume-dismiss', label: 'Dismiss', plain: true, onPress: () => { void update($, resumed, () => null) } }),
        ] }),
      )
    }
    const text = rowText(s, now)
    if (!text || (s.deadline && now >= s.deadline)) return notice.length ? $.ui.resolve(e).Box({ flexDirection: 'column', children: [rest, ...notice] }) : rest
    const state = s.stopped ? 'stopped' : !s.lastRequestAt || s.compacted ? 'unknown' : isCold(s, now) ? 'cold' : 'warm'
    const color = noColor ? undefined : state === 'warm' ? 'success' : state === 'cold' ? (light ? '#c15f3c' : '#d97757') : undefined
    const { Box, Text } = $.ui.resolve(e)
    const asset = statusIcons[light ? 'light' : 'dark'][state === 'warm' || state === 'cold' ? state : 'neutral']
    const icon = noColor ? Text({ bold: true, children: ['[>]'] })
      : e.surface === 'terminal' ? $.ui.resolve(e).Image({ source: { png: asset.png }, columns: 3, rows: 1, alt: '[>]' })
      : e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: asset.svg, width: 18, height: 18, alt: 'Cache Watch' })
      : Text({ color, bold: true, children: ['[>]'] })
    // Separators are dim so the state and the figures carry the row.
    const dot = () => Text({ dimColor: true, children: [' · '] })
    const row = Box({ flexDirection: 'row', alignItems: 'center', gap: 1, children: [
      Box({ flexShrink: 0, children: [icon] }),
      Text({ wrap: 'truncate-end', children: [
        'cache-watch',
        dot(),
        Text({ color, bold: true, children: [state] }),
        ...text.split(' · ').flatMap(part => [dot(), part]),
      ] }),
    ] })
    const rows = footer === 'on' && footerSeen.surface === e.surface ? [] : [row]
    const paid = await read($, receipt)
    if (!paid || now - paid.at >= RECEIPT_MS) return rows.length || notice.length ? Box({ flexDirection: 'column', children: [rest, ...notice, ...rows] }) : rest
    // The paid write as a pill under the row: what the log line said, drawn where it can be styled.
    const shield = e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: shieldSvg(light), width: 16, height: 16, alt: 'Paid' })
      : Text({ color: noColor ? undefined : 'success', children: ['✓'] })
    const pill = Box({ key: 'receipt', flexDirection: 'row', alignItems: 'center', gap: 1, alignSelf: 'flex-start', borderStyle: 'round', borderColor: 'subtle', paddingX: 1, children: [
      Box({ flexShrink: 0, children: [shield] }),
      Text({ wrap: 'wrap', children: [
        receiptText(paid),
        ...(paid.note ? [Text({ dimColor: true, children: [` ${paid.note}`] })] : []),
        ...(paid.warmForMs > 0 ? [Text({ dimColor: true, children: [' /keepwarm off to stop'] })] : []),
      ] }),
    ] })
    return Box({ flexDirection: 'column', gap: 1, children: [rest, ...notice, pill, ...rows] })
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    // The band drew before the footer's first draw here, so redraw it once without its row.
    if (footerSeen.surface !== String(e.surface)) $.clock.after(0, () => { $.ui.invalidate('ui.render') })
    footerSeen.count++
    footerSeen.surface = String(e.surface)
    footerSeen.modes = e.props.modes
    if (footer === 'off' || !isBandSurface(e.surface)) return next(e)
    const label = footerLabel(s, await $.clock.now())
    if (!label) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const color = noColor ? undefined : label.state === 'warm' ? 'success' : label.state === 'cold' ? (light ? '#c15f3c' : '#d97757') : undefined
    const sep = label.sep === ' · ' ? Text({ dimColor: true, children: [' · '] }) : ' '
    const words = Text({ wrap: 'truncate-end', children: label.state
      ? ['cache ', Text({ color, bold: true, children: [label.state] }), sep, label.detail]
      : ['cache', sep, label.detail] })
    const rest = await next(e).catch(() => Box({ children: [] }))
    // No gap beside an empty set of labels: the footer's width is tight.
    return Box({ flexDirection: 'row', alignItems: 'center', gap: e.props.modes.length ? 1 : 0, children: [rest, words] })
  })

  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    if (!s.hasBand && isBandSurface(e.surface)) {
      s.hasBand = true
      $.ui.status(undefined)
      $.ui.invalidate('ui.render')
    }
    return r
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.hasBand = isBandSurface(e.surface) || await hasBandSurface($)
    // The row counts down to the cache going cold, so it redraws (or the status entry is rewritten) on a tick.
    $.clock.after(60 * 1000, () => { void tick($, s) })
    // Read even without a band yet: the desktop app attaches after session.start and draws one then.
    const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
    light = typeof theme === 'string' && theme.startsWith('light')
    noColor = Boolean(await $.env.get('NO_COLOR'))
    if (s.hasBand) $.ui.status(undefined)
    await readTtl($, s).catch(() => undefined)
    restore(s, await read($, snapshot), await $.session.id())
    const now = await seat($, s)
    await prune($, s, now)
    const saved = await $.store.get(deadlineKey(s))
    const savedEvery = await $.store.get(everyKey(s))
    const savedGuard = await $.store.get(KEY_GUARD)
    s.deadline = typeof saved === 'number' && saved > now ? saved : 0
    s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS && savedEvery < s.ttlMs ? savedEvery : PING_AFTER_MS
    s.guard = savedGuard === 'warn' ? 'warn' : 'refuse'
    s.always = await readAlways($, s)
    const savedFooter = await $.store.get(KEY_FOOTER)
    footer = savedFooter === 'off' ? 'off' : 'on'
    // Always means a default window at least, whatever the last session left behind.
    if (s.always) await armAlways($, s, now)
    // The classic start arms a restored window too, but a managed plugin above this tier may continue beneath it; arming twice leaves one timer.
    else if (s.deadline) await arm($, s)
    await sendQueued($, s)
    await $.command.register({
      name: 'keepwarm',
      description: `Keep the prompt cache warm: bare for ${fmtDuration(s.windowMs)}, a window such as 90m, always, off, or status (cache-watch)`,
      argumentHint: '[90m | always | off | status]',
      immediate: true,
    })
    await $.command.register({
      name: 'cache-watch',
      description: 'Prompt cache state, cold price and this session\'s cold writes; guard warn|refuse (cache-watch, the Mod)',
      argumentHint: '[status | preview | pay | compact | fresh | dismiss | guard warn | guard refuse | footer on|off]',
      immediate: true,
    })
    // The hook form of cache-tax ships a /cache-tax:status skill; both installed means two guards.
    const commands = await $.command.list()
    if (commands.some(c => c.name === 'cache-tax:status')) {
      $.ui.log('the hook form (cache-tax@claude-code-hooks) is also installed, so a cold send is warned about or refused twice. Uninstall it, or /cache-watch guard warn here.')
    }
    updateStatus($, s, now)
    return r
  })

  // On Team and Enterprise accounts a managed plugin seated above this tier handles classic.* and continues beneath it, so
  // nothing here is relied on alone: session.end carries the /clear, turn.step the compaction, and the engine's own figures
  // the resumed context. What arrives here refines that, once: a clear already ended is only seated, a seat is never redone.
  on('session.end', async ($, e, next) => {
    // Only the conversation this state sits in: after the classic start of the next one, the old id is history.
    if ((e.reason === 'clear' || e.reason === 'resume') && e.sessionId === s.sid) await endConversation($, s, e.reason)
    return next(e)
  })

  // Resume fields seed the guard before any turn of the resumed session has run.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    // A resumed or cleared conversation is not the one a ping in flight was sent for.
    outdate(s)
    // The conversation moved under this state without session.end reaching it: the payload names another id, or a
    // clear names none. One that already seated the new id (a command ran first) is left as it is.
    if (s.sid && (e.session_id === undefined ? e.source === 'clear' : e.session_id !== s.sid)) await endConversation($, s, e.source === 'clear' ? 'clear' : 'resume')
    // No session.start fires after /clear, so this is where always arms the new conversation.
    await reseat($, s)
    if (e.source === 'clear') {
      await release($)
      await update($, resumed, () => null)
      return r
    }
    const line = seedFromResume(s, e, await $.clock.now())
    if (line) {
      // A card above the prompt where a band draws; the desktop app's band arrives after this event, so wait before falling back.
      await update($, resumed, () => resumeNoteFrom(s, e.estimated_cache_write_usd))
      $.clock.after(RESUME_LOG_AFTER_MS, () => { void resumeFallback($, s, line) })
      // The resume note already showed this cold spell's price, so the first send goes straight through, never held.
      s.ackedAt = s.lastRequestAt
    }
    await remember($, s)
    // The seeded clock decides whether a restored or always window pings before the first turn: never when it is cold.
    await arm($, s)
    return r
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    await reseat($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'off') {
      const wasAlways = s.always
      await stop($, s, null, true)
      return { text: wasAlways ? 'keepwarm is off, and always is off for every session from its next turn' : 'keepwarm is off' }
    }
    if (words[0] === 'always') {
      s.always = true
      await $.store.set(KEY_ALWAYS, true)
      await armAlways($, s, now)
      const cold = isCold(s, now) ? `. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn` : ''
      return { text: `keepwarm always on: every session stays warm until ${fmtDuration(s.windowMs)} after its last turn; /keepwarm off turns it off for good${cold}` }
    }
    if (!words.length) {
      await startWindow($, s, s.windowMs, PING_AFTER_MS)
      return { text: armedText(s, now, s.windowMs) }
    }
    if (words[0] !== 'status') {
      const window = parseDuration(words[0])
      if (!window) return { text: 'keepwarm takes a window such as 6h or 90m, or always, off, or status' }
      // "every 2m" is a testing knob and lasts only for the window it was given with.
      let every = PING_AFTER_MS
      if (words[1] === 'every') {
        const period = parseDuration(words[2] ?? '')
        // A period of the cache's whole hour or more would fire only once the cache is already cold.
        if (period == null || period < MIN_PING_MS || period >= s.ttlMs) return { text: 'every takes a period from 1m to 59m' }
        every = period
      }
      await startWindow($, s, window, every)
      const rolls = s.always && (window < s.windowMs || every !== PING_AFTER_MS)
      return { text: armedText(s, now, window) + (rolls ? `. Always is on, so your next turn makes it at least ${fmtDuration(s.windowMs)} at one ping per ${fmtDuration(PING_AFTER_MS)}` : '') }
    }
    return { text: statusText(s, now) ?? 'keepwarm is off' }
  })

  on('command.run', { command: 'cache-watch' }, async ($, e) => {
    await reseat($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    // Keyboard twins of the card's buttons: the Code tab can drop a click while any mod's state write redraws the band.
    if (words[0] === 'fresh' && !(await read($, held)) && (await read($, resumed))) {
      // The resume card's Start fresh: nothing held, so it only clears, once this dispatch returns.
      $.clock.after(0, () => { void freshFromResume($) })
      return { text: 'cache-watch: starting fresh' }
    }
    if (words[0] === 'compact') {
      if (!s.coldCompact) return { text: 'cache-watch: compacting a cold send is off (the coldCompact option)' }
      const h = await read($, held)
      if (!h && !(await read($, resumed))) return { text: 'cache-watch: no message is on hold' }
      // Compacting waits on this dispatch, so it starts once the command returns.
      $.clock.after(0, () => { void (h ? compactAndSend($, s) : compactFromResume($, s)) })
      return { text: h ? 'cache-watch: compacting, then the held message goes out' : 'cache-watch: compacting' }
    }
    if (words[0] === 'dismiss') {
      if (!(await read($, resumed))) return { text: 'cache-watch: nothing to dismiss' }
      await update($, resumed, () => null)
      return { text: 'cache-watch: the resume note is closed' }
    }
    if (words[0] === 'pay' || words[0] === 'fresh') {
      if (!(await read($, held))) return { text: 'cache-watch: no message is on hold' }
      // A command hook may not submit a prompt or run a command (each would wait on this dispatch): do it once it returns.
      const act = words[0] === 'pay' ? () => payAndSend($, s) : () => startFresh($)
      $.clock.after(0, () => { void act() })
      return { text: words[0] === 'pay' ? 'cache-watch: the held message is sent; keepwarm arms once the write lands' : 'cache-watch: started fresh; your message is back in the box' }
    }
    if (words[0] === 'preview') {
      if (!s.hasBand) return { text: 'cache-watch: this surface draws no band, so there is no card to preview' }
      // Right after a reload no turn has named the model yet; the session knows it.
      if (!s.lastModel) s.lastModel = await $.session.model()
      await update($, held, () => ({ ...heldFrom(s, 'Where were we? Give me a 2 line recap.'), isPreview: true }))
      await update($, showStatus, () => false)
      return { text: 'cache-watch: the hold card is above the prompt box, with this session\'s numbers. Any button closes it.' }
    }
    if (words[0] === 'footer') {
      const seen = footerSeen.count
        ? `The footer has drawn ${footerSeen.count} times, last on ${footerSeen.surface}.`
        : 'The footer has not drawn in this session yet, so the status stays in the band.'
      if (!words[1]) return { text: `cache-watch: footer ${footer}. ${seen} /cache-watch footer on or off moves the status.` }
      if (words[1] !== 'on' && words[1] !== 'off') return { text: '/cache-watch footer takes on or off' }
      footer = words[1]
      await $.store.set(KEY_FOOTER, footer)
      $.ui.invalidate('ui.render')
      return { text: footer === 'on' ? `cache-watch: the status shows in the prompt footer. ${seen}` : 'cache-watch: the status is back in the band above the prompt.' }
    }
    if (words[0] === 'guard') {
      if (words[1] !== 'warn' && words[1] !== 'refuse') return { text: '/cache-watch guard takes warn or refuse' }
      s.guard = words[1]
      await $.store.set(KEY_GUARD, s.guard)
      return { text: s.guard === 'refuse' ? 'guard set to refuse once: a cold send is dropped with its price, the resend goes through' : 'guard set to warn: a cold send goes through with its price shown' }
    }
    return { text: card(s, now) }
  })

  // The message that pays. Only its first character is read.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' && !isRemote(e.origin)) return next(e)
    await reseat($, s)
    // The person moved on: the last receipt has been seen.
    if (await read($, receipt)) await update($, receipt, () => null)
    // The resume note has done its job once the person writes.
    if (await read($, resumed)) {
      // Where no band drew, a send inside the fallback's wait means the person never saw the price, so it can still be held.
      if (!s.hasBand) s.ackedAt = 0
      await update($, resumed, () => null)
    }
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    // Without the time of the last response nothing says whether the cache is cold: the price is shown once and the message goes through.
    if (s.resumedAt) {
      const cold = mayBeCold(s, now)
      s.resumedAt = 0
      if (cold && s.ctx >= BIG_TOKENS) $.ui.log(unknownText(s))
      return next(e)
    }
    // A message that comes in while a compaction runs goes out after it, in order.
    if (s.compacting && canHold(e.text, e.attachments)) {
      await enqueue($, s, e.text)
      return { drop: COMPACTING_DROP }
    }
    if (!isCold(s, now) || s.ctx < BIG_TOKENS) return next(e)
    // Nobody at a phone can choose on a card, so the cheap way out is taken for them. Only a timer can compact, and only between turns.
    if (s.coldCompact && isRemote(e.origin) && canHold(e.text, e.attachments) && !s.running && !s.compacting) {
      await enqueue($, s, e.text)
      $.clock.after(0, () => { void compactThenSend($, s, 'because it came from a remote session') })
      return { drop: COMPACTING_DROP }
    }
    if (s.ackedAt === s.lastRequestAt) {
      s.ackedAt = 0
      s.coldWritePending = true
      await release($)
      return next(e)
    }
    if (s.guard === 'warn') {
      if (s.hasBand) s.note = 'Your message went straight through, because the guard is set to warn.'
      else $.ui.log(`${guardText(s, now)} Sending anyway; keepwarm will hold the cache for ${fmtDuration(holdMs(s, now))} once it lands.`)
      s.coldWritePending = true
      await release($)
      return next(e)
    }
    if (!isAttended(e.origin)) {
      // The card's buttons draw on the terminal and the desktop app only: a phone, a schedule or another session could never press them.
      if (s.hasBand) s.note = isRemote(e.origin)
        ? 'Your message went straight through, because it came from a remote session, where the card can\'t show.'
        : 'Your message went straight through, because no one was at the prompt to choose on the card.'
      else $.ui.log(`${guardText(s, now)} Sending anyway, because no one at this prompt sent it; keepwarm will hold the cache for ${fmtDuration(holdMs(s, now))} once it lands.`)
      s.coldWritePending = true
      await release($)
      return next(e)
    }
    if (s.hasBand && !canHold(e.text, e.attachments)) {
      // No card can resend this one, and a block without a choice is what the card replaced: send it; the receipt shows the price.
      s.note = 'Your message went straight through, because a message with an image or an @file mention can\'t be held.'
      s.coldWritePending = true
      await release($)
      return next(e)
    }
    s.ackedAt = s.lastRequestAt
    if (s.hasBand) {
      await update($, held, () => heldFrom(s, e.text))
      await update($, showStatus, () => false)
      return { drop: HELD_DROP }
    }
    return { drop: `cache-watch: ${guardText(s, now)} Send it again to pay it, and keepwarm will then hold the cache for ${fmtDuration(holdMs(s, now))}. Or /clear and start from a note.` }
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      await reseat($, s)
      s.running = true
      // The off count when the turn's first request went out: an off after it wins over what the turn opens.
      if (e.index === 0) s.turnOffs = s.offs
      // A compaction leaves a summary where tens of messages were; a rewind takes a few off. A request over fewer than half the
      // last one's messages is read as a compaction, whether or not session.compact arrived. The context stays as it was, so
      // turn.complete still scores a cold write this turn paid against it before the live figure replaces it.
      if (e.messageCount * 2 < s.transcript) markCompacted(s)
      s.transcript = e.messageCount
      // Only a request sent before any compaction this turn saw can hold a cold write; what follows one is the summary.
      if (!s.compacted) s.steps++
      s.lastRequestAt = await $.clock.now()
    }
    const r = yield* next(e)
    // Each request's write is priced at its own prompt length's tier (Haiku 5.5 changes price at 100k), not the turn's sum.
    const u = r.usage
    if (!e.agentId && u && !s.compacted) {
      const price = priceOf(u.model || e.model, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
      const was = s.stepWrites ?? { tokens: 0, usd: 0, priced: true }
      s.stepWrites = { tokens: was.tokens + u.cache_creation_input_tokens, usd: was.usd + (price ? u.cache_creation_input_tokens * price[1] / 1e6 : 0), priced: was.priced && price != null }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    s.running = false
    // A main-thread turn warmed the cache, so nothing is held any more.
    await release($)
    // An off at any point in this turn wins over every window the turn would open; a host that raised no
    // step falls back to the count at completion.
    const offs = s.turnOffs ?? s.offs
    s.turnOffs = null
    const now = await $.clock.now()
    // A sleeping host may deliver this turn before the expired window's timer.
    if (s.deadline && now >= s.deadline) await stop($, s, null)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    // A turn aborted before it sent anything touched no cache, so it leaves the clock alone.
    if ((e.usage || !e.isAborted) && now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    const compacted = s.compacted
    s.compacted = false
    if (s.lastRequestAt) s.resumedAt = 0
    s.waitForTurn = false
    s.ackedAt = 0
    // Always covers any break up to the default window after a turn that reached the cache (a turn that failed before any
    // response touched nothing, and its cache may be cold): a window at least that long at the default period,
    // which brings back a stopped window and replaces a shorter one or a testing period. Another session's
    // /keepwarm off or /keepwarm always changes the shared switch, so every such turn reads it.
    if (e.usage) {
      const shared = await readAlways($, s)
      if (s.offs === offs) s.always = shared
      if (s.always) await armAlways($, s, now, offs)
    }
    const u = e.usage
    if (u) {
      if (u.model) s.lastModel = u.model
      const prev = s.ctx
      // A turn's usage is its responses summed, so a ten-step turn reports ten
      // reads of the context. The live window is the engine's figure; the sum
      // is only the fallback for a host that reports no tokens.
      const written = u.cache_creation_input_tokens
      const live = (await $.session.usage()).context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + written
      // A compaction since the last complete turn: what followed it is the summary, no cold write, so the turn is scored
      // on the requests before it alone. None before it leaves nothing to score, whatever the guard saw; requests before
      // it that reported no usage leave only the turn's total, an upper bound kept for a send the guard saw go cold.
      const writes = s.stepWrites
      const write = !compacted ? written : writes ? writes.tokens : s.steps && s.coldWritePending ? written : 0
      const full = prev > 20000 && write >= 0.5 * prev
      if (full || (s.coldWritePending && write > 0)) {
        // Priced per request when the steps reported usage; otherwise at the tier of the context the comeback re-sent.
        const price = priceOf(s.lastModel, prev || s.ctx)
        const usd = writes?.priced ? writes.usd : price ? write * price[1] / 1e6 : null
        s.misses.push({ at: now, tokens: write, usd })
        const hold = autoWindow(s, now, AUTO_WARM_MS)
        const extend = hold > 0 && s.deadline < now + hold && s.offs === offs
        if (extend) await startWindow($, s, hold, s.every, offs)
        if (s.hasBand) {
          const paid: Receipt = { tokens: write, usd, at: now, warmForMs: extend ? hold : 0, note: s.note }
          await update($, receipt, () => paid)
        } else {
          $.ui.log(`cold write of ${fmtTok(write)} tokens paid (${fmtUsd(usd)}).` +
            (extend ? ` Keeping the cache warm for ${fmtDuration(hold)} so it is not paid again today; /keepwarm off to stop.` : ''))
        }
      }
      // The send a compaction went ahead of: what it cost instead, for the person back at the desk.
      if (s.compactedFrom && s.hasBand) {
        const price = priceOf(s.lastModel, s.ctx)
        const paid: Receipt = { tokens: written, usd: price ? written * price[1] / 1e6 : null, at: now, warmForMs: 0, note: s.note }
        await update($, receipt, () => paid)
      }
    }
    s.compactedFrom = 0
    s.coldWritePending = false
    s.note = null
    s.stepWrites = null
    s.steps = 0
    await remember($, s)
    await arm($, s)
    // arm() redraws only while keepwarm is on; the cache clock restarts on every turn either way.
    if (!s.deadline) updateStatus($, s, now)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    // A precompute installs nothing, and a skip leaves the conversation as it was: the cache and its clock stand.
    // Between turns nothing is left to score, and the next turn's summary write is not a cold write.
    if (!e.agentId && e.trigger !== 'precompute' && r.skip === undefined) await afterCompact($, s)
    return r
  })

  // The new model has a cached prefix of its own: nothing is known about it until a turn, and a ping would pay its whole write.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const r = await next(e)
    s.lastModel = e.to_model
    s.ttlMs = e.cache_ttl === '5m' ? TTL_5M_MS : TTL_1H_MS
    s.ttlSource = 'the model switch'
    if (e.from_model !== e.to_model) {
      s.lastRequestAt = 0
      outdate(s)
      await arm($, s)
      await remember($, s)
    }
    return r
  })
}
