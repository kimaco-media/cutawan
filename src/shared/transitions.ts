import type { Clip, Transcript } from './types'
import { orderedPieces } from './editOps'
import { clipKeptSegments, TimeMap } from './tighten'

export interface OutputJoin {
  fromId: string
  toId: string
  time: number
  maxDuration: number
  duration: number
}

/** No overlap or inserted frames: source, speech and caption timing stay unchanged.
 * Only currently adjacent retained pieces can activate a saved transition. A
 * broken adjacency stays dormant, so undo/rejoining the same IDs restores it.
 * Each half fits within half of the adjacent edge span, preventing overlapping
 * fades even after trim, manual cuts or automatic pause removal.
 */
export function outputJoins(clip: Pick<Clip, 'edit' | 'visualStory'>, transcript: Transcript | null): OutputJoin[] {
  const map = new TimeMap(clipKeptSegments(clip, transcript) ?? [clip.edit])
  const pieces = orderedPieces(clip.edit).map(piece => ({
    ...piece,
    spans: map.mapRange(piece)
  })).filter(piece => piece.spans.length > 0)
  return pieces.slice(1).map((right, i) => {
    const left = pieces[i]
    const tail = left.spans.at(-1)!, head = right.spans[0]
    const maxDuration = Math.floor(Math.max(0, Math.min(1.5, tail.end - tail.start, head.end - head.start)) * 1000) / 1000
    const saved = clip.edit.transitions?.find(t => t.fromId === left.id && t.toId === right.id && t.kind === 'fade-black')
    const requested = saved && Number.isFinite(saved.duration) ? Math.max(0.1, saved.duration) : 0
    return { fromId: left.id, toId: right.id, time: head.start, maxDuration,
      duration: maxDuration >= 0.1 ? Math.min(maxDuration, requested) : 0 }
  })
}

/** Opacity of a black overlay over the final composed image, including text. */
export function transitionOpacity(joins: OutputJoin[], time: number): number {
  let opacity = 0
  for (const join of joins) {
    if (join.duration > 0) opacity = Math.max(opacity, 1 - Math.abs(time - join.time) / (join.duration / 2))
  }
  return Math.max(0, Math.min(1, opacity))
}

/** Timeline-enabled fades act only on their half, leaving later frames intact. */
export function transitionFilters(joins: OutputJoin[]): string[] {
  return joins.filter(j => j.duration > 0).flatMap(join => {
    const half = join.duration / 2
    const from = join.time - half, until = join.time + half
    return [
      `fade=t=out:st=${from}:d=${half}:enable='gte(t,${from})*lt(t,${join.time})'`,
      `fade=t=in:st=${join.time}:d=${half}:enable='gte(t,${join.time})*lt(t,${until})'`
    ]
  })
}
