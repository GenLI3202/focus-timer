import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run } from '../types'

const FOCUS_MIN = 25
const BREAK_MIN = 5
const MAX_MIN = 600
const MAX_LABEL = 80
const FOCUS_COLOR = '#E5694A'
const BREAK_COLOR = '#2FB67A'
const PAUSE_COLOR = '#9A9A96'
// Goal gradient (Hull 1934; Kivetz, Urminsky & Zheng 2006): effort rises as the goal nears, so the last fifth looks different.
const STRETCH_COLOR = '#E8A33D'
const STRETCH_AT = 0.8
// A day's target of rounds, drawn as dots that fill: progress toward a near, visible goal.
const DAY_GOAL = 4
// Every fourth round earns a longer break: longer breaks restore more (Albulescu et al. 2022).
const LONG_BREAK_MIN = 15
const INTENT_CLIP = 48
const RING = 2 * Math.PI * 32
// Micro-breaks raise vigor and lower fatigue (Albulescu et al. 2022): each break names one off-screen thing to do.
const BREAK_TIPS = [
  'Look at something 6 m away for 20 s',
  'Stand up and roll your shoulders',
  'Refill your water',
  'Walk to a window and back',
  'Close your eyes for a minute',
]

// Kept in the session's state, so a reload of the mod keeps the countdown. `now`
// is the last tick: writing it redraws the card once a second.
const run = atom({ plugin: 'focus-timer', key: 'run' } as const, null, { shape: 'run-1' })
const now = atom({ plugin: 'focus-timer', key: 'now' } as const, 0)
const rounds = atom({ plugin: 'focus-timer', key: 'rounds' } as const, { day: 0, count: 0, minutes: 0 }, { shape: 'rounds-2' })
// The next step written down before a break: a "ready-to-resume" plan (Leroy & Glomb 2018) lets the break be a real break,
// and it becomes the intention of the next round.
const parked = atom({ plugin: 'focus-timer', key: 'parked' } as const, '')
// Minutes of a round waiting for its intention; 0 when nothing is asked.
const asking = atom({ plugin: 'focus-timer', key: 'asking' } as const, 0)

const dayOf = (at: number): number => Math.floor((at - new Date(at).getTimezoneOffset() * 60_000) / 86_400_000)
const pad = (n: number): string => String(n).padStart(2, '0')
const mmss = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}
const clock = (at: number): string => {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const leftOf = (r: Run, at: number): number => (r.status === 'paused' ? r.pausedLeft : r.status === 'done' ? 0 : Math.max(0, r.endsAt - at))
const isStretch = (r: Run, left: number): boolean => r.kind === 'focus' && r.status === 'running' && 1 - left / r.total >= STRETCH_AT
const colorOf = (r: Run, left: number): string =>
  r.status === 'paused' ? PAUSE_COLOR : r.kind === 'break' ? BREAK_COLOR : isStretch(r, left) ? STRETCH_COLOR : FOCUS_COLOR
const dots = (count: number): string =>
  '●'.repeat(Math.min(count, DAY_GOAL)) + '○'.repeat(Math.max(0, DAY_GOAL - count)) + (count > DAY_GOAL ? ` +${count - DAY_GOAL}` : '')
const breakMinOf = (count: number): number => (count > 0 && count % DAY_GOAL === 0 ? LONG_BREAK_MIN : BREAK_MIN)
const clipText = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}

// An if-then plan beats a bare goal (Gollwitzer & Sheeran 2006, d = .65): a round with no label takes the
// parked next step, or else an outcome drawn from the last things asked, so it always has a concrete intention.
type Intention = { label: string; asks: string[] }

async function intentionOf($: EngineInterface): Promise<Intention> {
  const note = await read($, parked)
  if (note) {
    await setParked($, '')
    return { label: note, asks: [] }
  }
  const asks: string[] = []
  try {
    const all = await $.session.messages()
    if (Array.isArray(all)) {
      for (let i = all.length - 1; i >= 0 && asks.length < 3; i--) {
        const m = all[i] as { role: string; text: string }
        const t = m.role === 'user' ? m.text.trim() : ''
        if (t && !t.startsWith('<') && !t.startsWith('/') && !t.startsWith('[Request interrupted') && !t.startsWith('This session is being continued')) {
          asks.unshift(t.slice(0, 600))
        }
      }
    }
  } catch {
    // No transcript: the round runs unnamed.
  }
  return { label: asks.length ? outcomeOf(asks[asks.length - 1]) : '', asks }
}

// The instant guess, shown until the small model answers: a question becomes "find out ..." on its last clause.
const FILLER = /^(所以|那么|那|然后|好的|好|嗯|ok|okay|so|then|please|请|帮我|你)[，,\s]*/i
function outcomeOf(ask: string): string {
  let t = ask.replace(/\s+/g, ' ').trim()
  for (let k = 0; k < 3; k++) t = t.replace(FILLER, '')
  const isQuestion = /[?？]\s*$|[吗么呢]\s*[?？]?\s*$/.test(t)
  t = t.replace(/[?？。.!！\s]+$/, '')
  const clauses = t.split(/[，,；;]/).map(c => c.trim())
  const last = clauses[clauses.length - 1]
  if (clauses.length > 1 && last.length >= 6) t = last
  const cjk = /[\u4e00-\u9fff]/.test(t)
  return clipText(isQuestion ? (cjk ? `搞清楚：${t}` : `Find out: ${t}`) : t, INTENT_CLIP)
}

const INTENT_SYSTEM = `You turn a chat message into a focus intention for a 25-minute work round.
Write one short imperative phrase that names the outcome to reach, in the language of the message.
Chinese: at most 16 characters. English: at most 8 words. A question becomes the thing to find out or decide.
Output the phrase alone: no quotes, no trailing punctuation, no explanation.`

// The small model rewrites the guess into an outcome. It sees only these few asks, never the session, so the
// session's cache is untouched; the card keeps the guess when the call fails or the round has changed meanwhile.
async function refineIntention($: EngineInterface, asks: string[], guess: string) {
  if (asks.length === 0) return
  const prompt = asks.length > 1
    ? `Earlier messages, for context:\n${asks.slice(0, -1).map(a => `- ${a}`).join('\n')}\n\nLatest message:\n${asks[asks.length - 1]}`
    : asks[0]
  try {
    const r = await $.model.complete({ model: 'haiku', system: INTENT_SYSTEM, prompt, maxTokens: 60, timeoutMs: 10_000 })
    if (!r.isAnswered) return
    const label = clipText(r.text.replace(/^["'“”「」]+|["'“”「」。.!！?？]+$/g, ''), INTENT_CLIP)
    if (!label) return
    await update($, run, cur => (cur && cur.auto && cur.label === guess ? { ...cur, label } : cur))
  } catch {
    // Keep the guess.
  }
}

// Start a focus round named by `typed`, or else by the conversation; with neither, ask (resolves null).
async function startFocus($: EngineInterface, minutes: number, typed: string, mayAsk = true): Promise<string | null> {
  if (typed) {
    await startRun($, 'focus', minutes, typed)
    return typed
  }
  const intent = await intentionOf($)
  if (!intent.label && mayAsk) {
    await askIntention($, minutes)
    return null
  }
  await startRun($, 'focus', minutes, intent.label, intent.asks.length > 0)
  void refineIntention($, intent.asks, intent.label.slice(0, MAX_LABEL))
  return intent.label
}

async function rename($: EngineInterface, label: string) {
  await update($, run, cur => (cur ? { ...cur, label: label.slice(0, MAX_LABEL), auto: false } : cur))
}

async function setParked($: EngineInterface, note: string) {
  await update($, parked, () => note)
  await $.store.set('parked', note).catch(() => undefined)
}

async function startRun($: EngineInterface, kind: Run['kind'], minutes: number, label: string, auto = false) {
  await ensureTicker($)
  const at = await $.clock.now()
  const total = Math.min(MAX_MIN, Math.max(1, Math.round(minutes))) * 60_000
  await update($, asking, () => 0)
  await update($, run, () => ({ kind, label: label.slice(0, MAX_LABEL), total, endsAt: at + total, pausedLeft: total, status: 'running', auto }))
  await update($, now, () => at)
}

async function pauseRun($: EngineInterface) {
  const at = await $.clock.now()
  await update($, run, r => (r && r.status === 'running' ? { ...r, status: 'paused', pausedLeft: Math.max(0, r.endsAt - at) } : r))
  await update($, now, () => at)
}

async function resumeRun($: EngineInterface) {
  await ensureTicker($)
  const at = await $.clock.now()
  await update($, run, r => (r && r.status === 'paused' ? { ...r, status: 'running', endsAt: at + r.pausedLeft } : r))
  await update($, now, () => at)
}

async function stopRun($: EngineInterface) {
  await update($, run, () => null)
  await update($, asking, () => 0)
}

// Nothing to name the round from (a new session): ask first, with the command waiting in the box.
async function askIntention($: EngineInterface, minutes: number) {
  await update($, run, () => null)
  await update($, asking, () => minutes)
  $.clock.after(20, () => void $.prompt.fill({ text: `/focus ${minutes} ` }).catch(() => undefined))
}

// After a break: the next round starts from the parked step.
async function startNext($: EngineInterface) {
  await startFocus($, FOCUS_MIN, '')
}

async function addMinutes($: EngineInterface, minutes: number) {
  await ensureTicker($)
  const at = await $.clock.now()
  const extra = minutes * 60_000
  await update($, run, r => {
    if (!r || r.status === 'done') return r
    const total = r.total + extra
    return r.status === 'paused' ? { ...r, total, pausedLeft: r.pausedLeft + extra } : { ...r, total, endsAt: r.endsAt + extra }
  })
  await update($, now, () => at)
}

// Time is up: one more round for the day, a toast, and a system notification.
async function finish($: EngineInterface, r: Run, at: number) {
  await update($, run, cur => (cur && cur.status === 'running' ? { ...cur, status: 'done' } : cur))
  await update($, now, () => at)
  let count = (await read($, rounds)).count
  if (r.kind === 'focus') {
    const day = dayOf(at)
    const saved = await read($, rounds)
    count = (saved.day === day ? saved.count : 0) + 1
    const minutes = (saved.day === day ? saved.minutes : 0) + Math.round(r.total / 60_000)
    await update($, rounds, () => ({ day, count, minutes }))
    await $.store.set(`rounds:${day}`, count)
    await $.store.set(`minutes:${day}`, minutes)
  }
  const what = r.kind === 'focus' ? (r.label ? `Focus done: ${r.label}` : 'Focus done') : 'Break is over'
  $.ui.toast(r.kind === 'focus' ? `${what}. Round ${count} today.` : what)
  await $.process
    .run(['osascript', '-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Claude Code focus" sound name "Glass"', '-e', 'end run', what], { timeoutMs: 5000 })
    .catch(() => undefined)
}

// The card moves in 5-second steps: the time shown is the remaining time rounded up to
// the next 5 s, so it jumps every 5 s however often the timer wakes.
const STEP = 5000
const bucket = (left: number): number => Math.ceil(left / STEP)

let cancelTicker: (() => void) | null = null
let lastTickAt = 0
let lastBucket = -1
let lastCameo = ''

// One timer per loaded copy of the module. A press or a command starts it again when it has
// gone quiet (a timer the engine dropped), so the countdown never stays frozen.
async function ensureTicker($: EngineInterface) {
  const at = await $.clock.now()
  if (cancelTicker && at - lastTickAt < 3000) return
  cancelTicker?.()
  lastTickAt = at
  cancelTicker = $.clock.every(1000, () => void tick($).catch(() => undefined))
}

async function tick($: EngineInterface) {
  lastTickAt = await $.clock.now()
  const r = await read($, run)
  if (!r || r.status !== 'running') return
  const at = lastTickAt
  if (at >= r.endsAt) {
    await finish($, r, at)
    return
  }
  const b = bucket(r.endsAt - at)
  // A crab visit starts and ends on the second, not on the 5-second step.
  const visit = (await read($, crab)) ? cameoOf(r, r.endsAt - at, (await read($, rounds)).count, 0, at, await read($, quiet))?.key ?? '' : ''
  if (b === lastBucket && visit === lastCameo) return
  lastBucket = b
  lastCameo = visit
  await update($, now, () => at)
  $.ui.invalidate('ui.render')
}

// /focus 25 write paper · /focus break 10 · /focus pause|resume|stop|status · /focus +5
async function command($: EngineInterface, args: string): Promise<string> {
  const text = args.trim()
  const r = await read($, run)
  const at = await $.clock.now()
  const word = text.split(/\s+/)[0]?.toLowerCase() ?? ''

  if (word === 'stop' || word === 'cancel') {
    await stopRun($)
    return 'Focus stopped.'
  }
  if (word === 'pause' || word === 'resume') {
    if (!r || r.status === 'done') return 'Nothing is running.'
    await (word === 'pause' ? pauseRun($) : resumeRun($))
    return word === 'pause' ? `Paused at ${mmss(leftOf(r, at))}.` : 'Resumed.'
  }
  const plus = /^\+(\d+)$/.exec(word) ?? (word === 'add' ? /^(\d+)$/.exec(text.split(/\s+/)[1] ?? '') : null)
  if (plus) {
    if (!r || r.status === 'done') return 'Nothing is running.'
    await addMinutes($, Math.min(MAX_MIN, Number(plus[1])))
    return `Added ${plus[1]} min.`
  }
  if (word === 'status' || (word === '' && r && r.status !== 'done')) {
    if (!r) return 'No focus running. /focus 25 write paper starts one.'
    const done = (await read($, rounds)).count
    return `${r.kind} ${r.status}: ${mmss(leftOf(r, at))} left${r.label ? `, ${r.label}` : ''}. ${done} round${done === 1 ? '' : 's'} today.`
  }
  if (word === 'name' || word === 'rename') {
    const label = clipText(text.slice(word.length), MAX_LABEL)
    if (!r || r.status === 'done' || r.kind !== 'focus') return 'No focus round is running.'
    if (!label) return 'Usage: /focus name <the one outcome of this round>'
    await rename($, label)
    return `This round: ${label}.`
  }
  if (word === 'crab') {
    const arg = text.split(/\s+/)[1]?.toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await update($, crab, () => arg === 'on')
      await $.store.set('crab', arg === 'on').catch(() => undefined)
    }
    return (await read($, crab))
      ? 'The crab drops by a few times a round: the start, mid-round, the final stretch and the finish. /focus crab off sends it home.'
      : 'The crab stays home. /focus crab on brings it back.'
  }
  if (word === 'note' || word === 'park') {
    const note = clipText(text.slice(word.length), MAX_LABEL)
    await setParked($, note)
    return note ? `Parked: ${note}. The next round starts from it.` : 'Parked note cleared.'
  }
  if (word === 'break') {
    const m = /^(\d+)/.exec(text.slice(5).trim())
    await startRun($, 'break', m ? Number(m[1]) : breakMinOf((await read($, rounds)).count), '')
    return 'Break started.'
  }
  const m = /^(\d+)\s*m?\b\s*(.*)$/i.exec(text)
  const minutes = m ? Number(m[1]) : FOCUS_MIN
  const label = await startFocus($, minutes, ((m ? m[2] : text) ?? '').trim())
  if (label === null) return `What do you want to focus on? Type it after /focus ${Math.min(MAX_MIN, Math.max(1, minutes))} in the box and press Enter.`
  return `Focus started: ${Math.min(MAX_MIN, Math.max(1, minutes))} min${label ? `, ${label.slice(0, MAX_LABEL)}` : ''}.`
}

const ringSvg = (frac: number, color: string, digits: string): string => {
  const f = Math.min(1, Math.max(0, frac))
  const size = digits.length > 5 ? 16 : 20
  return `<svg xmlns="http://www.w3.org/2000/svg" width="76" height="76" viewBox="0 0 76 76"><style>.t{fill:#1f1f1f}.k{stroke:#e4e0d8}@media (prefers-color-scheme: dark){.t{fill:#ececec}.k{stroke:#3a3836}}</style><circle class="k" cx="38" cy="38" r="32" fill="none" stroke-width="7"/><circle cx="38" cy="38" r="32" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(RING * f).toFixed(1)} ${RING.toFixed(1)}" transform="rotate(-90 38 38)"/><text class="t" x="38" y="${38 + size / 3}" text-anchor="middle" font-size="${size}" font-weight="600" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${digits}</text></svg>`
}

const checkSvg = (color: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="76" height="76" viewBox="0 0 76 76"><circle cx="38" cy="38" r="32" fill="none" stroke="${color}" stroke-width="6"/><path d="M24 39l10 10 19-21" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`

// ---------------------------------------------------------------------------
// The crab cameo: Crab Pal's crab drops into the card a few times a round, the way a cat wanders across the desk.
// Rare and brief on purpose: a glimpse of something cute can sharpen careful work (Nittono et al. 2012), but motion
// at the edge of the eye pulls attention away. So it pops up twice to cheer the start, then visits once or twice
// mid-round, once for the final stretch and once at the finish, and "乖，我忙着呢" sends it off for 10 minutes.

type CameoKind = 'go' | 'blink' | 'glance' | 'wave' | 'cheer' | 'yay' | 'ask' | 'shy'
type Cameo = { kind: CameoKind; key: string }

// How long a visit stays on the card: its animation plus a second of slack (the timer checks once a second).
const VISIT_MS = 6000
const QUIET_MS = 10 * 60_000
const SHY_MS = 2500
const MID_KINDS = ['blink', 'glance', 'wave'] as const
const CLAY = '#D97757'
const INK = '#1F1E1D'
const SPARK = '#F5C542'

// On by default; `/focus crab off` sends it home. Crab Pal reads it and leaves the round-done cheer to the card.
const crab = atom({ plugin: 'focus-timer', key: 'crab' } as const, true)
// Until when the crab keeps away ("乖，我忙着呢"), in ms; the finish and the ask still show it.
const quiet = atom({ plugin: 'focus-timer', key: 'quiet' } as const, 0)

function cameoOf(r: Run | null, exact: number, count: number, waiting: number, at: number, quietUntil: number): Cameo | null {
  if (!r) return waiting > 0 ? { kind: 'ask', key: 'ask' } : null
  if (r.kind !== 'focus') return null
  if (r.status === 'done') return { kind: 'yay', key: `yay-${count}` }
  if (r.status !== 'running') return null
  if (at < quietUntil && at - (quietUntil - QUIET_MS) < SHY_MS) return { kind: 'shy', key: `shy-${quietUntil}` }
  const spent = r.total - exact
  // A visit due while it was told to keep away is skipped, not shown late.
  const within = (from: number) => spent >= from && spent < from + VISIT_MS && at - (spent - from) >= quietUntil
  if (within(0)) return { kind: 'go', key: 'go' }
  const stretch = r.total * STRETCH_AT
  if (within(stretch)) return { kind: 'cheer', key: 'cheer' }
  // One visit per 20 minutes or so, spread over the part before the final stretch.
  const n = Math.max(1, Math.round(r.total / (20 * 60_000)))
  for (let i = 1; i <= n; i++) {
    const from = (stretch * i) / (n + 1)
    if (from >= 3 * VISIT_MS && within(from)) return { kind: MID_KINDS[(count + i) % MID_KINDS.length], key: `mid-${i}` }
  }
  return null
}

// What it says, in a pixel font: one line per pop.
const SAYS: Partial<Record<CameoKind, string[]>> = { go: ['冲鸭!', 'GO!GO!GO!'], cheer: ['冲冲冲!'], yay: ['YAY!'], shy: ['OK!'] }

// Hand-drawn bitmap glyphs, 11 pixels tall: a digital look that needs no font.
const GLYPHS: Record<string, string[]> = {
  冲: ['.......##...', '.##....##...', '..##...##...', '....########', '....##.##.##', '....##.##.##', '..####.##.##', '.##.########', '##.....##...', '.......##...', '.......##...'],
  鸭: ['........##..', '#####.######', '#.#.#.##..##', '#####.##.###', '#.#.#.##..##', '#####.######', '..#...##....', '..#...######', '..#.......##', '..#..#######', '..#......###'],
  // Chunky 2-pixel strokes for the Latin shout, the full line height like the Chinese.
  G: ['.#####.', '##...##', '##.....', '##.....', '##.....', '##..###', '##...##', '##...##', '##...##', '##...##', '.#####.'],
  O: ['.#####.', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
  Y: ['##...##', '##...##', '##...##', '.##.##.', '.##.##.', '..###..', '...#...', '..###..', '..###..', '..###..', '..###..'],
  A: ['.#####.', '##...##', '##...##', '##...##', '##...##', '#######', '##...##', '##...##', '##...##', '##...##', '##...##'],
  K: ['##...##', '##..##.', '##.##..', '####...', '###....', '###....', '####...', '##.##..', '##..##.', '##...##', '##...##'],
  '!': ['##', '##', '##', '##', '##', '##', '##', '..', '..', '##', '##'],
}
const LINE_H = 11
const widthOf = (s: string): number => [...s].reduce((w, ch) => w + (GLYPHS[ch]?.[0].length ?? 4) + 1, -1)

const px = (x: number, y: number, w: number, h: number, c: string): string => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`

function textPx(s: string, x0: number, y0: number): string {
  let x = x0
  let out = ''
  for (const ch of s) {
    const g = GLYPHS[ch]
    if (g) {
      const dy = LINE_H - g.length
      g.forEach((row, y) => [...row].forEach((c, dx) => c === '#' && (out += px(x + dx, y0 + dy + y, 1, 1, INK))))
      x += g[0].length + 1
    } else x += 5
  }
  return out
}

// A white pixel bubble, right edge at `right`, with its tail pointing down-right at the crab's head.
function bubble(s: string, right: number, y: number, cls: string): string {
  const w = widthOf(s) + 6
  const h = LINE_H + 6
  const x = right - w
  return (
    `<g class="${cls}">` +
    px(x + 1, y, w - 2, h, INK) + px(x, y + 1, w, h - 2, INK) +
    px(x + 1, y + 1, w - 2, h - 2, '#FFFFFF') +
    px(right - 4, y + h, 2, 1, INK) + px(right - 3, y + h, 1, 1, '#FFFFFF') + px(right - 2, y + h + 1, 2, 1, INK) +
    textPx(s, x + 3, y + 3) +
    '</g>'
  )
}

// Below the bottom edge (40) the crab is hidden; at 21 its eyes and claws peek over the card's border; at 14 it stands.
const CAMEO_CSS = `<style>
.c{transform:translateY(40px)}.ec{opacity:0}.st,.b1,.b2{opacity:0}
.go .c{animation:go 4.6s ease-out forwards}
.go .b1{animation:s1 4.6s steps(1) forwards}.go .b2{animation:s2 4.6s steps(1) forwards}
.peek .c{animation:pk 4.5s ease-in-out forwards}.cheer .b1{animation:sp 4.5s steps(1) forwards}
.ask .c{animation:up .6s ease-out forwards}
.yay .c{animation:yay 2.4s ease-out forwards}.yay .b1{animation:on .1s 1s forwards}
.shy .c{animation:shy 1.6s ease-in forwards}.shy .b1{animation:sh 1.6s steps(1) forwards}
.peek .eo,.ask .eo{animation:eo 4.5s linear forwards}.peek .ec,.ask .ec{animation:ec 4.5s linear forwards}
.shy .eo{opacity:0}.shy .ec{opacity:1}
.glance .ey{animation:gl 4.5s ease-in-out forwards}
.wave .arm{animation:wv 4.5s ease-in-out forwards}
.go .arm,.go .arm2{animation:pump 4.6s ease-in-out forwards}
.cheer .arm,.cheer .arm2,.yay .arm,.yay .arm2{animation:wv 4.5s ease-in-out forwards}
.cheer .st,.yay .st{animation:tw .6s steps(1) 5 .6s forwards}
@keyframes go{0%{transform:translateY(40px)}9%,34%{transform:translateY(14px)}44%,52%{transform:translateY(40px)}61%,88%{transform:translateY(14px)}100%{transform:translateY(40px)}}
@keyframes s1{0%{opacity:0}10%{opacity:1}35%,100%{opacity:0}}
@keyframes s2{0%{opacity:0}62%{opacity:1}89%,100%{opacity:0}}
@keyframes pump{0%,12%{transform:translateY(0)}18%{transform:translateY(-4px)}24%,64%{transform:translateY(0)}70%{transform:translateY(-4px)}76%{transform:translateY(0)}82%{transform:translateY(-4px)}88%,100%{transform:translateY(0)}}
@keyframes pk{0%{transform:translateY(40px)}12%,86%{transform:translateY(21px)}100%{transform:translateY(40px)}}
@keyframes sp{0%{opacity:0}13%{opacity:1}85%,100%{opacity:0}}
@keyframes yay{0%{transform:translateY(40px)}15%{transform:translateY(14px)}30%{transform:translateY(8px)}45%{transform:translateY(14px)}60%{transform:translateY(8px)}75%,100%{transform:translateY(14px)}}
@keyframes on{to{opacity:1}}
@keyframes shy{0%,55%{transform:translateY(21px)}100%{transform:translateY(40px)}}
@keyframes sh{0%{opacity:1}55%,100%{opacity:0}}
@keyframes up{to{transform:translateY(21px)}}
@keyframes eo{0%,28%{opacity:1}29%,33%{opacity:0}34%,48%{opacity:1}49%,53%{opacity:0}54%,100%{opacity:1}}
@keyframes ec{0%,28%{opacity:0}29%,33%{opacity:1}34%,48%{opacity:0}49%,53%{opacity:1}54%,100%{opacity:0}}
@keyframes gl{0%,30%{transform:translateX(0)}36%,52%{transform:translateX(-1px)}58%,72%{transform:translateX(1px)}78%,100%{transform:translateX(0)}}
@keyframes wv{0%,35%{transform:translateY(0)}40%{transform:translateY(-4px)}46%{transform:translateY(-1px)}52%{transform:translateY(-4px)}58%,100%{transform:translateY(0)}}
@keyframes tw{0%{opacity:1}50%{opacity:.15}100%{opacity:1}}
@media (prefers-reduced-motion: reduce){*{animation:none!important}.peek .c,.ask .c{transform:translateY(21px)}.go .c,.yay .c{transform:translateY(14px)}.st,.b1{opacity:1}.shy .c{transform:translateY(40px)}}
</style>`

const CRAB_W = 30

// The svg is as wide as the crab plus whatever it says, so a quiet visit takes the same small spot as no visit.
function cameoWidth(kind: CameoKind | null): number {
  const lines = (kind && SAYS[kind]) || []
  return CRAB_W + (lines.length ? Math.max(...lines.map(widthOf)) - 1 : 0)
}

function cameoSvg(kind: CameoKind | null): string {
  const w = cameoWidth(kind)
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * 1.1)}" height="44" viewBox="0 0 ${w} 40">`
  if (!kind) return `${open}</svg>`
  const peek = kind === 'blink' || kind === 'glance' || kind === 'wave' || kind === 'cheer'
  const at = w - CRAB_W
  const body =
    px(7, 10, 16, 12, CLAY) +
    px(8, 15, 2, 1, '#EE9A85') + px(20, 15, 2, 1, '#EE9A85') +
    [7, 11, 17, 21].map(x => px(x, 22, 2, 4, CLAY)).join('')
  // Big round eyes with a glint; the closed pair shows while it blinks (and while it ducks away, shy).
  const eyes =
    `<g class="ey"><g class="eo">${px(9, 12, 3, 3, INK)}${px(18, 12, 3, 3, INK)}${px(9, 12, 1, 1, '#FFFFFF')}${px(18, 12, 1, 1, '#FFFFFF')}</g>` +
    `<g class="ec">${px(9, 14, 3, 1, INK)}${px(18, 14, 3, 1, INK)}</g></g>`
  const claws = `<g class="arm2">${px(3, 14, 4, 4, CLAY)}</g><g class="arm">${px(23, 14, 4, 4, CLAY)}</g>`
  const stars = `<g class="st">${px(2, 6, 1, 3, SPARK)}${px(1, 7, 3, 1, SPARK)}${px(27, 3, 1, 3, SPARK)}${px(26, 4, 3, 1, SPARK)}</g>`
  const what = kind === 'ask' ? ['.qq.', 'q..q', '...q', '..q.', '....', '..q.'].map((row, y) => [...row].map((ch, x) => (ch === 'q' ? px(24 + x, y + 2, 1, 1, '#9AA0AA') : '')).join('')).join('') : ''
  // The bubble rides just above the crab's head: standing (go, yay) or peeking (cheer, shy).
  const lines = SAYS[kind] ?? []
  const by = kind === 'go' || kind === 'yay' ? 2 : 9
  const talk = lines.map((s, i) => bubble(s, at + 7, by, `b${i + 1}`)).join('')
  return `${open}${CAMEO_CSS}<g shape-rendering="crispEdges" class="${kind}${peek ? ' peek' : ''}">${talk}<g transform="translate(${at} 0)"><g class="c">${body}${claws}${eyes}${stars}${what}</g></g></g></svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'focus',
      description: 'Start a focus countdown card: /focus 25 write paper',
      argumentHint: '[minutes] [intention] | name <outcome> | note <next step> | break [min] | pause | resume | stop | +5 | status | crab on|off',
      immediate: true,
    })
    await ensureTicker($)
    await update($, crab, v => v !== false)
    // Today's rounds from earlier sessions; the countdown works without them.
    try {
      const day = dayOf(await $.clock.now())
      const saved = await $.store.get(`rounds:${day}`)
      const mins = await $.store.get(`minutes:${day}`)
      if (typeof saved === 'number') await update($, rounds, () => ({ day, count: saved, minutes: typeof mins === 'number' ? mins : 0 }))
      const note = await $.store.get('parked')
      if (typeof note === 'string') await update($, parked, () => note)
      const pal = await $.store.get('crab')
      if (typeof pal === 'boolean') await update($, crab, () => pal)
    } catch {
      // No store: the count starts from zero.
    }
    return started
  })

  on('command.run', { command: 'focus' }, async ($, e) => ({ text: await command($, e.args ?? '') }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const r = await read($, run)
    if (e.props.hasSurvey) return rest
    const waiting = await read($, asking)
    const pal = await read($, crab)
    // The crab's spot sits between the text and the buttons and is always there, so a visit never shifts the card.
    const { Box } = $.ui.resolve(e)
    const { Svg } = $.ui.resolve(e) as unknown as { Svg?: typeof Box }
    const slot = (key: string, kind: CameoKind | null = 'ask') =>
      pal && e.surface === 'desktop' && Svg ? (
        <Svg key={`crab-${key}`} source={cameoSvg(kind)} width={Math.round(cameoWidth(kind) * 1.1)} height={44} alt={kind ? `crab${SAYS[kind] ? `: ${SAYS[kind]?.join(' ')}` : ''}` : ''} />
      ) : null
    if (!r && waiting > 0) {
      const { Button, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {rest}
          <Box borderStyle="round" borderColor={FOCUS_COLOR} paddingX="md" gap="md" alignItems="center" flexWrap="wrap">
            <Box flexDirection="column" flexGrow={1}>
              <Text weight="bold" color={FOCUS_COLOR}>
                What do you want to focus on?
              </Text>
              <Text size="caption" dimColor>
                One outcome for the next {waiting} min. Type it after /focus {waiting} in the box, then Enter.
              </Text>
            </Box>
            {slot('ask')}
            <Box gap="sm">
              <Button key="unnamed" label="Start unnamed" onPress={() => startRun($, 'focus', waiting, '')} />
              <Button key="cancel" label="Cancel" onPress={() => stopRun($)} />
            </Box>
          </Box>
        </Box>
      )
    }
    if (!r) return rest
    // Reading `now` is what redraws the card on each tick; the time itself comes from the clock.
    await read($, now)
    const at = await $.clock.now()
    const exact = leftOf(r, at)
    const left = r.status === 'running' ? Math.min(r.total, bucket(exact) * STEP) : exact
    const color = r.status === 'done' ? BREAK_COLOR : colorOf(r, left)
    const { Button, Text } = $.ui.resolve(e)
    const day = await read($, rounds)
    const count = day.count
    const quietUntil = await read($, quiet)
    const cameo = pal ? cameoOf(r, exact, count, 0, at, quietUntil) : null
    // While it is visiting mid-round, one tap sends it off for 10 minutes; it says OK and ducks away.
    const shoo =
      cameo && ['go', 'blink', 'glance', 'wave', 'cheer'].includes(cameo.kind) ? (
        <Button key="shoo" label="乖，我忙着呢" onPress={async () => {
          const pressed = await $.clock.now()
          await update($, quiet, () => pressed + QUIET_MS)
        }} />
      ) : null
    const note = await read($, parked)
    const minutes = Math.round(r.total / 60_000)
    const nextBreak = breakMinOf(count)
    const state =
      r.status === 'paused' ? 'Paused'
      : r.status === 'done' ? (r.kind === 'focus' ? `Round ${count} done` : 'Break is over')
      : r.kind === 'break' ? 'Break'
      : isStretch(r, left) ? 'Final stretch'
      : 'Focus'
    // Line one: the intention (or what to do now). Line two: progress toward today's goal, and when this ends.
    const title =
      r.kind === 'break'
        ? r.status === 'done' ? (note ? `Pick up: ${note}` : 'Ready for the next round') : BREAK_TIPS[count % BREAK_TIPS.length]
        : r.status === 'done' ? (note ? `Next: ${note}` : 'Park your next step, then really rest') : r.label || 'What is the one outcome of this round?'
    const ends = r.status === 'running' ? (r.kind === 'break' ? ` · back at ${clock(r.endsAt)}` : ` · ends ${clock(r.endsAt)}`) : ''
    const meta = r.status === 'done' && r.kind === 'focus' ? `${dots(count)} · ${day.minutes} min deep work today` : `${dots(count)} · ${minutes} min${ends}`
    const buttons =
      r.status === 'done'
        ? r.kind === 'focus'
          ? [
              <Button key="break" label={`Break ${nextBreak} min`} variant="primary" onPress={() => startRun($, 'break', nextBreak, '')} />,
              ...(note ? [] : [<Button key="park" label="Park next step" onPress={() => $.prompt.fill({ text: '/focus note ' })} />]),
              <Button key="again" label={`Again ${minutes} min`} onPress={() => startRun($, 'focus', r.total / 60_000, r.label)} />,
              <Button key="dismiss" label="Done" onPress={() => stopRun($)} />,
            ]
          : [
              <Button key="focus" label={`Focus ${FOCUS_MIN} min`} variant="primary" onPress={() => startNext($)} />,
              <Button key="dismiss" label="Done" onPress={() => stopRun($)} />,
            ]
        : [
            r.status === 'paused' ? (
              <Button key="resume" label="Resume" variant="primary" onPress={() => resumeRun($)} />
            ) : (
              <Button key="pause" label="Pause" onPress={() => pauseRun($)} />
            ),
            ...(r.kind === 'focus' && (!r.label || r.auto)
              ? [<Button key="name" label={r.label ? 'Rename' : 'Name it'} onPress={() => $.prompt.fill({ text: '/focus name ' })} />]
              : []),
            <Button key="add" label="+5 min" onPress={() => addMinutes($, 5)} />,
            <Button key="stop" label="Stop" onPress={() => stopRun($)} />,
          ]

    if (e.surface === 'desktop' && 'Svg' in $.ui.resolve(e)) {
      const { Svg } = $.ui.resolve(e) as unknown as { Svg: typeof Box }
      const source = r.status === 'done' ? checkSvg(color) : ringSvg(1 - left / r.total, color, mmss(left))
      // One row: the ring, two lines of text, the buttons; they wrap under the text when the window is narrow.
      return (
        <Box flexDirection="column">
          {rest}
          <Box borderStyle="round" borderColor={color} paddingX="md" gap="md" alignItems="center" flexWrap="wrap">
            <Svg source={source} width={44} height={44} alt={`${state} ${mmss(left)}`} />
            <Box flexDirection="column" flexGrow={1}>
              <Box gap="sm" alignItems="center">
                <Text size="caption" weight="bold" color={color}>
                  {state.toUpperCase()}
                </Text>
                <Text weight="bold" wrap="truncate-end">
                  {title}
                </Text>
              </Box>
              <Text size="caption" dimColor>
                {meta}
              </Text>
            </Box>
            {shoo}
            {slot(cameo?.key ?? 'none', cameo?.kind ?? null)}
            <Box gap="sm">{buttons}</Box>
          </Box>
        </Box>
      )
    }

    const filled = Math.round((r.status === 'done' ? 1 : 1 - left / r.total) * 12)
    return (
      <Box flexDirection="column">
        {rest}
        <Box gap="sm" flexWrap="wrap">
          <Text color={color} bold>
            {state} {mmss(left)} {'█'.repeat(filled)}
            {'░'.repeat(12 - filled)}
          </Text>
          <Text dimColor>
            {cameo ? `🦀 ${SAYS[cameo.kind]?.join(' ') ?? ''} ` : ''}
            {title} · {dots(count)}
          </Text>
          {shoo}
          {buttons}
        </Box>
      </Box>
    )
  })
}
