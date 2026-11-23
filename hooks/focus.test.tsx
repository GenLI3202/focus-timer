import { expect, mock, test } from 'claude-code/testing'

const band = { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} }
const MIN = 60_000

const setup = (on: Parameters<typeof mock.clock>[0]) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-03T10:00:00') })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'focus' } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  return clock
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: /focus starts a card that counts down and finishes`, async ($, on) => {
    const clock = setup(on)
    const toasts: string[] = []
    on('ui.toast', (_$, e) => {
      toasts.push(String((e as { text?: string }).text ?? ''))
      return { value: undefined } as never
    })
    await $.session.start({ cwd: '/', surface, isInteractive: true })

    const started = await $.command.run({ command: 'focus', args: '25 write paper' })
    expect(started.text).toMatch(/Focus started: 25 min, write paper/)

    await clock.advance(5 * MIN)
    const ui = await $.ui.mount({ plugin: 'focus-timer', surface, component: 'AbovePrompt', props: band })
    expect(await ui.find({ type: 'Text', text: /write paper/ })).toBeDefined()
    expect((await $.command.run({ command: 'focus', args: 'status' })).text).toMatch(/20:00 left/)

    await clock.advance(20 * MIN + 1000)
    expect(toasts.join(' ')).toMatch(/Focus done: write paper/)
    expect((await $.command.run({ command: 'focus', args: 'status' })).text).toMatch(/done|1 round/)
    expect(await ui.find({ type: 'Button', text: /Break 5 min/ })).toBeDefined()
  })

  test(`${surface}: pause keeps the time, resume continues, +5 extends, stop clears`, async ($, on) => {
    const clock = setup(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.command.run({ command: 'focus', args: '10 x' })
    await clock.advance(4 * MIN)
    expect((await $.command.run({ command: 'focus', args: 'pause' })).text).toMatch(/Paused at 06:00/)
    await clock.advance(30 * MIN)
    expect((await $.command.run({ command: 'focus', args: 'status' })).text).toMatch(/paused: 06:00 left/)
    await $.command.run({ command: 'focus', args: 'resume' })
    await $.command.run({ command: 'focus', args: '+5' })
    expect((await $.command.run({ command: 'focus', args: 'status' })).text).toMatch(/running: 11:00 left/)
    expect((await $.command.run({ command: 'focus', args: 'stop' })).text).toMatch(/stopped/)
    expect((await $.command.run({ command: 'focus', args: 'status' })).text).toMatch(/No focus running/)
  })
}

test('odd input is bounded', async ($, on) => {
  setup(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await $.command.run({ command: 'focus', args: '99999 ' + 'x'.repeat(500) })).text).toMatch(/Focus started: 600 min/)
  expect((await $.command.run({ command: 'focus', args: 'pause' })).text).toMatch(/Paused/)
})

test('desktop: the time on the card moves in 5-second steps', async ($, on) => {
  const clock = setup(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'focus', args: '25 steps' })
  const ui = await $.ui.mount({ plugin: 'focus-timer', surface: 'desktop', component: 'AbovePrompt', props: band })
  const shown = async () => String((await ui.find({ type: 'Svg' }))?.props.alt)

  expect(await shown()).toBe('Focus 25:00')
  await clock.advance(3000)
  expect(await shown()).toBe('Focus 25:00')
  await clock.advance(2000)
  expect(await shown()).toBe('Focus 24:55')
  await clock.advance(4000)
  expect(await shown()).toBe('Focus 24:55')
  await clock.advance(1000)
  expect(await shown()).toBe('Focus 24:50')
})

test('the countdown restarts its timer when it has gone quiet', async ($, on) => {
  const clock = setup(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'focus', args: '10 x' })
  await clock.advance(10_000)
  // A press (here a +5) makes sure a timer runs, and the run still ends on time.
  await $.command.run({ command: 'focus', args: '+5' })
  await clock.advance(15 * MIN + 2000)
  expect((await $.command.run({ command: 'focus', args: 'status' })).text).toMatch(/focus done: 00:00 left, x. 1 round today/)
})

test('desktop: the ring fills as time passes', async ($, on) => {
  const clock = setup(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'focus', args: '10 fill' })
  const ui = await $.ui.mount({ plugin: 'focus-timer', surface: 'desktop', component: 'AbovePrompt', props: band })
  const filledOf = async () => {
    const source = String((await ui.find({ type: 'Svg' }))?.props.source)
    return Number(/stroke-dasharray="([\d.]+) /.exec(source)?.[1])
  }
  expect(await filledOf()).toBe(0)
  await clock.advance(5 * MIN)
  const half = await filledOf()
  expect(half).toBeGreaterThan(95)
  expect(half).toBeLessThan(110)
  await clock.advance(4 * MIN)
  expect(await filledOf()).toBeGreaterThan(half)
})

test('desktop: the last fifth turns into the final stretch', async ($, on) => {
  const clock = setup(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'focus', args: '10 stretch' })
  const ui = await $.ui.mount({ plugin: 'focus-timer', surface: 'desktop', component: 'AbovePrompt', props: band })
  await clock.advance(7 * MIN)
  expect(await ui.find({ type: 'Text', text: /^FOCUS$/ })).toBeDefined()
  await clock.advance(1 * MIN + 5000)
  expect(await ui.find({ type: 'Text', text: /FINAL STRETCH/ })).toBeDefined()
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toMatch(/#E8A33D/)
})

test('desktop: park the next step at the end; it names the next round after the break', async ($, on) => {
  const clock = setup(on)
  const filled: string[] = []
  on('prompt.fill', (_$, e) => {
    filled.push((e as { text: string }).text)
    return { isFilled: true } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'focus', args: '25 draft section 3' })
  const ui = await $.ui.mount({ plugin: 'focus-timer', surface: 'desktop', component: 'AbovePrompt', props: band })
  await clock.advance(25 * MIN + 1000)
  expect(await ui.find({ type: 'Text', text: /ROUND 1 DONE/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /●○○○ · 25 min deep work today/ })).toBeDefined()
  await ui.press({ key: 'park' })
  expect(filled[0]).toBe('/focus note ')
  expect((await $.command.run({ command: 'focus', args: 'note check the 18:00 peak' })).text).toMatch(/Parked: check the 18:00 peak/)
  expect(await ui.find({ type: 'Button', text: /Park next step/ })).toBeUndefined()

  await ui.press({ key: 'break' })
  expect(await ui.find({ type: 'Text', text: /Look at something 6 m away|Stand up|Refill|window|Close your eyes/ })).toBeDefined()
  await clock.advance(5 * MIN + 1000)
  expect(await ui.find({ type: 'Text', text: /Pick up: check the 18:00 peak/ })).toBeDefined()
  await ui.press({ key: 'focus' })
  expect((await $.command.run({ command: 'focus', args: 'status' })).text).toMatch(/focus running: 25:00 left, check the 18:00 peak/)
})

test('a round with no label takes the last thing asked; the fourth round earns a long break', async ($, on) => {
  const clock = setup(on)
  on('session.messages', () => ({ value: [{ role: 'user', text: 'Refit the model with a peak-hour term', toolUses: [] }, { role: 'user', text: '<task-notification>x</task-notification>', toolUses: [] }] }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await $.command.run({ command: 'focus', args: '1' })).text).toMatch(/Focus started: 1 min, Refit the model with a peak-hour term/)
  for (let i = 0; i < 4; i++) {
    if (i > 0) await $.command.run({ command: 'focus', args: '1 r' })
    await clock.advance(MIN + 1000)
  }
  const ui = await $.ui.mount({ plugin: 'focus-timer', surface: 'desktop', component: 'AbovePrompt', props: band })
  expect(await ui.find({ type: 'Button', text: /Break 15 min/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /●●●● · 4 min deep work today/ })).toBeDefined()
})

test('a new session asks for the intention first, with the command waiting in the box', async ($, on) => {
  const clock = setup(on)
  const filled: string[] = []
  on('prompt.fill', (_$, e) => {
    filled.push((e as { text: string }).text)
    return { isFilled: true } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'focus-timer', surface: 'desktop', component: 'AbovePrompt', props: band })
  expect((await $.command.run({ command: 'focus', args: '' })).text).toMatch(/What do you want to focus on/)
  await clock.advance(50)
  expect(filled[0]).toBe('/focus 25 ')
  expect(await ui.find({ type: 'Text', text: /What do you want to focus on/ })).toBeDefined()
  expect((await $.command.run({ command: 'focus', args: 'status' })).text).toMatch(/No focus running/)

  expect((await $.command.run({ command: 'focus', args: '25 搞清楚中段校准值不值得加' })).text).toMatch(/Focus started: 25 min, 搞清楚中段校准值不值得加/)
  expect(await ui.find({ type: 'Text', text: /What do you want to focus on/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /Rename|Name it/ })).toBeUndefined()
})

test('"Start unnamed" starts the round anyway; the card then offers to name it', async ($, on) => {
  setup(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'focus-timer', surface: 'desktop', component: 'AbovePrompt', props: band })
  await $.command.run({ command: 'focus', args: '' })
  await ui.press({ key: 'unnamed' })
  expect(await ui.find({ type: 'Button', text: /Name it/ })).toBeDefined()
  await $.command.run({ command: 'focus', args: 'name write the intro' })
  expect(await ui.find({ type: 'Text', text: /write the intro/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Name it|Rename/ })).toBeUndefined()
})

test('an ask becomes an outcome: a quick guess at once, then the small model\'s phrase', async ($, on) => {
  const clock = setup(on)
  const asked: string[] = []
  on('session.messages', () => ({ value: [{ role: 'user', text: '所以这些实验跑下来来看，中段校准还是挺值得加的？', toolUses: [] }] }) as never)
  on('model.complete', (_$, e) => {
    asked.push(String((e as { prompt: string }).prompt))
    return { value: { isAnswered: true, text: '「搞清楚中段校准值不值得加」。', usage: {} } } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await $.command.run({ command: 'focus', args: '25' })).text).toMatch(/Focus started: 25 min, 搞清楚：中段校准还是挺值得加的/)
  await clock.advance(100)
  expect(asked[0]).toMatch(/中段校准/)
  const ui = await $.ui.mount({ plugin: 'focus-timer', surface: 'desktop', component: 'AbovePrompt', props: band })
  expect(await ui.find({ type: 'Text', text: /^搞清楚中段校准值不值得加$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Rename/ })).toBeDefined()
})

test('desktop: the crab drops by at the start, mid-round, the final stretch and the finish, and is away otherwise', async ($, on) => {
  const clock = setup(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'focus', args: '25 crab watch' })
  const ui = await $.ui.mount({ plugin: 'focus-timer', surface: 'desktop', component: 'AbovePrompt', props: band })
  const visit = async () => {
    const svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs.length).toBe(2)
    const m = /class="(go|blink|glance|wave|cheer|yay)/.exec(String(svgs[1]?.props.source))
    return m ? m[1] : 'away'
  }

  expect(await visit()).toBe('go')
  await clock.advance(15_000)
  expect(await visit()).toBe('away')
  // 25 min: one mid visit at 40 %, i.e. 10 min in.
  await clock.advance(10 * MIN - 15_000)
  expect(await visit()).toMatch(/blink|glance|wave/)
  await clock.advance(15_000)
  expect(await visit()).toBe('away')
  await clock.advance(10 * MIN - 15_000)
  expect(await visit()).toBe('cheer')
  await clock.advance(15_000)
  expect(await visit()).toBe('away')
  await clock.advance(5 * MIN)
  expect(await visit()).toBe('yay')
  // The finish visit stays while the card waits for you.
  await clock.advance(MIN)
  expect(await visit()).toBe('yay')
})

test('the crab can be sent home and called back', async ($, on) => {
  setup(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await $.command.run({ command: 'focus', args: 'crab off' })).text).toMatch(/stays home/)
  await $.command.run({ command: 'focus', args: '25 quiet please' })
  const ui = await $.ui.mount({ plugin: 'focus-timer', surface: 'desktop', component: 'AbovePrompt', props: band })
  expect((await ui.findAll({ type: 'Svg' })).length).toBe(1)
  expect((await $.command.run({ command: 'focus', args: 'crab on' })).text).toMatch(/drops by/)
  expect((await ui.findAll({ type: 'Svg' })).length).toBe(2)
})

test('desktop: while asking what to focus on, the crab peeks with a question mark', async ($, on) => {
  setup(on)
  on('session.messages', () => ({ value: [] }) as never)
  on('prompt.fill', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'focus', args: '' })
  const ui = await $.ui.mount({ plugin: 'focus-timer', surface: 'desktop', component: 'AbovePrompt', props: band })
  expect(await ui.find({ type: 'Text', text: /What do you want to focus on/ })).toBeDefined()
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('class="ask')
})

test('desktop: the start is two pops that say 冲鸭! and GO!GO!GO!; "乖，我忙着呢" sends the crab off for 10 minutes', async ($, on) => {
  const clock = setup(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'focus', args: '50 long one' })
  const ui = await $.ui.mount({ plugin: 'focus-timer', surface: 'desktop', component: 'AbovePrompt', props: band })
  const crabSvg = async () => (await ui.findAll({ type: 'Svg' }))[1]
  const visit = async () => /class="(\w+)/.exec(String((await crabSvg())?.props.source).split('crispEdges')[1] ?? '')?.[1] ?? 'away'

  expect(String((await crabSvg())?.props.alt)).toBe('crab: 冲鸭! GO!GO!GO!')
  expect(String((await crabSvg())?.props.source)).toContain('class="b2"')
  // It leaves on the second, and the button goes with it.
  await clock.advance(7000)
  expect(await visit()).toBe('away')
  expect(await ui.find({ type: 'Button', text: /乖/ })).toBeUndefined()

  // 50 min: mid visits at 10, 20 and 30 min. Shoo the first one.
  await clock.advance(10 * MIN - 7000)
  expect(await visit()).toMatch(/blink|glance|wave/)
  await clock.advance(2000)
  await ui.press({ key: 'shoo' })
  expect(await visit()).toBe('shy')
  expect(String((await crabSvg())?.props.alt)).toBe('crab: OK!')
  await clock.advance(3000)
  expect(await visit()).toBe('away')
  // Still away at the 20-minute visit, back for the 30-minute one.
  await clock.advance(10 * MIN - 5000)
  expect(await visit()).toBe('away')
  await clock.advance(10 * MIN)
  expect(await visit()).toMatch(/blink|glance|wave/)
})

test('terminal: the crab says its line in the card text', async ($, on) => {
  setup(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'focus', args: '25 x' })
  const ui = await $.ui.mount({ plugin: 'focus-timer', surface: 'terminal', component: 'AbovePrompt', props: band })
  expect(await ui.find({ type: 'Text', text: /🦀 冲鸭! GO!GO!GO!/ })).toBeDefined()
})
