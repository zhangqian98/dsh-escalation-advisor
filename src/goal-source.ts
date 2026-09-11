import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * The message attribution an admitted goal continuation round carries.
 *
 * DSH's goal round driver submits each automatic round as an ordinary user
 * message whose source kind is `goal` (see the driver's own
 * `isGoalRoundSource(source)`), which is what makes a goal round structurally
 * different from a new task: it moves no task boundary, yet the model receives
 * it as a fresh user turn.
 *
 * That member lives in the goal package's own `MessageSourceMap` augmentation,
 * and this package does not depend on the goal package, so the source union the
 * pinned `@deepseek-ai/dsh-llm` types expose would otherwise reject the
 * comparison in `agent/inbox/inserted` as having no overlap. Restating the
 * augmentation here keeps that comparison a real narrowing instead of a cast.
 *
 * The declared shape reproduces the driver's own declaration, including its
 * branded identifier: `GoalId` is the goal package's alias for
 * `Branded<'GoalId'>`, so the same brand is written here rather than a widened
 * `string`, because declaration merging requires identical property types.
 *
 * Not verified here: whether that merging also holds in a compile that loads
 * BOTH trees at once, where each side's `Branded` comes from its own copy of the
 * brand package and `unique symbol` makes two copies nominally distinct. No
 * compile of this package loads the goal package today, so the question does not
 * arise; loading it would mean checking this member against the authoritative
 * copy instead of assuming the two spellings merge.
 *
 * @module
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    goal: GoalRoundSource
  }
}

export interface GoalRoundSource {
  readonly kind: 'goal'
  /** The goal package's `GoalId`, spelled through the shared brand helper. */
  readonly goalId: Branded<'GoalId'>
  readonly revision: number
  /** Positive admitted continuation round. */
  readonly round: number
}
