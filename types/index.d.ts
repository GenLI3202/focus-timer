export type Run = {
  kind: 'focus' | 'break'
  label: string
  /** The full length, in ms. */
  total: number
  /** When it ends, in ms on the engine's clock; meaningful while running. */
  endsAt: number
  /** What was left when it was paused, in ms. */
  pausedLeft: number
  status: 'running' | 'paused' | 'done'
  /** True when the label was drawn from the conversation, not typed: the card offers to rename it. */
  auto?: boolean
}

export type Rounds = { day: number; count: number; minutes: number }

declare module 'claude-code' {
  interface PluginState {
    'focus-timer': { run: Shaped<Run | null>; now: number; rounds: Shaped<Rounds>; parked: string; asking: number; crab: boolean; quiet: number }
  }
}
