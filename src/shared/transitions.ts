import type { Clip, Transcript } from './types'
import { orderedPieces } from './editOps'
import { clipKeptSegments, TimeMap } from './tighten'

export interface OutputJoin {
  fromId: string
  toId: string
  time: number
  maxDuration: number
  duration: number
  kind: 'cut' | 'fade-black' | 'zoom'
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
    const saved = clip.edit.transitions?.find(t => t.fromId === left.id && t.toId === right.id && (t.kind === 'fade-black' || t.kind === 'zoom'))
    const requested = saved && Number.isFinite(saved.duration) ? Math.max(0.1, saved.duration) : 0
    return { kind: saved?.kind ?? 'cut', fromId: left.id, toId: right.id, time: head.start, maxDuration,
      duration: maxDuration >= 0.1 ? Math.min(maxDuration, requested) : 0 }
  })
}

/** Opacity of a black overlay over the final composed image, including text. */
export function transitionOpacity(joins: OutputJoin[], time: number): number {
  let opacity = 0
  for (const join of joins) {
    if (join.kind === 'fade-black' && join.duration > 0) opacity = Math.max(opacity, 1 - Math.abs(time - join.time) / (join.duration / 2))
  }
  return Math.max(0, Math.min(1, opacity))
}

/** Symmetric punch-in/out at the join; source playback and audio remain unchanged. */
const TRANSITION_ZOOM_AMOUNT = 0.8
export function transitionZoom(joins: OutputJoin[], time: number): number {
  let scale = 1
  for (const join of joins) {
    if (join.kind !== 'zoom' || join.duration <= 0) continue
    const progress = Math.max(0, 1 - Math.abs(time - join.time) / (join.duration / 2))
    scale += TRANSITION_ZOOM_AMOUNT * progress * progress
  }
  return scale
}

/** Timeline-enabled fades act only on their half, leaving later frames intact. */
export function transitionFilters(joins: OutputJoin[], fps = 30): string[] {
  const filters = joins.filter(j => j.kind === 'fade-black' && j.duration > 0).flatMap(join => {
    const half = join.duration / 2
    const from = join.time - half, until = join.time + half
    return [
      `fade=t=out:st=${from}:d=${half}:enable='gte(t,${from})*lt(t,${join.time})'`,
      `fade=t=in:st=${join.time}:d=${half}:enable='gte(t,${join.time})*lt(t,${until})'`
    ]
  })
  const zooms = joins.filter(j => j.kind === 'zoom' && j.duration > 0)
  if (zooms.length) {
    const rate = Number.isFinite(fps) && fps > 0 && fps <= 240 ? fps : 30
    // perspective evaluates by frame index: normalize VFR before using that clock.
    filters.unshift(`fps=${rate}`)
    const ramps = zooms.map(j => `pow(max(0,1-abs(in/${rate}-${j.time})/${j.duration / 2}),2)`)
    const z = `(1+${TRANSITION_ZOOM_AMOUNT}*(${ramps.join('+')}))`
    const left = `(W-W/${z})/2`, right = `W-(W-W/${z})/2`
    const top = `(H-H/${z})/2`, bottom = `H-(H-H/${z})/2`
    filters.push(`perspective=x0='${left}':y0='${top}':x1='${right}':y1='${top}':` +
      `x2='${left}':y2='${bottom}':x3='${right}':y3='${bottom}':interpolation=cubic:eval=frame`)
  }
  return filters
}
