import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { Plugin, TestBody } from 'claude-code/testing'
import type { CommandRunInput, ConfigSetInput, ModelForkResult, On, PromptSubmitInput, RenderPropsOf, SessionStartInput, TurnCompleteInput, TurnUsage } from 'claude-code'

import { statusIcons } from '../hooks/status-icons'
import { COMPACTING_DROP, COMPACT_WAIT_MS, HELD_DROP, RESUME_LOG_AFTER_MS, autoWindow, bar, canHold, compactStatsSvg, fmtDuration, footerLabel, freshState, isRemote, parseCutoff, parseDuration, quoted, resetForClear, resolveTtl, restore, resumeNoteFrom, seedFromResume, statsSvg, warmShare } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN
const START = 1_000_000

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 500, model: 'claude-fable-5-1', ...over,
})

// TurnCompleteInput is a union on `reason`; the tests only drive the answered arm.
type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
let turns = 0
const turn = (over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', usage: usage(), ...over,
})

const run = (command: 'keepwarm' | 'cache-watch', args: string): CommandRunInput => ({
  command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

const prompt = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })
const themeChange = (value: string): ConfigSetInput => ({ key: 'theme', value, previous: 'dark', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })

type ForkAnswer = null | ModelForkResult | { read: number; write: number; out?: number; input?: number }

// The world beneath the mod: its store, the engine's answers, and a fork that
// replies from a script so each test decides what the cache looked like.
function world(on: On, forkAnswers: ForkAnswer[], opts: { compact?: () => { skip: string } | undefined; rateLimits?: () => Array<{ percentUsed: number }>; env?: Record<string, string>; store?: Map<string, unknown>; commands?: string[]; live?: { tokens?: number }; startedAt?: () => number; sid?: string | (() => string); model?: string | (() => string); bandText?: string; theme?: { value: string }; noColor?: boolean; denyTheme?: boolean; writtenTheme?: string; gate?: () => Promise<void>; steps?: TurnUsage[]; storeGate?: (op: 'get' | 'set' | 'delete', key: string) => Promise<void> } = {}) {
  if (opts.store) {
    const store = opts.store
    // A read takes its value first and is delivered after the gate, as a reply can arrive late.
    on('store.get', async ($, e) => { const value = store.get(e.key); await opts.storeGate?.('get', e.key); return { value } })
    on('store.set', async ($, e) => { await opts.storeGate?.('set', e.key); store.set(e.key, e.value); return { value: undefined } })
    on('store.delete', async ($, e) => { await opts.storeGate?.('delete', e.key); store.delete(e.key); return { value: undefined } })
    on('store.keys', () => ({ value: [...store.keys()] }))
  } else mock.store(on, {})
  const reads = { theme: 0, env: 0 }
  on('env.get', ($, e) => { if (e.name === 'NO_COLOR') reads.env++; return { value: e.name === 'NO_COLOR' && opts.noColor ? '1' : opts.env?.[e.name] } })
  on('config.list', () => {
    reads.theme++
    return { value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: opts.theme?.value ?? 'dark', provider: { plugin: 'engine', tier: 'core' }, isLocked: false }] }
  })
  on('config.set', ($, e) => opts.denyTheme ? { deny: 'theme locked' } : { value: opts.writtenTheme ?? e.value })
  const forks: number[] = []
  const status: Array<string | undefined> = []
  const logs: string[] = []
  const entered: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: typeof opts.sid === 'function' ? opts.sid() : opts.sid ?? 'S1' }))
  on('session.model', () => ({ value: (typeof opts.model === 'function' ? opts.model() : opts.model) ?? 'claude-fable-5-1' }))
  on('session.usage', () => ({ value: { startedAt: opts.startedAt?.() ?? START, context: { window: 1000000, tokens: opts.live?.tokens }, rateLimits: (opts.rateLimits?.() ?? []) as never } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: (opts.commands ?? []).map(name => ({ name, description: '', source: 'plugin' as const })) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    const u = opts.steps?.shift() ?? null
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: u }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: u }
  })
  on('prompt.submit', ($, e) => { entered.push(e.text); return { text: e.text } })
  on('session.compact', ($, e) => opts.compact?.() ?? { messages: e.messages?.length ? e.messages : [{ role: 'user' as const, text: 'summary', toolUses: [] }] })
  on('classic.SessionStart', () => ({}))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  // The footer stub draws its labels, so a test can see what a hook passed down.
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: [e.component === 'SessionMode' ? ['modes', ...e.props.modes].join(' & ') : opts.bandText ?? ''] }))
  on('model.fork', async () => {
    forks.push(forks.length)
    if (opts.gate) await opts.gate()
    const a = forkAnswers.shift()
    // Older Claude Code releases returned null instead of a failure object.
    if (a === null || a === undefined) return { value: null as unknown as ModelForkResult }
    if ('isAnswered' in a) return { value: a }
    const value: ModelForkResult = { isAnswered: true, text: 'warm', usage: { input_tokens: a.input ?? 2, output_tokens: a.out ?? 1, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } }
    return { value }
  })
  return { forks, status, logs, entered, reads }
}

const warm: ForkAnswer = { read: 200000, write: 0 }
// A ping that finds nothing to fork leaves the window waiting, with a wake at the cold mark and no further fork.
const nothing: ForkAnswer = { isAnswered: false, reason: 'nothing-to-fork' }
const busy: ForkAnswer = { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: usage() }

const bandProps: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 75,
  scroll: { offset: 0, bodyRows: 10 }, view: {},
}

describe('cache indicator', () => {
  test('redraws reuse session preferences and theme changes repaint immediately', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.warm.png })
    expect(w.reads).toEqual({ theme: 1, env: 1 })
    await $.config.set(themeChange('light'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.light.warm.png })
    await $.config.set(themeChange('dark'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.warm.png })
    expect(w.reads).toEqual({ theme: 1, env: 1 })
    expect(w.forks.length).toBe(0)
  })

  test('a denied theme change preserves the existing icon', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { denyTheme: true })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect((await $.config.set(themeChange('light'))).deny).toBe('theme locked')
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.warm.png })
  })

  test('the written theme wins over the requested value', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { writtenTheme: 'light' })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.config.set(themeChange('dark'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.light.neutral.png })
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: official cube follows state and theme with a text alternative`, async ($, on) => {
      const clock = mock.clock(on, { now: 10 * HOUR })
      const theme = { value: 'dark' }
      const w = world(on, [nothing], { theme })
      await $.session.start({ ...session, surface, isInteractive: true })
      await $.command.run(run('keepwarm', '3h'))
      const ui = await $.ui.mount({ plugin: 'cache-watch', surface, component: 'AbovePrompt', props: bandProps })
      const type = surface === 'terminal' ? 'Image' : 'Svg'
      const source = (variant: typeof statusIcons.dark) => surface === 'terminal' ? { png: variant.neutral.png } : variant.neutral.svg
      expect((await ui.find({ type }))?.props.source).toEqual(source(statusIcons.dark))
      expect((await ui.find({ type }))?.props.alt).toBe(surface === 'terminal' ? '[>]' : 'Cache Watch')
      if (surface === 'terminal') {
        expect((await ui.find({ type }))?.props.columns).toBe(3)
        expect((await ui.find({ type }))?.props.rows).toBe(1)
      }
      await $.turn.complete(turn())
      expect((await ui.find({ type }))?.props.source).toEqual(surface === 'terminal' ? { png: statusIcons.dark.warm.png } : statusIcons.dark.warm.svg)
      await $.config.set(themeChange('light'))
      await clock.advance(HOUR)
      expect((await ui.find({ type }))?.props.source).toEqual(surface === 'terminal' ? { png: statusIcons.light.cold.png } : statusIcons.light.cold.svg)
      expect((await ui.find({ type: 'Text', text: /^cold$/ }))?.props.color).toBe('#c15f3c')
      expect(w.forks.length).toBe(1)
      await $.command.run(run('keepwarm', 'off'))
      // cache-watch: with keepwarm off the row stays, showing the cache clock.
      expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/cold.*cold for 0m/)
    })

    test(`${surface}: NO_COLOR uses a bold text icon and uncolored state`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [], { noColor: true })
      await $.session.start({ ...session, surface, isInteractive: true })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '90m'))
      const ui = await $.ui.mount({ plugin: 'cache-watch', surface, component: 'AbovePrompt', props: bandProps })
      expect(await ui.find({ type: 'Image' })).toBe(undefined)
      expect(await ui.find({ type: 'Svg' })).toBe(undefined)
      expect((await ui.find({ type: 'Text', text: /^\[>\]$/ }))?.props.bold).toBe(true)
      expect((await ui.find({ type: 'Text', text: /^warm$/ }))?.props.color).toBe(undefined)
    })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: unknown, warm, cold and warm again agree with the card`, async ($, on) => {
      const clock = mock.clock(on, { now: 10 * HOUR })
      const w = world(on, [nothing], { bandText: 'other mod' })
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'cache-watch', surface, component: 'AbovePrompt', props: bandProps })
      expect(await ui.find({ text: 'cache-watch' })).toBe(undefined)
      await $.command.run(run('keepwarm', '3h'))
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
      expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/unknown.*waiting for the first turn/)
      await $.turn.complete(turn())
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
      expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/warm.*ping in 55m/)
      await clock.advance(HOUR)
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('#d97757')
      expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/cold.*cold now/)
      expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/state       COLD/)
      expect(w.forks.length).toBe(1)
      expect((await ui.find({ text: /^other mod$/ }))?.text).toBe('other mod')
      await $.turn.complete(turn())
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
      expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/state       warm/)
      expect(w.status.filter(Boolean)).toEqual([])
      await $.command.run(run('keepwarm', 'off'))
      // cache-watch: with keepwarm off the row stays, showing the cache clock.
      expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/warm.*goes cold in 1h00m/)
      expect(w.forks.length).toBe(1)
    })
  }

  test('cold resume, compaction and clear reset the row without a ping', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [], { store: new Map([['deadline:S1', 13 * HOUR]]) })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('#d97757')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/unknown.*after compaction/)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
    await $.classic.SessionStart({ source: 'clear' })
    expect(await ui.find({ text: 'cache-watch' })).toBe(undefined)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('window expiry hands the row to the cache clock and surveys retain their band', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { bandText: 'survey' })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '10m'))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    const survey = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, hasSurvey: true } })
    expect(await survey.find({ text: 'cache-watch' })).toBe(undefined)
    expect((await survey.find({ text: 'survey' }))?.text).toBe('survey')
    await clock.advance(10 * MIN)
    expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/warm.*goes cold in 50m/)
    expect(w.forks.length).toBe(0)
  })

  test('a warm resume restores green and ignores subagent cache activity', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [nothing], { store: new Map<string, unknown>([['deadline:S1', 13 * HOUR]]) })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 30 * 60, context_tokens: 200000 })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
    await $.turn.complete(turn({ agentId: 'worker' }))
    await $.session.compact({ trigger: 'manual', agentId: 'worker', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await clock.advance(30 * MIN)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('#d97757')
    expect(w.forks.length).toBe(1)
  })

  for (const surface of ['vscode', 'mobile', null] as const) {
    test(`${surface ?? 'headless'} keeps the plain status fallback`, async ($, on) => {
      mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start({ ...session, surface })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '90m'))
      expect(w.status.at(-1)).toBe('keepwarm 1h30m left · ping in 55m')
      expect(w.status.at(-1)).not.toMatch(/\x1b/)
      expect(w.forks.length).toBe(0)
    })
  }

  test('a warm ping keeps the green row and a cold read stops it neutrally', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, { read: 0, write: 200000 }])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await clock.advance(55 * MIN)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
    expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/last ping read 200k/)
    await clock.advance(55 * MIN)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/stopped.*cache was already gone/)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(2)
  })

  for (const failure of [
    { isAnswered: false, reason: 'api-error', status: 400, error: 'invalid_request', usage: usage() },
    { isAnswered: false, reason: 'empty-reply', usage: usage() },
    { isAnswered: false, reason: 'aborted', usage: usage() },
  ] satisfies ModelForkResult[]) {
    test(`structured fork failure ${failure.reason} stops without retrying`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [failure])
      await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '3h every 1m'))
      const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
      await clock.advance(MIN)
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
      expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/stopped/)
      await clock.advance(2 * HOUR)
      expect(w.forks.length).toBe(1)
    })
  }
})

describe('parse and format', () => {
  test('durations', async () => {
    expect(parseDuration('6h')).toBe(6 * HOUR)
    expect(parseDuration('90m')).toBe(90 * MIN)
    expect(parseDuration('2h30m')).toBe(150 * MIN)
    expect(parseDuration('soon')).toBe(null)
    expect(fmtDuration(150 * MIN)).toBe('2h30m')
    expect(fmtDuration(7 * MIN)).toBe('7m')
    expect(fmtDuration((15 * 24 + 9) * 60 * MIN)).toBe('15d 9h')
  })
})

describe('guard', () => {
  test('refuses a cold send once with the price, then lets the resend through', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    const first = await $.prompt.submit(prompt('hi'))
    expect(first.drop).toMatch(/cache-watch: the prompt cache went cold 2h00m ago\. Sending this re-writes up to 200,502 tokens at \$20\/MTok = \$4\.01/)
    expect(w.entered).toEqual([])
    const second = await $.prompt.submit(prompt('hi'))
    expect(second.drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
  })

  test('lets slash commands, warm sends and small contexts through', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(30 * MIN)
    await $.prompt.submit(prompt('warm one'))
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('/clear'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 20000 }) }))
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('small one'))
    expect(w.entered).toEqual(['warm one', '/clear', 'small one'])
  })

  test('warn mode shows the price and sends', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    const r = await $.command.run(run('cache-watch', 'guard warn'))
    expect(r.text).toMatch(/guard set to warn/)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    expect(w.entered).toEqual(['hi'])
    expect(w.logs.at(-1)).toMatch(/Sending anyway/)
  })

  test('a Remote Control send with no band goes through and logs the price', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    const first = await $.prompt.submit({ ...prompt('hi'), origin: { kind: 'bridge' } })
    expect(first.drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
    expect(w.logs.at(-1)).toMatch(/Sending anyway, because no one at this prompt sent it/)
  })

  test('a paid cold write is scored and arms keepwarm for three hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    expect(w.logs.at(-1)).toMatch(/cold write of 201k tokens paid \(\$4\.01\)\. Keeping the cache warm for 3h00m/)
    expect(w.status.at(-1)).toMatch(/^keepwarm 3h00m left · ping in 55m/)
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
    const card = await $.command.run(run('cache-watch', 'status'))
    expect(card.text).toMatch(/session     1 cold write paid, \$4\.01/)
    expect(card.text).toMatch(/keepwarm    on, 2h05m left/)
  })

  test('context comes from the live window, not the turn\'s summed usage', async ($, on) => {
    mock.clock(on, { now: START })
    const live: { tokens?: number } = {}
    const w = world(on, [], { live })
    await $.session.start(session)
    await $.turn.complete(turn())
    live.tokens = 100000
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 500000, cache_creation_input_tokens: 2000 }) }))
    const card = await $.command.run(run('cache-watch', 'status'))
    expect(card.text).toMatch(/context     100,000 tokens/)
    expect(card.text).toMatch(/0 cold writes paid/)
    // cache-watch: with keepwarm off, the status entry shows the cache clock.
    expect(w.status.at(-1)).toMatch(/^goes cold in/)
  })

  test('/clear forgets the context, the clock and the tally', async () => {
    const s = freshState()
    s.ctx = 200000
    s.lastRequestAt = START - 2 * HOUR
    s.ackedAt = s.lastRequestAt
    s.misses = [{ at: START, tokens: 200000, usd: 4 }]
    let cancelled = false
    s.pending = { cancel: () => { cancelled = true } }
    resetForClear(s)
    expect(s.ctx).toBe(0)
    expect(s.lastRequestAt).toBe(0)
    expect(s.ackedAt).toBe(0)
    expect(s.misses).toEqual([])
    expect(s.pending).toBe(null)
    expect(cancelled).toBe(true)
  })

  test('an unguarded full miss is scored too', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    const card = await $.command.run(run('cache-watch', 'status'))
    expect(card.text).toMatch(/1 cold write paid/)
    expect(w.status.at(-1)).toMatch(/^keepwarm 3h00m left/)
  })

  test('stays quiet after a compaction until the first new turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'old', toolUses: [] }] })
    await $.prompt.submit(prompt('after compact'))
    expect(w.entered).toEqual(['after compact'])
    const card = await $.command.run(run('cache-watch', 'status'))
    expect(card.text).toMatch(/reset by compaction/)
  })

  test('a cold resume seeds the guard before any turn and returns the estimate line', async () => {
    const s = freshState()
    const now = START
    const line = seedFromResume(s, { source: 'resume', model: 'claude-fable-5-1', context_tokens: 396113, seconds_since_last_response: 3 * 3600, prompt_cache_likely_expired: true, estimated_cache_write_usd: 7.92 }, now)
    expect(line).toMatch(/resuming cold\. The first message re-writes 396,113 tokens, about \$7\.92/)
    expect(s.ctx).toBe(396113)
    expect(s.lastRequestAt).toBe(now - 3 * HOUR)
    expect(seedFromResume(freshState(), { source: 'startup' }, now)).toBe(null)
    expect(seedFromResume(freshState(), { source: 'resume', context_tokens: 20000, prompt_cache_likely_expired: true }, now)).toBe(null)
  })

  test('warns once when the hook form is installed beside it', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { commands: ['cache-tax:status'] })
    await $.session.start(session)
    expect(w.logs.at(-1)).toMatch(/hook form .* is also installed/)
  })
})

describe('keepwarm', () => {
  test('pings 55 minutes after the last request, then again, and reports the read', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm])
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', '6h'))
    expect(r.text).toMatch(/keepwarm on for 6h00m/)
    await $.turn.complete(turn())
    await clock.advance(54 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/keepwarm 5h05m left · ping in 55m · last ping read 200k \$0\.05/)
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a new turn resets the countdown', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(15 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('stops when a ping reads cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 180000 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/keepwarm stopped: the ping read 0 and wrote 180k tokens \(\$3\.60\)/)
    await clock.advance(120 * MIN)
    expect(w.forks.length).toBe(1)
    const s = await $.command.run(run('keepwarm', 'status'))
    expect(s.text).toMatch(/stopped/)
  })

  test('stops when the engine returns null, a cold snapshot or an API error', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [null])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h'))
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/either the snapshot was cold or the API call failed/)
  })

  test('the window ends on its own, forgetting the every knob, and off cancels', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm, warm, warm], { store })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '3m every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(2)
    // cache-watch: with keepwarm off, the status entry shows the cache clock.
    expect(w.status.at(-1)).toMatch(/^(goes cold in|cold for) /)
    expect(store.has('every:S1')).toBe(false)
    expect(store.has('deadline:S1')).toBe(false)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(2)
    const off = await $.command.run(run('keepwarm', 'off'))
    expect(off.text).toBe('keepwarm is off')
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('the every knob lasts one window only', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(2 * MIN)
    expect(w.forks.length).toBe(2)
    await $.command.run(run('keepwarm', 'off'))
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(2)
    await $.command.run(run('keepwarm', '1h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(3)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(3)
  })

  test('a bare /keepwarm arms six hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', ''))
    expect(r.text).toMatch(/^keepwarm on for 6h00m, a ping 55m after each idle stretch/)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · ping in 55m')
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('always is remembered, arms every session start, and off ends it for good', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true], ['deadline:S1', START - MIN], ['every:S1', MIN]])
    const w = world(on, [warm], { store })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(store.has('every:S1')).toBe(false)
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(54 * MIN)
    expect(w.forks.length).toBe(1)
    const card = await $.command.run(run('cache-watch', ''))
    expect(card.text).toMatch(/keepwarm    on, 5h05m left · ping in 55m · last ping read 200k \$0\.05 \(always\)/)
    const off = await $.command.run(run('keepwarm', 'off'))
    expect(off.text).toBe('keepwarm is off, and always is off for every session from its next turn')
    expect(store.has('always')).toBe(false)
    // cache-watch: with keepwarm off, the status entry shows the cache clock.
    expect(w.status.at(-1)).toMatch(/^(goes cold in|cold for) /)
  })

  test('/keepwarm always sets the switch and arms now', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', 'always'))
    expect(r.text).toMatch(/^keepwarm always on: every session stays warm until 6h00m after its last turn/)
    expect(store.get('always')).toBe(true)
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
  })

  test('always rolls the window forward with each turn, so a long session never outlives it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [warm, warm], { store })
    await $.session.start(session)
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    // A turn five and a half hours in: a fixed window would end 30m later, before the first ping.
    await clock.advance(5 * HOUR + 30 * MIN)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 11 * HOUR + 30 * MIN)
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('the ping figure counts output tokens at the model\'s rate, Sonnet 5 priced as itself', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 0, out: 1000 }])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-sonnet-5' }) }))
    await clock.advance(55 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm 5h05m left · ping in 55m · last ping read 200k $0.05')
    const card = await $.command.run(run('cache-watch', ''))
    expect(card.text).toMatch(/cold cost   \$0\.80 to re-write it \(warm turn \$0\.04\)/)
    expect(card.text).toMatch(/break-even  up to 20 pings at the read rate cost one cold write, about 18h20m of idle at one ping per 55m/)
  })

  test('a partial write, a zero read, or a full write stops the loop; a ping\'s own few tokens do not', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 500 }, { read: 75000, write: 70000 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/^keepwarm 5h59m left · ping in 1m · last ping read 200k/)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 75k and wrote 70k tokens/)
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a ping that reads nothing stops the loop too', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 0 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 0 and wrote 0 tokens/)
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('the ping figure counts uncached input at the base rate', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 0, input: 50000, out: 1000 }])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-sonnet-5' }) }))
    await clock.advance(55 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm 5h05m left · ping in 55m · last ping read 200k $0.15')
  })

  test('the card states the break-even for Fable 5.1', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    const card = await $.command.run(run('cache-watch', ''))
    expect(card.text).toMatch(/break-even  up to 80 pings at the read rate cost one cold write, about 3d 1h of idle at one ping per 55m/)
  })

  test('/keepwarm on a cold session schedules no fork before a turn, and does after one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(15 * 24 * HOUR)
    const r = await $.command.run(run('keepwarm', ''))
    expect(r.text).toBe('keepwarm on for 6h00m. The cache is cold now, so the first ping comes 55m after the next turn')
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · cold now, first ping 55m after the next turn')
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(0)
    const card = await $.command.run(run('cache-watch', ''))
    expect(card.text).toMatch(/keepwarm    on, 4h59m left · cold now, first ping 55m after the next turn/)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm 4h59m left · ping in 55m')
    await clock.advance(54 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('the always switch on a cold resume schedules no fork before a turn, and does after one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', 'off'))
    await clock.advance(15 * 24 * HOUR)
    // The test kit cannot raise classic.SessionStart, so the cold state comes from the turn above and a second start arms the switch over it.
    store.set('always', true)
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · cold now, first ping 55m after the next turn')
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    const r = await $.command.run(run('keepwarm', 'always'))
    expect(r.text).toBe('keepwarm always on: every session stays warm until 6h00m after its last turn; /keepwarm off turns it off for good. The cache is cold now, so the first ping comes 55m after the next turn')
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a cold window expires and its testing period does not reach the next auto-window', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.command.run(run('keepwarm', '90m every 1m'))
    await clock.advance(90 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.has('every:S1')).toBe(false)
    // cache-watch: with keepwarm off, the status entry shows the cache clock.
    expect(w.status.at(-1)).toMatch(/^(goes cold in|cold for) /)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    await clock.advance(54 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a turn after sleep clears the expired period before the overdue timer runs', async ($, on) => {
    let now = START
    on('clock.now', () => ({ value: now }))
    on('clock.after', () => new Promise<{ value: void }>(() => {}))
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    now += 2 * HOUR
    await $.command.run(run('keepwarm', '90m every 1m'))
    now += 91 * MIN
    expect(store.get('every:S1')).toBe(MIN)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.has('every:S1')).toBe(false)
    expect(store.get('deadline:S1')).toBe(now + 3 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 3h00m left · ping in 55m')
    expect(w.forks.length).toBe(0)
  })

  test('subagent turns do not touch the timer', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    await $.turn.complete(turn({ agentId: 'a1' }))
    await clock.advance(15 * MIN)
    expect(w.forks.length).toBe(1)
  })
})

describe('store per session', () => {
  test('another session\'s window does not arm this one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:other', START + HOUR], ['every:other', MIN]])
    const w = world(on, [warm], { store, sid: 'mine' })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe(undefined)
    const r = await $.command.run(run('keepwarm', 'status'))
    expect(r.text).toBe('keepwarm is off')
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.get('deadline:other')).toBe(START + HOUR)
    expect(store.get('every:other')).toBe(MIN)
  })

  test('this session\'s own window is restored on start', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:mine', START + 2 * HOUR], ['every:mine', MIN]])
    const w = world(on, [warm], { store, sid: 'mine' })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 2h00m left · waiting for the first turn')
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a window that lapsed less than a week ago is left for its own session', async ($, on) => {
    const now = START + 30 * 24 * HOUR
    mock.clock(on, { now })
    const store = new Map<string, unknown>([['deadline:recent', now - HOUR], ['every:recent', MIN]])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:recent', 'every:recent'])
  })

  test('/keepwarm off deletes only this session\'s keys', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:other', START + HOUR], ['every:other', MIN], ['always', true], ['guard', 'warn']])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h every 1m'))
    expect(store.get('deadline:mine')).toBe(START + HOUR)
    expect(store.get('every:mine')).toBe(MIN)
    await $.command.run(run('keepwarm', 'off'))
    expect(store.has('deadline:mine')).toBe(false)
    expect(store.has('every:mine')).toBe(false)
    expect(store.has('always')).toBe(false)
    expect(store.get('deadline:other')).toBe(START + HOUR)
    expect(store.get('every:other')).toBe(MIN)
    expect(store.get('guard')).toBe('warn')
  })

  test('legacy bare keys are cleared on start; other sessions\' keys, live or dead, and the global switches stay', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([
      ['deadline:old1', START - 8 * 24 * HOUR], ['every:old1', MIN],
      ['deadline:old2', 0],
      ['deadline', 0], ['every', MIN],
      ['deadline:live', START + HOUR], ['every:live', 2 * MIN],
      ['guard', 'warn'],
    ])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:old1', 'every:old1', 'deadline:old2', 'deadline:live', 'every:live', 'guard'])
  })

  test('this session\'s own dead window is cleared on start', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:mine', START - MIN], ['every:mine', MIN], ['deadline:other', START - MIN], ['every:other', MIN]])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:other', 'every:other'])
  })
})

describe('hold card', () => {
  const ask = 'Where were we? Give me a 2 line recap.'
  const isHeld = async (ui: { find: (q: { text: RegExp }) => Promise<unknown> }) => (await ui.find({ text: /Your message is on hold/ })) !== undefined
  // A band with room for the full card; bandProps (10 rows) gets the compact one.
  const tallBand = { ...bandProps, maxRows: 40 }

  test('a short band gets the compact card, with text bars and the buttons in view', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt(ask))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await ui.find({ text: /CACHE WATCH · Your message is on hold · cold for 2h00m/ })).toBeTruthy()
    // Desktop Text is proportional: the bars are one short Svg, never block glyphs in Text.
    const svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs.map(el => String(el.props.alt))).toEqual(['Send it now: $4.01, re-writes up to 200,502 tokens at $20/MTok. A warm turn: $0.05, what it would have cost.'])
    expect(svgs[0]?.props.height).toBe(44)
    expect(await ui.find({ text: /█|░/ })).toBe(undefined)
    expect(await ui.find({ key: 'pay' })).toBeTruthy()
  })

  test('/cache-watch pay and /cache-watch fresh do what the buttons do', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    const filled: string[] = []
    on('command.run', { command: 'clear' }, () => ({ text: '' }))
    on('prompt.fill', ($, e) => { filled.push(e.text); return { isFilled: true } })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    expect((await $.command.run(run('cache-watch', 'pay'))).text).toBe('cache-watch: no message is on hold')
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt(ask))
    expect((await $.command.run(run('cache-watch', 'pay'))).text).toMatch(/held message is sent/)
    await clock.advance(1)
    expect(w.entered).toEqual([ask])
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('second'))
    expect((await $.command.run(run('cache-watch', 'fresh'))).text).toMatch(/started fresh/)
    await clock.advance(1)
    expect(filled).toEqual(['second'])
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: a cold send waits on the card, and Pay and send resends it as the person's words and scores the write`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start({ ...session, surface, isInteractive: true })
      await $.turn.complete(turn())
      await clock.advance(3 * HOUR)
      const first = await $.prompt.submit(prompt(ask))
      expect(first.drop).toBe(HELD_DROP)
      expect(w.entered).toEqual([])
      const ui = await $.ui.mount({ plugin: 'cache-watch', surface, component: 'AbovePrompt', props: tallBand })
      expect(await isHeld(ui)).toBe(true)
      expect(await ui.find({ text: /CACHE WATCH/ })).toBeTruthy()
      expect(await ui.find({ text: /The prompt cache went cold 2h00m ago\./ })).toBeTruthy()
      expect(await ui.find({ text: /On hold: “Where were we\? Give me a 2 line recap\.”/ })).toBeTruthy()
      expect(await ui.find({ text: /keepwarm then holds the cache for 3h00m/ })).toBeTruthy()
      if (surface === 'desktop') {
        const alts = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.alt))
        expect(alts).toContain('Send it now: $4.01, re-writes up to 200,502 tokens at $20/MTok. A warm turn: $0.05, what it would have cost.')
      } else {
        expect(await ui.find({ text: /re-writes up to 200,502 tokens at \$20\/MTok/ })).toBeTruthy()
        expect(await ui.find({ text: /\$4\.01/ })).toBeTruthy()
      }
      expect((await ui.find({ key: 'pay' }))?.props.variant).toBe('primary')
      await ui.press({ key: 'pay' })
      expect(w.entered).toEqual([ask])
      expect(await isHeld(ui)).toBe(false)
      await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
      // The paid write shows as a pill in the band, not a log line.
      expect(await ui.find({ text: /Cold write paid: \$4\.00 for 200k tokens\. Keepwarm holds the cache for 3h00m\./ })).toBeTruthy()
      expect(w.logs.some(line => /cold write of/.test(line))).toBe(false)
      await $.prompt.submit(prompt('next'))
      expect(await ui.find({ key: 'receipt' })).toBe(undefined)
    })
  }

  test('Start fresh clears the conversation and puts the message back in the box', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    const commands: string[] = []
    const filled: string[] = []
    on('command.run', { command: 'clear' }, ($, e) => { commands.push(e.command); return { text: '' } })
    on('prompt.fill', ($, e) => { filled.push(e.text); return { isFilled: true } })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt(ask))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tallBand })
    await ui.press({ key: 'fresh' })
    expect(commands).toEqual(['clear'])
    expect(filled).toEqual([ask])
    expect(w.entered).toEqual([])
    expect(await isHeld(ui)).toBe(false)
  })

  test('Show cache status opens the details inside the card and closes them again', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt(ask))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: tallBand })
    expect(await ui.find({ key: 'status-card' })).toBe(undefined)
    await ui.press({ key: 'status' })
    expect(String((await ui.find({ key: 'status-card' }))?.props.text)).toMatch(/state\s+COLD/)
    expect((await ui.find({ key: 'status' }))?.props.label).toBe('Hide cache status')
    await ui.press({ key: 'status' })
    expect(await ui.find({ key: 'status-card' })).toBe(undefined)
    expect(await isHeld(ui)).toBe(true)
  })

  test('sending again still pays, and clears the card', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tallBand })
    expect(await isHeld(ui)).toBe(true)
    const second = await $.prompt.submit(prompt('hi'))
    expect(second.drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
    expect(await isHeld(ui)).toBe(false)
  })

  for (const [label, sent] of [['an @file mention', prompt('look at @README.md')], ['a pasted image', { ...prompt('what is this?'), attachments: [{ type: 'image' as const }] }]] as const) {
    test(`a message with ${label} goes through with the price, since no card can resend it`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
      await $.turn.complete(turn())
      await clock.advance(3 * HOUR)
      const first = await $.prompt.submit(sent)
      expect(first.drop).toBe(undefined)
      expect(w.entered).toEqual([sent.text])
      expect(w.logs).toEqual([])
      const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tallBand })
      expect(await isHeld(ui)).toBe(false)
      await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
      expect(await ui.find({ text: /Cold write paid: \$4\.00 for 200k tokens/ })).toBeTruthy()
      expect(await ui.find({ text: /Your message went straight through, because a message with an image or an @file mention can't be held\./ })).toBeTruthy()
    })
  }

  for (const [kind, note] of [['bridge', /because it came from a remote session, where the card can't show\./], ['scheduled-trigger', /because no one was at the prompt to choose on the card\./]] as const) {
    test(`a ${kind} send goes through with the price, since no one there can press the card`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
      await $.turn.complete(turn())
      await clock.advance(3 * HOUR)
      const first = await $.prompt.submit({ ...prompt('where were we?'), origin: { kind } })
      expect(first.drop).toBe(undefined)
      expect(w.entered).toEqual(['where were we?'])
      const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tallBand })
      expect(await isHeld(ui)).toBe(false)
      await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
      expect(await ui.find({ text: /Cold write paid: \$4\.00 for 200k tokens/ })).toBeTruthy()
      expect(await ui.find({ text: note })).toBeTruthy()
    })
  }

  for (const kind of ['sdk', 'unclassified'] as const) {
    test(`a ${kind} send is held like one typed at the prompt`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
      await $.turn.complete(turn())
      await clock.advance(3 * HOUR)
      const first = await $.prompt.submit({ ...prompt('hi'), origin: { kind } })
      expect(first.drop).toBe(HELD_DROP)
      expect(w.entered).toEqual([])
    })
  }

  test('a desktop host that attaches after session.start gets the band, not the status entry', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    on('session.surfaces', () => ({ value: [] }))
    on('session.attach', ($, e) => ({ clientId: e.clientId }))
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toMatch(/^goes cold in/)
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    expect(w.status.at(-1)).toBe(undefined)
    await clock.advance(3 * HOUR)
    const first = await $.prompt.submit(prompt(ask))
    expect(first.drop).toBe(HELD_DROP)
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tallBand })
    expect(await isHeld(ui)).toBe(true)
  })

  test('the first band drawn on a surface that never said it attached switches the band on', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    on('session.surfaces', () => ({ value: [] }))
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toMatch(/^goes cold in/)
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tallBand })
    expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/warm.*goes cold in 1h00m/)
  })

  test('/cache-watch preview shows the card with this session\'s numbers, and any button only closes it', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    const r = await $.command.run(run('cache-watch', 'preview'))
    expect(r.text).toMatch(/hold card is above the prompt box/)
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tallBand })
    expect(await isHeld(ui)).toBe(true)
    expect(await ui.find({ text: /Preview: nothing is held/ })).toBeTruthy()
    const alts = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.alt))
    expect(alts.some(alt => alt.startsWith('Send it now: $4.01'))).toBe(true)
    await ui.press({ key: 'pay' })
    expect(w.entered).toEqual([])
    expect(await isHeld(ui)).toBe(false)
  })

  test('the row shows the cache clock even with keepwarm off', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: tallBand })
    expect(await ui.find({ text: /goes cold in|cold for/ })).toBe(undefined)
    await $.turn.complete(turn())
    expect(await ui.find({ text: /cache-watch · warm · goes cold in 1h00m/ })).toBeTruthy()
    await clock.advance(90 * MIN)
    expect(await ui.find({ text: /cache-watch · cold · cold for 30m/ })).toBeTruthy()
  })

  test('helpers: hold rules, quoting, bar shares and the panel markup', async () => {
    expect(canHold('plain words', undefined)).toBe(true)
    expect(canHold('see @src/a.ts', undefined)).toBe(false)
    expect(canHold('email me at a@b.com', undefined)).toBe(true)
    expect(canHold('a picture', [{ type: 'image' }])).toBe(false)
    expect(quoted('two\nlines  here')).toBe('two lines here')
    expect(quoted('bell\u0007 zero​width \u001b[31mred\r\n')).toBe('bell zero width [31mred')
    expect(quoted('x'.repeat(400)).length).toBe(160)
    const h = { text: 'hi', tokens: 51929, rate: '$10/MTok', coldUsd: 0.52, warmUsd: 0.03 }
    expect(Math.abs(warmShare(h) - 0.0577) < 0.001).toBe(true)
    expect(warmShare({ ...h, warmUsd: null })).toBe(0.04)
    expect(bar(1, 10)).toEqual(['██████████', ''])
    expect(bar(0.01, 10)).toEqual(['█', '░░░░░░░░░'])
    const svg = statsSvg(h, false)
    expect(svg).toMatch(/^<svg /)
    expect(svg).toContain('$0.52')
    expect(svg).toContain('re-writes up to 51,929 tokens at $10/MTok')
    expect(svg.length).toBeLessThan(131072)
    expect(statsSvg({ ...h, rate: '<b>&' }, true)).toContain('at &lt;b&gt;&amp;</text>')
    // The compact Svg drops its captions first when the band is narrow.
    expect(compactStatsSvg(h, false, 680)).toContain('what it would have cost')
    expect(compactStatsSvg(h, false, 400)).not.toContain('what it would have cost')
    expect(compactStatsSvg(h, false, 400)).toContain('$0.52')
  })
})

const footerProps: RenderPropsOf['SessionMode'] = { modes: ['focus'] }

describe('footer label', () => {
  test("desktop: coloured state beside the app's labels, short enough for the footer", async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'SessionMode', props: footerProps })
    // No request yet: nothing to say, so the app's labels draw alone.
    expect(await ui.find({ type: 'Text', text: /^cache/ })).toBe(undefined)
    expect((await ui.find({ text: /^modes & focus$/ }))?.text).toBe('modes & focus')
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Text', text: /^cache/ }))?.text).toBe('cache warm · 1h00m left')
    expect((await ui.find({ type: 'Text', text: /^warm$/ }))?.props.color).toBe('success')
    expect((await ui.find({ text: /^modes & focus$/ }))?.text).toBe('modes & focus')
    // The Code tab drops an Svg in the footer, so none is sent.
    expect(await ui.find({ type: 'Svg' })).toBe(undefined)
    await clock.advance(HOUR + 6 * MIN)
    // A cold cache redraws every 5 minutes, so the figure can trail the clock.
    expect((await ui.find({ type: 'Text', text: /^cache/ }))?.text).toMatch(/^cache cold for [56]m$/)
    expect((await ui.find({ type: 'Text', text: /^cold$/ }))?.props.color).toBe('#d97757')
  })

  test('keepwarm shows its time left, with no state until the first turn', async ($, on) => {
    mock.clock(on, { now: 10 * HOUR })
    world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'SessionMode', props: footerProps })
    await $.command.run(run('keepwarm', '3h'))
    expect((await ui.find({ type: 'Text', text: /^cache/ }))?.text).toBe('cache · keepwarm 3h00m')
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Text', text: /^cache/ }))?.text).toBe('cache warm · 3h00m left')
  })

  test('every label fits in 24 characters, the longest windows and cold spells included', () => {
    const now = 100 * HOUR
    const texts: string[] = []
    // An age of null is a session with no request yet.
    for (const age of [null, 0, 59 * MIN, HOUR + 59 * MIN, 23 * HOUR + 59 * MIN]) {
      for (const left of [0, 59 * MIN, 9 * HOUR + 59 * MIN]) {
        for (const stopped of [null, 'the ping failed']) {
          const s = { ...freshState(), lastRequestAt: age === null ? 0 : now - age, deadline: left ? now + left : 0, stopped }
          const label = footerLabel(s, now)
          if (label) texts.push(label.state ? `cache ${label.state}${label.sep}${label.detail}` : `cache${label.sep}${label.detail}`)
        }
      }
    }
    expect(texts).toContain('cache warm · 9h59m left')
    expect(texts).toContain('cache warm · 1h00m left')
    expect(texts).toContain('cache cold for 22h59m')
    expect(texts).toContain('cache · keepwarm 9h59m')
    expect(texts).toContain('cache · keepwarm stopped')
    // A warm cache always says how long it has left; nothing says "cold in" any more.
    expect(texts.filter(text => text.startsWith('cache warm') && !text.endsWith(' left'))).toEqual([])
    expect(texts.filter(text => text.length > 24)).toEqual([])
  })

  test('the band drops its row once the footer draws, and footer off brings it back', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const store = new Map<string, unknown>()
    world(on, [], { store, bandText: 'other mod' })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    const band = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    // Until the footer has drawn here, the row stays, so a build without the footer keeps its status.
    expect((await band.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/warm.*goes cold in 1h00m/)
    const footer = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'SessionMode', props: footerProps })
    expect((await footer.find({ type: 'Text', text: /^cache/ }))?.text).toBe('cache warm · 1h00m left')
    // The footer's first draw redraws the band on the next tick.
    await clock.advance(1)
    expect(await band.find({ type: 'Text', text: 'cache-watch' })).toBe(undefined)
    expect((await band.find({ text: /^other mod$/ }))?.text).toBe('other mod')

    expect((await $.command.run(run('cache-watch', 'footer off'))).text).toBe('cache-watch: the status is back in the band above the prompt.')
    expect(store.get('footer')).toBe('off')
    expect((await band.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/warm.*goes cold in 1h00m/)
    expect(await footer.find({ type: 'Text', text: /^cache/ })).toBe(undefined)
    expect((await footer.find({ text: /^modes & focus$/ }))?.text).toBe('modes & focus')

    expect((await $.command.run(run('cache-watch', 'footer on'))).text).toMatch(/^cache-watch: the status shows in the prompt footer\. The footer has drawn \d+ times, last on desktop\.$/)
    expect(await band.find({ type: 'Text', text: 'cache-watch' })).toBe(undefined)
    expect((await $.command.run(run('cache-watch', 'footer loud'))).text).toBe('/cache-watch footer takes on or off')
  })

  test('footer off survives a new session', async ($, on) => {
    mock.clock(on, { now: 10 * HOUR })
    world(on, [], { store: new Map<string, unknown>([['footer', 'off']]) })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    expect((await $.command.run(run('cache-watch', 'footer'))).text).toBe('cache-watch: footer off. The footer has not drawn in this session yet, so the status stays in the band. /cache-watch footer on or off moves the status.')
  })
})

describe('resume card', () => {
  const tall = { ...bandProps, maxRows: 40 }
  const coldResume = { source: 'resume' as const, model: 'claude-opus-5-5', seconds_since_last_response: 13 * 24 * 3600, context_tokens: 230418, prompt_cache_likely_expired: true, estimated_cache_write_usd: 1.84 }

  test('desktop: a cold resume shows a card with the engine estimate instead of a log line, and Dismiss closes it', async ($, on) => {
    const clock = mock.clock(on, { now: 400 * HOUR })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tall })
    await $.classic.SessionStart(coldResume)
    expect((await ui.find({ type: 'Text', text: /Resuming a cold chat/ }))?.text).toBe('CACHE WATCH · Resuming a cold chat · cold for 12d 23h')
    const alts = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.alt))
    expect(alts.some(alt => /^Send it now: \$1\.84, re-writes up to 230,418 tokens at \$8\/MTok\. A warm turn: \$0\.05/.test(alt))).toBe(true)
    expect((await ui.find({ key: 'resume-fresh' }))?.props.label).toBe('Start fresh')
    await clock.advance(RESUME_LOG_AFTER_MS + 1)
    expect(w.logs.filter(line => line.startsWith('resuming cold'))).toEqual([])
    await ui.press({ key: 'resume-dismiss' })
    expect(await ui.find({ text: /Resuming a cold chat/ })).toBe(undefined)
  })

  test('terminal: the card draws text bars, and the status row stays under it', async ($, on) => {
    mock.clock(on, { now: 400 * HOUR })
    world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: tall })
    await $.classic.SessionStart(coldResume)
    expect(await ui.find({ type: 'Svg' })).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /^Send it now/ }))?.text).toMatch(/^Send it now {2}\$1\.84 +█+ +re-writes up to 230,418 tokens at \$8\/MTok$/)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.text).toBe('cold')
  })

  test('sending closes the note and goes straight through: the note already showed the price', async ($, on) => {
    mock.clock(on, { now: 400 * HOUR })
    world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tall })
    await $.classic.SessionStart(coldResume)
    expect((await ui.find({ type: 'Text', text: /consider starting a fresh chat/ }))?.text).toBe("A cold cache means the AI has to re-read everything in the session all over again. If the juice isn't worth the squeeze, consider starting a fresh chat.")
    const r = await $.prompt.submit(prompt('Where were we?'))
    expect(r.drop).toBe(undefined)
    expect(await ui.find({ text: /Resuming a cold chat/ })).toBe(undefined)
    expect(await ui.find({ text: /Your message is on hold/ })).toBe(undefined)
  })

  test('a dismissed note still counts as seen: the first send is not held', async ($, on) => {
    mock.clock(on, { now: 400 * HOUR })
    world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tall })
    await $.classic.SessionStart(coldResume)
    await ui.press({ key: 'resume-dismiss' })
    expect((await $.prompt.submit(prompt('Where were we?'))).drop).toBe(undefined)
    expect(await ui.find({ text: /Your message is on hold/ })).toBe(undefined)
  })

  test('a send before the plain line was logged is still held: the price was never shown', async ($, on) => {
    const clock = mock.clock(on, { now: 400 * HOUR })
    const w = world(on, [])
    await $.session.start(session)
    await $.classic.SessionStart(coldResume)
    const r = await $.prompt.submit(prompt('Where were we?'))
    expect(r.drop).toMatch(/^cache-watch: the prompt cache went cold/)
    await clock.advance(RESUME_LOG_AFTER_MS + 1)
    expect(w.logs.filter(line => line.startsWith('resuming cold'))).toEqual([])
  })

  test('Start fresh clears the conversation; /cache-watch fresh and dismiss are its twins', async ($, on) => {
    const clock = mock.clock(on, { now: 400 * HOUR })
    world(on, [])
    const commands: string[] = []
    on('command.run', { command: 'clear' }, ($, e) => { commands.push(e.command); return { text: '' } })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tall })
    await $.classic.SessionStart(coldResume)
    await ui.press({ key: 'resume-fresh' })
    expect(commands).toEqual(['clear'])
    expect(await ui.find({ text: /Resuming a cold chat/ })).toBe(undefined)

    await $.classic.SessionStart(coldResume)
    expect((await $.command.run(run('cache-watch', 'fresh'))).text).toBe('cache-watch: starting fresh')
    await clock.advance(1)
    expect(commands).toEqual(['clear', 'clear'])

    await $.classic.SessionStart(coldResume)
    expect((await $.command.run(run('cache-watch', 'dismiss'))).text).toBe('cache-watch: the resume note is closed')
    expect(await ui.find({ text: /Resuming a cold chat/ })).toBe(undefined)
    expect((await $.command.run(run('cache-watch', 'dismiss'))).text).toBe('cache-watch: nothing to dismiss')
  })

  test('a surface that never draws the band gets the plain line after a short wait', async ($, on) => {
    const clock = mock.clock(on, { now: 400 * HOUR })
    const w = world(on, [])
    await $.session.start(session)
    await $.classic.SessionStart(coldResume)
    expect(w.logs.filter(line => line.startsWith('resuming cold'))).toEqual([])
    await clock.advance(RESUME_LOG_AFTER_MS + 1)
    expect(w.logs.filter(line => line.startsWith('resuming cold'))).toEqual(["resuming cold. The first message re-writes 230,418 tokens, about $1.84. A cold cache means the AI has to re-read everything in the session all over again. If the juice isn't worth the squeeze, consider starting a fresh chat."])
  })

  test('the rate comes from the engine estimate when there is one, else the price table', () => {
    const s = { ...freshState(), ctx: 200000, lastModel: 'claude-opus-5-5' }
    expect(resumeNoteFrom(s, 1.6)).toEqual({ tokens: 200000, rate: '$8/MTok', coldUsd: 1.6, warmUsd: 0.04 })
    expect(resumeNoteFrom(s, undefined)).toEqual({ tokens: 200000, rate: '$8/MTok', coldUsd: 1.6, warmUsd: 0.04 })
  })
})

describe('prices', () => {
  for (const [model, cold, warmTurn, pings] of [
    ['claude-opus-5-5', '1.60', '0.04', 40],
    ['claude-opus-5', '2.00', '0.10', 20],
    ['claude-sonnet-5-5', '0.80', '0.02', 40],
    ['claude-haiku-5-5', '0.20', '0.01', 20],
    ['claude-mythos-5-1', '4.00', '0.05', 80],
    ['claude-opus-4-1-20250805', '6.00', '0.30', 20],
    ['claude-opus-4-20250514', '6.00', '0.30', 20],
    ['claude-opus-4@20250514', '6.00', '0.30', 20],
    ['claude-opus-4-1@20250805', '6.00', '0.30', 20],
    ['anthropic.claude-opus-4-1-20250805-v1:0', '6.00', '0.30', 20],
    ['claude-opus-4-1', '6.00', '0.30', 20],
    ['claude-opus-4-5-20251101', '2.00', '0.10', 20],
    ['claude-opus-4-5@20251101', '2.00', '0.10', 20],
    ['anthropic.claude-opus-4-5-20251101-v1:0', '2.00', '0.10', 20],
    ['claude-opus-4-8', '2.00', '0.10', 20],
    ['claude-3-5-haiku-20241022', '0.32', '0.02', 20],
  ] as const) {
    test(`${model} at 200k tokens is priced from its own row`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [], { live: { tokens: 200000 } })
      await $.session.start(session)
      await $.turn.complete(turn({ usage: usage({ model }) }))
      const card = await $.command.run(run('cache-watch', ''))
      expect(card.text).toMatch(`cold cost   $${cold} to re-write it (warm turn $${warmTurn})`)
      expect(card.text).toMatch(`break-even  up to ${pings} pings`)
    })
  }

  test('Haiku 5.5 up to 100k tokens takes the short-prompt row', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { live: { tokens: 100000 } })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: usage({ model: 'claude-haiku-5-5' }) }))
    const card = await $.command.run(run('cache-watch', ''))
    expect(card.text).toMatch('cold cost   $0.02 to re-write it (warm turn $0.00)')
  })
})

describe('keepwarm input', () => {
  for (const args of ['3h every 60m', '3h every 90m', '3h every 2h']) {
    test(`${args} is refused, since it would only fire on a cold cache`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [])
      await $.session.start(session)
      const r = await $.command.run(run('keepwarm', args))
      expect(r.text).toBe('every takes a period from 1m to 59m')
      expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    })
  }

  test('every 59m pings before the cache goes cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h every 59m'))
    await clock.advance(59 * MIN)
    expect(w.forks.length).toBe(1)
  })

  for (const args of ['0m', '0h', '0h0m']) {
    test(`a ${args} window is refused`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [])
      await $.session.start(session)
      const r = await $.command.run(run('keepwarm', args))
      expect(r.text).toBe('keepwarm takes a window such as 6h or 90m, or always, off, or status')
    })
  }

  test('a stored period of an hour or more falls back to 55m', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm], { store: new Map<string, unknown>([['deadline:S1', START + 3 * HOUR], ['every:S1', 90 * MIN]]) })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
  })
})

describe('always after /clear', () => {
  test('arms a fresh window under the new session id', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    const w = world(on, [warm], { store, sid: () => sid })
    await $.session.start(session)
    await $.turn.complete(turn())
    sid = 'S2'
    await $.classic.SessionStart({ source: 'clear' })
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.get('deadline:S2')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('without always, /clear leaves keepwarm off', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '3h'))
    await $.turn.complete(turn())
    await $.classic.SessionStart({ source: 'clear' })
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(0)
  })
})

describe('guard by origin', () => {
  for (const kind of ['bridge', 'slack-ping', 'auto-continuation', 'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'observer'] as const) {
    test(`a cold ${kind} prompt is sent and scored, and the next typed prompt is still refused`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start(session)
      await $.turn.complete(turn())
      await clock.advance(3 * HOUR)
      const r = await $.prompt.submit({ text: 'agent finished', wait: false, origin: { kind } })
      expect(r.drop).toBe(undefined)
      expect(w.entered).toEqual(['agent finished'])
      expect(w.logs.at(-1)).toMatch(new RegExp(`Sending anyway, because no one at this prompt sent it`))
      await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
      expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/session     1 cold write paid/)
      await $.command.run(run('keepwarm', 'off'))
      await clock.advance(3 * HOUR)
      expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/^cache-watch: the prompt cache went cold/)
    })
  }

  for (const origin of [
    { kind: 'sdk' }, { kind: 'unclassified' },
  ] satisfies PromptSubmitInput['origin'][]) {
    test(`a cold ${origin.kind} prompt, which a person may have sent, is refused like a typed one`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      world(on, [])
      await $.session.start(session)
      await $.turn.complete(turn())
      await clock.advance(3 * HOUR)
      expect((await $.prompt.submit({ text: 'hi', wait: false, origin })).drop).toMatch(/^cache-watch:/)
    })
  }
})

describe('ping failures', () => {
  test('after a restart with nothing to fork, the window waits for the next turn instead of stopping', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const store = new Map<string, unknown>([['deadline:S1', 13 * HOUR]])
    const w = world(on, [{ isAnswered: false, reason: 'nothing-to-fork' }, warm], { store })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 40 * 60, context_tokens: 200000 })
    await clock.advance(15 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('keepwarm 2h45m left · nothing to fork yet, first ping after the next turn')
    expect(store.get('deadline:S1')).toBe(13 * HOUR)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(1)
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/ping in 55m · last ping read 200k/)
  })

  for (const status of [429, 529, 500, null]) {
    test(`an API error ${status} is retried and the loop goes on once a ping lands`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [{ isAnswered: false, reason: 'api-error', status, error: 'rate_limit', usage: usage() }, warm, warm])
      await $.session.start(session)
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '3h'))
      await clock.advance(55 * MIN)
      expect(w.forks.length).toBe(1)
      expect(w.status.at(-1)).toBe('keepwarm 2h05m left · API busy, ping retry 1 of 3')
      await clock.advance(MIN)
      expect(w.forks.length).toBe(2)
      expect(w.status.at(-1)).toMatch(/ping in 55m · last ping read 200k/)
      await clock.advance(55 * MIN)
      expect(w.forks.length).toBe(3)
    })
  }

  test('a lasting 429 stops after two retries, before the cache goes cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [busy, busy, busy, busy])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(58 * MIN)
    expect(w.forks.length).toBe(3)
    expect(w.status.at(-1)).toBe('keepwarm stopped: the API call failed (429) after 2 retries')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(3)
  })

  test('a retry that would land within a minute of the cache going cold is not tried', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [busy])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h every 58m'))
    await clock.advance(58 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('keepwarm stopped: the API call failed (429)')
  })
})

describe('stale and late ping results', () => {
  // The tsconfig loads no DOM or Node types; the runtime has a real setTimeout to let a released fork finish.
  const realTimer = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }
  const settle = () => new Promise<void>(r => { realTimer.setTimeout(r, 20) })
  const gated = () => {
    let release = () => {}
    return { gate: () => new Promise<void>(r => { release = r }), release: () => release() }
  }

  test('a 429 that lands after a compaction schedules no retry', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const g = gated()
    const w = world(on, [busy], { gate: g.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    g.release()
    await settle()
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('keepwarm 2h00m left · waiting for the first turn after compaction')
  })

  test('a 429 that lands after /clear with always on leaves the new window alone', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    const g = gated()
    const w = world(on, [busy], { store, sid: () => sid, gate: g.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
    sid = 'S2'
    await $.classic.SessionStart({ source: 'clear' })
    g.release()
    await settle()
    expect(store.get('deadline:S2')).toBe(START + 55 * MIN + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
  })

  test('nothing to fork that lands after a turn does not hold the next ping', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const g = gated()
    const w = world(on, [nothing, warm], { gate: async () => { if (w.forks.length === 1) await g.gate() } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(55 * MIN)
    await $.turn.complete(turn())
    g.release()
    await settle()
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/ping in 55m · last ping read 200k/)
  })

  test('a retry whose timer fires inside the last minute is not sent', async ($, on) => {
    let now = START
    const timers: Array<() => void> = []
    on('clock.now', () => ({ value: now }))
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    const w = world(on, [busy, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    now += 55 * MIN
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('keepwarm 2h05m left · API busy, ping retry 1 of 3')
    // The host slept through the retry's one-minute slot and wakes 30 seconds before the cache goes cold.
    now += 4.5 * 60 * 1000
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('keepwarm stopped: the API call failed (429) after 1 retry')
  })
})

describe('price edge cases', () => {
  test('Claude Haiku 3.5 by display name takes the Haiku 3.5 row', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: usage({ model: 'Claude Haiku 3.5' }) }))
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch('cold cost   $0.32 to re-write it (warm turn $0.02)')
  })

  test('without step usage, a Haiku 5.5 comeback is priced at the tier of the context it re-sent', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await $.command.run(run('cache-watch', 'guard warn'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-haiku-5-5', cache_read_input_tokens: 0, cache_creation_input_tokens: 99000 }) }))
    await clock.advance(2 * HOUR)
    // Two requests summed: the 99k comeback write under 100k, then a step that crossed it.
    await $.turn.complete(turn({ usage: usage({ model: 'claude-haiku-5-5', cache_read_input_tokens: 0, cache_creation_input_tokens: 100500 }) }))
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/session     1 cold write paid, \$0\.02/)
  })
})

describe('per-request pricing and window extension', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  const haiku = (read: number, write: number) => usage({ model: 'claude-haiku-5-5', cache_read_input_tokens: read, cache_creation_input_tokens: write })
  const step = async ($: Parameters<TestBody>[0], index: number) => {
    for await (const c of $.turn.step({ turnId: 'comeback', index, model: 'claude-haiku-5-5', messageCount: 2 })) void c
  }

  test('a Haiku 5.5 comeback request over 100k is priced at the long tier though the context before was under it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { steps: [haiku(0, 101000)] })
    await $.session.start(session)
    await $.command.run(run('cache-watch', 'guard warn'))
    await $.turn.complete(turn({ usage: haiku(0, 99000) }))
    await clock.advance(2 * HOUR)
    await step($, 0)
    await $.turn.complete(turn({ usage: haiku(0, 101000) }))
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/session     1 cold write paid, \$0\.10/)
  })

  test('a Haiku 5.5 turn whose requests straddle 100k prices each write at its own tier', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { steps: [haiku(0, 99000), haiku(99000, 60000)] })
    await $.session.start(session)
    await $.command.run(run('cache-watch', 'guard warn'))
    await $.turn.complete(turn({ usage: haiku(0, 99000) }))
    await clock.advance(2 * HOUR)
    await step($, 0)
    await step($, 1)
    // 99,000 at $0.20 plus 60,000 at $1, against $0.16 for all at $1 or $0.03 for all at $0.20.
    await $.turn.complete(turn({ usage: haiku(99000, 159000) }))
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/session     1 cold write paid, \$0\.08/)
  })

  test('a ping out when /keepwarm extends the window still counts', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let release = () => {}
    const w = world(on, [warm, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { release = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
    await $.command.run(run('keepwarm', '6h'))
    release()
    await settle()
    expect(w.status.at(-1)).toMatch(/ping in 55m · last ping read 200k/)
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(2)
  })
})

describe('pings in flight', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  // Holds the first fork until released; later forks answer at once.
  const holdFirst = (w: () => { forks: number[] }) => {
    let release = () => {}
    const gate = async () => { if (w().forks.length === 1) await new Promise<void>(r => { release = r }) }
    return { gate, release: () => release() }
  }

  test('extending the window while a ping is out sends no second ping, and a cold reply then stops it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const h = holdFirst(() => w)
    const w = world(on, [{ read: 0, write: 200000 }, warm], { gate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(55 * MIN)
    await $.command.run(run('keepwarm', '6h'))
    await clock.advance(5 * 1000)
    expect(w.forks.length).toBe(1)
    h.release()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/keepwarm stopped: the ping read 0 and wrote 200k/)
  })

  test('a main request while a ping is out supersedes its cold reply', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const h = holdFirst(() => w)
    const w = world(on, [{ read: 0, write: 200000 }, warm], { gate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(55 * MIN)
    await clock.advance(MIN)
    for await (const c of $.turn.step({ turnId: 'next', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    h.release()
    await settle()
    expect(w.status.at(-1)).not.toMatch(/stopped/)
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/ping in 55m · last ping read 200k/)
  })

  test('a turn aborted before any request keeps the reply of a ping that was out', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const h = holdFirst(() => w)
    const w = world(on, [warm, warm], { gate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(55 * MIN)
    await clock.advance(MIN)
    await $.turn.complete(turn({ isAborted: true, usage: undefined }))
    h.release()
    await settle()
    expect(w.status.at(-1)).toMatch(/last ping read 200k/)
    // The next ping counts from the ping's own read, not from the aborted turn.
    await clock.advance(54 * MIN)
    expect(w.forks.length).toBe(2)
  })
})

describe('ping timing races', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a timer that fires while another ping waits on the clock never sends a second fork', async ($, on) => {
    let now = START
    let hold: Promise<void> | null = null
    let releaseClock = () => {}
    const timers: Array<() => void> = []
    on('clock.now', async () => {
      const h = hold
      hold = null
      if (h) await h
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    // Ping B's fork stays out until released, so it is in flight when A resumes.
    let releaseFork = () => {}
    const w = world(on, [warm, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { releaseFork = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    now += 55 * MIN
    // Ping A's clock read is held; the extension's own reads go through.
    hold = new Promise<void>(r => { releaseClock = r })
    timers.at(-1)?.()
    await settle()
    await $.command.run(run('keepwarm', '6h'))
    now += 1000
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    releaseClock()
    await settle()
    expect(w.forks.length).toBe(1)
    releaseFork()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/last ping read 200k/)
  })

  test('a superseded reply followed by an early timer still leaves the window armed', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let release = () => {}
    const w = world(on, [warm, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { release = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(55 * MIN)
    await $.command.run(run('keepwarm', '6h'))
    // A long tool call: the turn's first request lands, and the turn does not complete.
    for await (const c of $.turn.step({ turnId: 'long', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    release()
    await settle()
    await clock.advance(2 * 1000)
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(2)
  })
})

describe('retry after a window extension', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a 429 that lands after /keepwarm extends the window waits the full retry delay', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let release = () => {}
    const w = world(on, [busy, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { release = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(55 * MIN)
    await $.command.run(run('keepwarm', '6h'))
    release()
    await settle()
    expect(w.status.at(-1)).toMatch(/API busy, ping retry 1 of 3/)
    // The extension's one-second timer is gone; only the one-minute retry remains.
    await clock.advance(30 * 1000)
    expect(w.forks.length).toBe(1)
    await clock.advance(30 * 1000)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/last ping read 200k/)
  })
})

describe('one timer at a time', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a 429 that lands while /keepwarm is reading the clock leaves one live timer', async ($, on) => {
    let now = START
    let holdNext = false
    let releaseClock = () => {}
    const timers: Array<() => void> = []
    on('clock.now', async () => {
      if (holdNext) {
        holdNext = false
        await new Promise<void>(r => { releaseClock = r })
      }
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    // The extension writes its deadline, then arms; holding the next clock read pauses it inside arm().
    let watch = false
    class Store extends Map<string, unknown> {
      override set(key: string, value: unknown) {
        if (watch && key === 'deadline:S1') holdNext = true
        return super.set(key, value)
      }
    }
    let releaseFork = () => {}
    const w = world(on, [busy, busy, busy, warm], { store: new Store(), gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { releaseFork = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    now += 55 * MIN
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    const before = timers.length
    watch = true
    const extension = $.command.run(run('keepwarm', '6h'))
    await settle()
    releaseFork()
    await settle()
    releaseClock()
    await extension
    await settle()
    // Two timers were set since the first ping: the retry's, then the extension's. Fire the extension's at
    // one second and the retry's at its minute, a beat apart, as the host would; only a live timer may send.
    expect(timers.length - before).toBe(2)
    now += 1000
    timers[before + 1]?.()
    await settle()
    expect(w.forks.length).toBe(2)
    now += MIN
    timers[before]?.()
    await settle()
    expect(w.forks.length).toBe(2)
  })
})

describe('a paused ping yields to a newer schedule', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a ping paused on the clock does not send after a newer ping set a retry', async ($, on) => {
    let now = START
    let holdNext = false
    let releaseClock = () => {}
    const timers: Array<() => void> = []
    on('clock.now', async () => {
      if (holdNext) {
        holdNext = false
        await new Promise<void>(r => { releaseClock = r })
      }
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    const w = world(on, [busy, busy, busy, busy])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    now += 55 * MIN
    // Ping A pauses on its clock read.
    holdNext = true
    timers.at(-1)?.()
    await settle()
    // The extension sets timer B; B pings, gets a 429 and schedules a one-minute retry.
    await $.command.run(run('keepwarm', '6h'))
    now += 1000
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/API busy, ping retry 1 of 3/)
    releaseClock()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/API busy, ping retry 1 of 3/)
  })
})

describe('/clear overlapping /keepwarm', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a window armed while /clear is still running keeps a timer', async ($, on) => {
    let now = START
    let hold: Promise<void> | null = null
    const holdNextRead = () => {
      let release = () => {}
      hold = new Promise<void>(r => { release = r })
      return () => release()
    }
    const timers: Array<() => void> = []
    const waits: number[] = []
    on('clock.now', async () => {
      const h = hold
      hold = null
      if (h) await h
      return { value: now }
    })
    on('clock.after', ($, e) => new Promise<{ value: void }>(r => { waits.push(e.ms); timers.push(() => r({ value: undefined })) }))
    const w = world(on, [warm, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    now += 55 * MIN
    // Ping A fires and pauses on its clock read.
    const releaseA = holdNextRead()
    timers.at(-1)?.()
    await settle()
    // /clear stops the old window and pauses on its last clock read.
    const releaseClear = holdNextRead()
    const clearing = $.classic.SessionStart({ source: 'clear' })
    await settle()
    // /keepwarm arms a new window meanwhile; then /clear finishes.
    await $.command.run(run('keepwarm', '6h'))
    const beforeClearEnds = timers.length
    releaseClear()
    await clearing
    await settle()
    // /clear reset the state before it first awaited, so the window armed meanwhile kept its timer: the wake at the
    // deadline, since the new conversation has no request yet. Nothing is cancelled or set again when /clear ends.
    expect(timers.length).toBe(beforeClearEnds)
    expect(waits.at(-1)).toBe(6 * HOUR)
    // A wakes, finds the schedule changed and a timer in place, and sends nothing.
    releaseA()
    await settle()
    expect(w.forks.length).toBe(0)
    expect(timers.length).toBe(beforeClearEnds)
    // The first turn of the new conversation starts the pings as usual.
    await $.turn.complete(turn())
    now += 55 * MIN
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
  })
})

describe('always covers any break up to six hours', () => {
  const alwaysOn = () => new Map<string, unknown>([['always', true]])

  test('a window that stopped comes back on the next turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    const w = world(on, [{ read: 0, write: 200000 }, warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 0/)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 55 * MIN + 6 * HOUR)
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/ping in 55m · last ping read 200k/)
  })

  test('a shorter window and a testing period give way to six hours at 55m on the next turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '90m every 2m'))
    expect(store.get('every:S1')).toBe(2 * MIN)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(store.has('every:S1')).toBe(false)
    await clock.advance(54 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(MIN)
    expect(w.forks.length).toBe(1)
  })

  test('an expired window with a testing period rolls at 55m, not at its old period', async ($, on) => {
    let now = START
    on('clock.now', () => ({ value: now }))
    on('clock.after', () => new Promise<{ value: void }>(() => {}))
    const store = alwaysOn()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '90m every 1m'))
    now += 91 * MIN
    await $.turn.complete(turn())
    expect(store.has('every:S1')).toBe(false)
    expect(store.get('deadline:S1')).toBe(now + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · ping in 55m')
  })

  test('the window rolls in the conversation after /clear too', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    let sid = 'S1'
    world(on, [], { store, sid: () => sid })
    await $.session.start(session)
    sid = 'S2'
    await $.classic.SessionStart({ source: 'clear' })
    await clock.advance(5 * HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S2')).toBe(START + 11 * HOUR)
  })

  test('without always a turn never moves the deadline', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '90m'))
    await clock.advance(80 * MIN)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 90 * MIN)
    await clock.advance(10 * MIN)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    expect(w.forks.length).toBe(0)
  })
})

describe('/keepwarm off during a rolling turn', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('off wins over the window a finishing turn was opening', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let holdEveryDelete = false
    let release = () => {}
    const storeGate = async (op: 'get' | 'set' | 'delete', key: string) => {
      if (holdEveryDelete && op === 'delete' && key === 'every:S1') {
        holdEveryDelete = false
        await new Promise<void>(r => { release = r })
      }
    }
    const w = world(on, [warm, warm], { store, storeGate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    // The next turn's roll pauses while saving its window; /keepwarm off runs to the end meanwhile.
    holdEveryDelete = true
    const finishing = $.turn.complete(turn())
    await settle()
    expect((await $.command.run(run('keepwarm', 'off'))).text).toMatch(/^keepwarm is off/)
    release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.has('always')).toBe(false)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })
})

describe('always, from the PR review', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  const alwaysOn = () => new Map<string, unknown>([['always', true]])

  test('a longer window is kept, with its testing period reset to 55m', async ($, on) => {
    mock.clock(on, { now: START })
    const store = alwaysOn()
    world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    const r = await $.command.run(run('keepwarm', '48h every 2m'))
    expect(r.text).toMatch(/Always is on, so your next turn makes it at least 6h00m at one ping per 55m$/)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 48 * HOUR)
    expect(store.has('every:S1')).toBe(false)
  })

  test('a 48h window without a testing period is untouched by a turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    world(on, [], { store })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '48h'))
    await clock.advance(HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 48 * HOUR)
  })

  test('a turn that failed before any response does not open a window over a cold cache', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    // Back after the six-hour window ended; the first request fails for good, with no usage.
    await clock.advance(7 * HOUR)
    const before = w.forks.length
    await $.turn.complete(turn({ usage: undefined }))
    expect(store.has('deadline:S1')).toBe(false)
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(before)
  })

  test('the cold-write receipt prints with always on, and the guard promises six hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { store: alwaysOn() })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/keepwarm will then hold the cache for 6h00m\./)
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(w.logs.at(-1)).toBe('cold write of 200k tokens paid ($4.00).')
  })

  test('without always the receipt still offers three hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/keepwarm will then hold the cache for 3h00m\./)
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(w.logs.at(-1)).toMatch(/^cold write of 200k tokens paid \(\$4\.00\)\. Keeping the cache warm for 3h00m/)
  })

  test('/keepwarm off in another session stops this one rolling at its next turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    world(on, [], { store })
    await $.session.start(session)
    // Another session ran /keepwarm off: the shared switch is gone from the store.
    store.delete('always')
    await clock.advance(5 * HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
  })

  test('/keepwarm off that lands while the roll reads the clock wins', async ($, on) => {
    let now = START
    let skip = -1
    let release = () => {}
    on('clock.now', async () => {
      if (skip === 0) {
        skip = -1
        await new Promise<void>(r => { release = r })
      } else if (skip > 0) skip--
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(() => {}))
    const store = alwaysOn()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    now += 10 * MIN
    // The finishing turn reads the clock once, then the roll reads it again: hold that second read.
    skip = 1
    const finishing = $.turn.complete(turn())
    await settle()
    expect((await $.command.run(run('keepwarm', 'off'))).text).toMatch(/^keepwarm is off/)
    release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    expect(w.forks.length).toBe(0)
  })
})

describe('the shared always switch across a turn', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  const holdOnce = (op: 'get' | 'set' | 'delete', key: string) => {
    let armed = false
    let release = () => {}
    const gate = async (o: 'get' | 'set' | 'delete', k: string) => {
      if (armed && o === op && k === key) {
        armed = false
        await new Promise<void>(r => { release = r })
      }
    }
    return { gate, arm: () => { armed = true }, release: () => release() }
  }

  test('/keepwarm off while the turn reads the switch is not undone by the old value', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const h = holdOnce('get', 'always')
    const w = world(on, [warm], { store, storeGate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    h.arm()
    const finishing = $.turn.complete(turn())
    await settle()
    await $.command.run(run('keepwarm', 'off'))
    h.release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('/keepwarm off during a cold-writing turn also stops its three-hour auto-warm', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const h = holdOnce('get', 'always')
    const w = world(on, [warm], { store, storeGate: h.gate })
    await $.session.start(session)
    await $.command.run(run('cache-watch', 'guard warn'))
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    const before = w.forks.length
    h.arm()
    const finishing = $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    await settle()
    await $.command.run(run('keepwarm', 'off'))
    h.release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect(w.logs.at(-1)).toBe('cold write of 200k tokens paid ($4.00).')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(before)
  })

  test('always turned back on in another session reaches a session that saw it off', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    world(on, [], { store })
    await $.session.start(session)
    store.delete('always')
    await clock.advance(HOUR)
    await $.turn.complete(turn())
    expect((await $.command.run(run('cache-watch', ''))).text).not.toMatch(/\(always\)/)
    store.set('always', true)
    await clock.advance(HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 8 * HOUR)
  })
})

describe('/keepwarm off while a turn is running', () => {
  test('a cold write landing after the off does not reopen three hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/^cache-watch:/)
    await $.prompt.submit(prompt('hi'))
    // The paid resend's request is out when /keepwarm off runs, and its turn finishes after.
    for await (const c of $.turn.step({ turnId: 'comeback', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    await $.command.run(run('keepwarm', 'off'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.has('deadline:S1')).toBe(false)
    expect(w.logs.at(-1)).toBe('cold write of 200k tokens paid ($4.00).')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('without an off the same cold write still arms three hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await $.prompt.submit(prompt('hi'))
    for await (const c of $.turn.step({ turnId: 'comeback', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.get('deadline:S1')).toBe(START + 2 * HOUR + 3 * HOUR)
  })
})

describe('a managed plugin above the user tier', () => {
  // Team and Enterprise accounts seat a builtin plugin at the prepend tier whose classic.* and session.compact hooks
  // continue beneath the user tier, so the mod's own hooks on those events never run.
  const managed: Plugin = {
    name: 'managed-sec',
    tier: 'prepend',
    register(on) {
      on('classic.SessionStart', ($, e, next) => next.to(e, 'append'))
      on('session.compact', ($, e, next) => next.to(e, 'append'))
    },
  }
  const end = ($: Parameters<TestBody>[0], sessionId: string, reason: 'clear' | 'resume' = 'clear') => $.session.end({ reason, sessionId, resume: { id: sessionId } })
  const step = async ($: Parameters<TestBody>[0], turnId: string, index: number, messageCount: number) => {
    for await (const c of $.turn.step({ turnId, index, model: 'claude-fable-5-1', messageCount })) void c
  }

  test('/clear reaches the mod through session.end: keepwarm stops, the tally empties and the new id is used', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    let started = START
    const w = world(on, [warm], { store, sid: () => sid, startedAt: () => started })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.get('deadline:S1')).toBe(START + 5 * HOUR)
    await end($, 'S1')
    sid = 'S2'
    started = clock.now()
    await $.classic.SessionStart({ source: 'clear' })
    expect(store.has('deadline:S1')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(0)
    const card = (await $.command.run(run('cache-watch', ''))).text
    expect(card).toMatch(/state       no request yet this session/)
    expect(card).toMatch(/session     0 cold writes paid/)
    await $.command.run(run('keepwarm', '2h'))
    expect(store.get('deadline:S2')).toBe(START + 4 * HOUR + 55 * MIN)
    expect(store.has('deadline:S1')).toBe(false)
  })

  test('always after /clear arms the new conversation under its own id', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    let started = START
    const w = world(on, [warm], { store, sid: () => sid, startedAt: () => started })
    await $.session.start(session)
    await $.turn.complete(turn())
    await end($, 'S1')
    sid = 'S2'
    started = clock.now()
    await $.classic.SessionStart({ source: 'clear' })
    expect(store.has('deadline:S1')).toBe(false)
    await $.prompt.submit(prompt('hello'))
    expect(store.get('deadline:S2')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
    expect(store.has('deadline:S1')).toBe(false)
  })

  test('a /clear delivered twice, through session.end and the classic start, arms always once', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    let started = START
    let sets = 0
    const w = world(on, [warm], { store, sid: () => sid, startedAt: () => started, storeGate: async (op, key) => { if (op === 'set' && key === 'deadline:S2') sets++ } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await end($, 'S1')
    sid = 'S2'
    started = clock.now()
    await $.classic.SessionStart({ source: 'clear' })
    expect(sets).toBe(1)
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.get('deadline:S2')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
    await $.prompt.submit(prompt('hi'))
    expect(sets).toBe(1)
    // The end of a conversation already left changes nothing.
    await end($, 'S1')
    expect(store.get('deadline:S2')).toBe(START + 6 * HOUR)
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a resumed session whose fields never arrive warns once with the price instead of refusing', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START + 3 * HOUR })
    const w = world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect(w.logs).toEqual([])
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/state       unknown, resumed without the time of its last response/)
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
    expect(w.logs).toEqual(['resumed with up to 200,000 tokens of context and no time of its last response, so the cache may be cold. If it is, this message re-writes them at $20/MTok = $4.00.'])
    await $.prompt.submit(prompt('again'))
    expect(w.logs.length).toBe(1)
    // The write it paid is still scored off the context the engine reported.
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(w.logs.at(-1)).toMatch(/^cold write of 200k tokens paid \(\$4\.00\)/)
  })

  test('a session first launched under an hour ago cannot be cold, so nothing is said', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START + 30 * MIN })
    const w = world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 1800, context_tokens: 200000 })
    await $.prompt.submit(prompt('hi'))
    expect(w.logs).toEqual([])
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/state       no request yet this session/)
  })

  test('a resumed transcript too young to be cold is warned about once it is old enough', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START + 30 * MIN })
    const w = world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 1800, context_tokens: 200000 })
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/state       resumed without the time of its last response, warm for up to 30m more/)
    await clock.advance(HOUR)
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/state       unknown, resumed without the time of its last response/)
    await $.prompt.submit(prompt('hi'))
    expect(w.logs.length).toBe(1)
    expect(w.logs[0]).toMatch(/^resumed with up to 200,000 tokens/)
  })

  test('with the resume fields delivered the guard prices the cold send and nothing is said twice', async ($, on) => {
    const clock = mock.clock(on, { now: START + 3 * HOUR })
    const w = world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    await clock.advance(RESUME_LOG_AFTER_MS + 1)
    expect(w.logs.length).toBe(1)
    expect(w.logs[0]).toMatch(/^resuming cold/)
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.logs.length).toBe(1)
  })

  test('an in-process resume moves the guard to the new transcript and keeps the window', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    let started = START
    const live = { tokens: 200000 }
    const w = world(on, [], { store, sid: () => sid, startedAt: () => started, live })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.command.run(run('keepwarm', '3h'))
    await end($, 'S1', 'resume')
    sid = 'S2'
    started = clock.now() - 30 * MIN
    live.tokens = 80000
    await $.classic.SessionStart({ session_id: 'S2', source: 'resume', seconds_since_last_response: 1800, context_tokens: 80000 })
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe('keepwarm 3h00m left · waiting for the first turn')
    const card = (await $.command.run(run('cache-watch', ''))).text
    expect(card).toMatch(/context     80,000 tokens/)
    expect(card).toMatch(/session     0 cold writes paid/)
  })

  test('a restored window arms at session.start without the classic event', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:S1', START + 10 * MIN]])
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'startup' })
    expect(w.status.at(-1)).toBe('keepwarm 10m left · waiting for the first turn')
    await clock.advance(10 * MIN)
    expect(w.status.at(-1)).toBe(undefined)
    expect(store.has('deadline:S1')).toBe(false)
  })

  test('the classic start arriving after session.start leaves one timer and one ping', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:S1', START + 3 * HOUR]])
    const w = world(on, [warm, warm], { store })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'startup' })
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a compaction that never reaches the mod is read off the next request\'s shorter transcript', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await step($, 'after', 0, 3)
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/state       reset by compaction/)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150000 }) }))
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe('goes cold in 1h00m')
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/session     0 cold writes paid/)
  })

  test('a summary written after a warm request in the same turn is no cold write', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { steps: [usage(), usage(), usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150000 })] })
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await step($, 'long', 0, 42)
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await step($, 'long', 1, 3)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 200000, cache_creation_input_tokens: 150500 }) }))
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe('goes cold in 1h00m')
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/session     0 cold writes paid/)
  })

  test('a rewind of a few messages is not a compaction', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await step($, 'rewound', 0, 38)
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/state       warm/)
  })

  test('a cold write and a compaction in the same turn still score the write', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { steps: [usage(), usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }), usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 10000 })] })
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await step($, 'comeback', 0, 42)
    await step($, 'comeback', 1, 3)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 210000 }) }))
    expect(w.logs.at(-1)).toMatch(/^cold write of 200k tokens paid \(\$4\.00\)/)
  })

  test('a classic clear after a command already seated the new conversation leaves its window alone', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    const w = world(on, [], { store, sid: () => sid })
    await $.session.start(session)
    await $.turn.complete(turn())
    await end($, 'S1')
    sid = 'S2'
    await $.command.run(run('keepwarm', '2h'))
    expect(store.get('deadline:S2')).toBe(START + 2 * HOUR)
    await $.classic.SessionStart({ session_id: 'S2', source: 'clear' })
    expect(store.get('deadline:S2')).toBe(START + 2 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 2h00m left · waiting for the first turn')
  })

  test('a model switched at an in-process resume prices the new transcript', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START + 3 * HOUR })
    let sid = 'S1'
    let model = 'claude-fable-5-1'
    const w = world(on, [], { sid: () => sid, model: () => model, live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await end($, 'S1', 'resume')
    sid = 'S2'
    model = 'claude-haiku-5-5'
    await $.classic.SessionStart({ session_id: 'S2', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    await $.prompt.submit(prompt('hi'))
    expect(w.logs.at(-1)).toBe('resumed with up to 200,000 tokens of context and no time of its last response, so the cache may be cold. If it is, this message re-writes them at $1/MTok = $0.20.')
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/^claude-haiku-5-5\n/)
  })

  test('a classic resume ahead of the old conversation\'s end keeps the seeded clock', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let sid = 'S1'
    const w = world(on, [], { sid: () => sid, live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    sid = 'S2'
    await $.classic.SessionStart({ session_id: 'S2', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    await clock.advance(RESUME_LOG_AFTER_MS + 1)
    expect(w.logs.at(-1)).toMatch(/^resuming cold/)
    await end($, 'S1', 'resume')
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.logs.length).toBe(1)
  })

  test('a window carried through a resume moves to the new id, so off and the old session find the right keys', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    world(on, [], { store, sid: () => sid })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h every 2m'))
    expect(store.get('deadline:S1')).toBe(START + 3 * HOUR)
    await end($, 'S1', 'resume')
    sid = 'S2'
    await $.prompt.submit(prompt('hi'))
    expect([...store.keys()].sort()).toEqual(['deadline:S2', 'every:S2'])
    expect(store.get('deadline:S2')).toBe(START + 3 * HOUR)
    expect(store.get('every:S2')).toBe(2 * MIN)
    await $.command.run(run('keepwarm', 'off'))
    expect([...store.keys()]).toEqual([])
  })

  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  // Holds every delete of one key until released, in order, so two ends of the same conversation can be interleaved.
  const holdDeletes = (key: string) => {
    const waiting: Array<() => void> = []
    return {
      gate: async (op: 'get' | 'set' | 'delete', k: string) => { if (op === 'delete' && k === key) await new Promise<void>(r => { waiting.push(r) }) },
      release: () => waiting.shift()?.(),
      held: () => waiting.length,
    }
  }

  test('a session.end that lands while the classic resume is still deleting the old keys cannot wipe the seeded clock', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let sid = 'S1'
    const held = holdDeletes('deadline:S1')
    const w = world(on, [], { store: new Map<string, unknown>(), sid: () => sid, live: { tokens: 200000 }, storeGate: held.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    sid = 'S2'
    const resuming = $.classic.SessionStart({ session_id: 'S2', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    await settle()
    expect(held.held()).toBe(1)
    const ending = end($, 'S1', 'resume')
    await settle()
    held.release()
    await resuming
    held.release()
    await ending
    await clock.advance(RESUME_LOG_AFTER_MS + 1)
    expect(w.logs.length).toBe(1)
    expect(w.logs[0]).toMatch(/^resuming cold/)
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.logs.length).toBe(1)
  })

  test('an end cut short in its store cleanup has already dropped the old timer and id', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    const held = holdDeletes('deadline:S1')
    const w = world(on, [warm], { store, sid: () => sid, storeGate: held.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    const ending = end($, 'S1', 'resume')
    await settle()
    expect(held.held()).toBe(1)
    sid = 'S2'
    // The old conversation's ping is due while its end is still waiting on the store; the transcript it would fork is gone.
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(0)
    await $.prompt.submit(prompt('hi'))
    expect(store.get('deadline:S2')).toBe(START + 3 * HOUR)
    held.release()
    await ending
    expect(store.has('deadline:S1')).toBe(false)
  })

  test('a /keepwarm while the old conversation is still ending waits for the host to report the next id', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    let model = 'claude-fable-5-1'
    const held = holdDeletes('deadline:S1')
    const w = world(on, [], { store, sid: () => sid, model: () => model, storeGate: held.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '1h'))
    const ending = end($, 'S1')
    await settle()
    expect(held.held()).toBe(1)
    // The host still answers the old id: the window waits in memory, nothing is written under that id.
    expect((await $.command.run(run('keepwarm', '2h'))).text).toMatch(/^keepwarm on for 2h00m/)
    expect(store.get('deadline:S1')).toBe(START + HOUR)
    held.release()
    await ending
    expect(store.size).toBe(0)
    sid = 'S2'
    model = 'claude-haiku-5-5'
    await $.prompt.submit(prompt('hi'))
    expect([...store.keys()]).toEqual(['deadline:S2'])
    expect(store.get('deadline:S2')).toBe(START + 2 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 2h00m left · waiting for the first turn')
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/^claude-haiku-5-5\n/)
  })

  test('a guarded cold send compacted before its first request pays the summary, not a cold write', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { steps: [usage(), usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150000 })] })
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/^cache-watch:/)
    await $.prompt.submit(prompt('hi'))
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await step($, 'comeback', 0, 3)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150000 }) }))
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe('goes cold in 1h00m')
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/session     0 cold writes paid/)
  })

  test('a second compaction in one turn does not turn the first summary into a cold write', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START })
    const summary = usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 120000 })
    const w = world(on, [], { steps: [usage(), usage(), summary, usage(), summary] })
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await step($, 'long', 0, 42)
    await step($, 'long', 1, 3)
    await step($, 'long', 2, 15)
    await step($, 'long', 3, 3)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 200000, cache_creation_input_tokens: 241000 }) }))
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe('goes cold in 1h00m')
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/session     0 cold writes paid/)
  })
})

describe('precompute and refused compactions', () => {
  for (const [label, trigger, compact] of [
    ['a precompute', 'precompute', undefined],
    ['a skipped compaction', 'manual', () => ({ skip: 'jetcompact said no' })],
  ] as const) {
    test(`${label} leaves the cache clock, the footer and the pings as they were`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [warm], { compact })
      await $.session.start(session)
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '3h'))
      await clock.advance(10 * MIN)
      await $.session.compact({ trigger, messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
      expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/state       warm, 50m left/)
      await clock.advance(46 * MIN)
      expect(w.forks.length).toBe(1)
    })
  }

  test('a real compaction resets the state', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/state       reset by compaction/)
  })
})

describe('a reload of the mod', () => {
  test('puts back what it knew about the same conversation, and nothing about another', () => {
    const saved = { sid: 'S1', lastRequestAt: 5, lastModel: 'm', ctx: 7, compacted: false, ackedAt: 0, misses: [], last: null, stopped: null }
    const same = freshState()
    restore(same, saved, 'S1')
    expect(same.lastRequestAt).toBe(5)
    expect(same.ctx).toBe(7)
    const other = freshState()
    restore(other, saved, 'S2')
    expect(other.lastRequestAt).toBe(0)
    restore(other, null, 'S2')
    expect(other.lastRequestAt).toBe(0)
  })
})

describe('the cache lifetime', () => {
  const base = { force5m: false, enable1h: false, overLimit: false, thirdParty: false }
  test('follows the order of choice', () => {
    expect(resolveTtl({ ...base }).ms).toBe(HOUR)
    expect(resolveTtl({ ...base, overLimit: true }).ms).toBe(5 * MIN)
    expect(resolveTtl({ ...base, thirdParty: true }).ms).toBe(5 * MIN)
    expect(resolveTtl({ ...base, thirdParty: true, setting: '1h' }).ms).toBe(HOUR)
    expect(resolveTtl({ ...base, thirdParty: true, setting: '6h' }).ms).toBe(5 * MIN)
    expect(resolveTtl({ ...base, setting: '5m' }).ms).toBe(5 * MIN)
    expect(resolveTtl({ ...base, thirdParty: true, enable1h: true }).ms).toBe(HOUR)
    expect(resolveTtl({ ...base, setting: '1h', ttlEnv: '5m' }).ms).toBe(5 * MIN)
    expect(resolveTtl({ ...base, setting: '1h', force5m: true }).ms).toBe(5 * MIN)
    expect(resolveTtl({ ...base, messagesTtl: '5m' }).ms).toBe(5 * MIN)
  })

  test('a five-minute cache counts down five minutes and gets no ping', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm], { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', '3h'))).text).toMatch(/goes cold before a ping can reach it/)
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/lifetime    5m/)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(0)
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/state       COLD/)
  })

  test('a ping is not sent once the session went past its limits, since the cache dropped to five minutes', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let percentUsed = 50
    const w = world(on, [warm], { rateLimits: () => [{ percentUsed }] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    percentUsed = 100
    await clock.advance(56 * MIN)
    expect(w.forks.length).toBe(0)
  })

  test('a model switch stops the clock and the pings until a turn, since the new model has no cache of its own', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    on('classic.PostModelSwitch', () => ({}))
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'claude-opus-5-5', context_tokens: 1000, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 1, pricing: 'catalog' } as never)
    await clock.advance(56 * MIN)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    await clock.advance(56 * MIN)
    expect(w.forks.length).toBe(1)
  })
})

describe('window options', () => {
  test('parseCutoff reads a 24-hour time and nothing else', () => {
    expect(parseCutoff('21:30')).toBe(21 * 60 + 30)
    expect(parseCutoff(' 7:05 ')).toBe(7 * 60 + 5)
    for (const bad of ['', '24:00', '9pm', '21:60', null, undefined, 2130]) expect(parseCutoff(bad)).toBe(null)
  })

  test('autoWindow cuts at the cutoff and opens nothing from it until midnight', () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 31, h, m).getTime()
    const s = { cutoffMinutes: 21 * 60 }
    expect(autoWindow(s, at(12), 2 * HOUR)).toBe(2 * HOUR)
    expect(autoWindow(s, at(20), 2 * HOUR)).toBe(HOUR)
    expect(autoWindow(s, at(21), 2 * HOUR)).toBe(0)
    expect(autoWindow(s, at(23), 2 * HOUR)).toBe(0)
    expect(autoWindow({ cutoffMinutes: null }, at(23), 2 * HOUR)).toBe(2 * HOUR)
  })

  test('the always option arms the default window with no command, and rolls it', { options: { always: true, windowMinutes: 120 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    world(on, [], { store })
    await $.session.start(session)
    expect(store.get('deadline:S1')).toBe(START + 2 * HOUR)
    await clock.advance(HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 3 * HOUR)
  })

  test('/keepwarm off beats the always option in later sessions too', { options: { always: true } }, async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    world(on, [], { store })
    await $.session.start(session)
    await $.command.run(run('keepwarm', 'off'))
    expect(store.get('always')).toBe(false)
    await $.session.start(session)
    expect(store.get('deadline:S1')).toBe(undefined)
  })

  test('bare /keepwarm takes the default window', { options: { windowMinutes: 90 } }, async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    expect((await $.command.run(run('keepwarm', ''))).text).toMatch(/keepwarm on for 1h30m/)
  })

  test('past the cutoff always opens no window, while an explicit one is not cut', { options: { always: true, cutoffTime: '00:00' } }, async ($, on) => {
    mock.clock(on, { now: new Date(2026, 9, 31, 12).getTime() })
    const store = new Map<string, unknown>()
    world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(undefined)
    await $.command.run(run('keepwarm', '3h'))
    expect(typeof store.get('deadline:S1')).toBe('number')
  })
})

describe('compacting a cold send', () => {
  const cold = async ($: Parameters<TestBody>[0], clock: { advance(ms: number): Promise<unknown> }) => {
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
  }
  const relay = { kind: 'plugin', name: 'cc-relay' } as const

  test('isRemote covers Remote Control and the relay, and no other plugin', () => {
    expect(isRemote({ kind: 'bridge' })).toBe(true)
    expect(isRemote(relay)).toBe(true)
    expect(isRemote({ kind: 'plugin', name: 'cache-watch' })).toBe(false)
    expect(isRemote({ kind: 'composer' })).toBe(false)
  })

  for (const origin of [{ kind: 'bridge' }, relay] as const) {
    test(`a cold ${origin.kind} send compacts first, then goes out as the person's words, with no card`, { options: { coldCompact: true } }, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [])
      await cold($, clock)
      expect((await $.prompt.submit({ text: 'hi', wait: false, origin })).drop).toBe(COMPACTING_DROP)
      await clock.advance(1)
      expect(w.entered).toEqual(['hi'])
      expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/state       reset by compaction/)
      expect(w.logs.at(-1)).toMatch(/^compacted from 201k tokens before sending, because it came from a remote session/)
      const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
      expect(await ui.find({ text: /on hold/ })).toBe(undefined)
      await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 20000 }) }))
      expect(await ui.find({ text: /Compacted from 201k tokens first/ })).toBeTruthy()
      expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/session     0 cold writes paid/)
    })
  }

  test('an SDK session, with no $.session.compact, goes through /compact', { options: { coldCompact: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let compacts = 0
    const w = world(on, [], { compact: () => { throw new Error('not available in a headless session') } })
    on('command.run', { command: 'compact' }, () => { compacts++; return { text: '' } })
    await cold($, clock)
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'bridge' } })
    await clock.advance(1)
    expect(compacts).toBe(1)
    expect(w.entered).toEqual(['hi'])
  })

  test('a refused compaction still sends the message, and the write is scored', { options: { coldCompact: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { compact: () => ({ skip: 'below 25% minimum' }) })
    await cold($, clock)
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'bridge' } })
    await clock.advance(1)
    expect(w.entered).toEqual(['hi'])
    expect(w.logs.at(-1)).toMatch(/the compaction did not go through/)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/session     1 cold write paid/)
  })

  test('messages that arrive during the compaction follow it in order', { options: { coldCompact: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let open = () => {}
    const gate = new Promise<void>(r => { open = r })
    let calls = 0
    const w = world(on, [], { compact: () => { if (++calls === 1) throw new Error('not available in a headless session'); return undefined } })
    on('command.run', { command: 'compact' }, async () => { await gate; return { text: '' } })
    await cold($, clock)
    await $.prompt.submit({ text: 'first', wait: false, origin: { kind: 'bridge' } })
    await clock.advance(1)
    expect((await $.prompt.submit({ text: 'second', wait: false, origin: relay })).drop).toBe(COMPACTING_DROP)
    open()
    await clock.advance(1)
    expect(w.entered.slice(-2)).toEqual(['first', 'second'])
  })

  test('a remote send with an attachment cannot be resent, so it goes out cold', { options: { coldCompact: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await cold($, clock)
    expect((await $.prompt.submit({ text: 'look', wait: false, origin: { kind: 'bridge' }, attachments: [{ type: 'image' }] })).drop).toBe(undefined)
  })

  test('with the option off a remote send goes straight through, the relay\'s too, and is scored', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await cold($, clock)
    expect((await $.prompt.submit({ text: 'hi', wait: false, origin: relay })).drop).toBe(undefined)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/session     1 cold write paid/)
  })

  test('another plugin\'s prompt is not touched', { options: { coldCompact: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await cold($, clock)
    expect((await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'plugin', name: 'other' } })).drop).toBe(undefined)
  })

  test('Compact and send on the card, and its command twin', { options: { coldCompact: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await cold($, clock)
    await $.prompt.submit(prompt('from the desk'))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    await ui.press({ key: 'compact' })
    await clock.advance(1)
    expect(w.entered.at(-1)).toBe('from the desk')
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('again'))
    expect((await $.command.run(run('cache-watch', 'compact'))).text).toMatch(/compacting, then the held message/)
    await clock.advance(1)
    expect(w.entered.at(-1)).toBe('again')
  })

  test('no Compact button, and the command says why, with the option off', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await cold($, clock)
    await $.prompt.submit(prompt('hi'))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await ui.find({ key: 'compact' })).toBe(undefined)
    expect((await $.command.run(run('cache-watch', 'compact'))).text).toMatch(/the coldCompact option/)
  })

  test('Compact on the resume card closes it and sends nothing', { options: { coldCompact: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: 400 * HOUR })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: { ...bandProps, maxRows: 40 } })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    await ui.press({ key: 'resume-compact' })
    await clock.advance(1)
    expect(await ui.find({ text: /Resuming a cold chat/ })).toBe(undefined)
    expect(w.entered).toEqual([])
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/state       reset by compaction/)
  })
})

describe('a compaction that never answers', () => {
  test('the messages go out cold after the wait, and later sends are not held back', { options: { coldCompact: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { compact: () => { throw new Error('headless') } })
    on('command.run', { command: 'compact' }, () => new Promise<{ text: string }>(() => {}))
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'bridge' } })
    await clock.advance(1)
    expect(w.entered).toEqual([])
    await clock.advance(COMPACT_WAIT_MS)
    expect(w.entered).toEqual(['hi'])
    expect(w.logs.at(-1)).toBe('the compaction did not go through, so the message may have gone out cold.')
  })
})

describe('messages on their way past a compaction', () => {
  const start = async ($: Parameters<TestBody>[0], clock: { advance(ms: number): Promise<unknown> }) => {
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
  }
  const hung = () => { throw new Error('headless') }

  test('a message dropped for a compaction is stored until it is resent', { options: { coldCompact: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await start($, clock)
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'bridge' } })
    expect(store.get('queued:S1')).toEqual(['hi'])
    await clock.advance(1)
    expect(w.entered).toEqual(['hi'])
    expect(store.get('queued:S1')).toBe(undefined)
  })

  test('a start finds what a reload caught and sends it', { options: { coldCompact: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { store: new Map<string, unknown>([['queued:S1', ['lost in the reload']]]) })
    await $.session.start(session)
    await clock.advance(1)
    expect(w.entered).toEqual(['lost in the reload'])
  })

  test('a message with an attachment that arrives during a compaction is not queued, since a resend would lose it', { options: { coldCompact: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { compact: hung })
    on('command.run', { command: 'compact' }, () => new Promise<{ text: string }>(() => {}))
    await start($, clock)
    await $.prompt.submit({ text: 'first', wait: false, origin: { kind: 'bridge' } })
    await clock.advance(1)
    expect((await $.prompt.submit({ text: 'look', wait: false, origin: { kind: 'bridge' }, attachments: [{ type: 'image' }] })).drop).toBe(undefined)
  })

  test('a remote message into a running turn does not compact under it', { options: { coldCompact: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await start($, clock)
    expect((await $.prompt.submit({ text: 'hi', wait: false, turnId: 't', origin: { kind: 'bridge' } })).drop).toBe(undefined)
  })

  test('a message queued before a /clear still goes out, and its receipt notes stay behind', { options: { coldCompact: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let open = () => {}
    const gate = new Promise<void>(r => { open = r })
    let sid = 'S1'
    const w = world(on, [], { sid: () => sid, compact: hung, store: new Map<string, unknown>() })
    on('command.run', { command: 'compact' }, async () => { await gate; return { text: '' } })
    await start($, clock)
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'bridge' } })
    await clock.advance(1)
    sid = 'S2'
    await $.classic.SessionStart({ session_id: 'S2', source: 'clear' })
    open()
    await clock.advance(1)
    expect(w.entered).toEqual(['hi'])
    expect(w.logs.some(line => /compaction did not go through/.test(line))).toBe(false)
  })

  test('the lifetime goes to five minutes under an API key', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { env: { ANTHROPIC_API_KEY: 'test' } })
    await $.session.start(session)
    expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/lifetime    5m/)
  })
})
