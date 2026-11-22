import type { Clip, ClipEditState, Transcript } from './types'
import { orderedPieces } from './editOps'
import { clipKeptSegments, TimeMap } from './tighten'

export type TransitionKind = NonNullable<ClipEditState['transitions']>[number]['kind']
export const TRANSITION_NAMES: Record<TransitionKind | 'cut', string> = {
  cut: 'None / Cut', 'fade-black': 'Fade through black', zoom: 'Zoom',
  dissolve: 'Dissolve', 'slide-left': 'Slide left', 'slide-right': 'Slide right', 'whip-pan': 'Whip pan (left)'
}
export const isOverlap = (kind: string): boolean => ['dissolve', 'slide-left', 'slide-right', 'whip-pan'].includes(kind)

/** Older projects have no flag. Only an explicitly disabled checkbox protects speech. */
export function allowsTransitionSpeechOverlap(edit: Pick<ClipEditState, 'allowTransitionSpeechOverlap'>): boolean {
  return edit.allowTransitionSpeechOverlap !== false
}

export interface OutputJoin {
  fromId: string
  toId: string
  time: number
  maxDuration: number
  duration: number
  kind: 'cut' | TransitionKind
  baseTime: number
  overlap: number
  maxPoint: number
  maxOverlap: number
  overlapReason?: string
  leftSourceEnd: number
  rightSourceStart: number
  leftDuration: number
  rightDuration: number
}

/** Overlap effects protect speech unless the user explicitly allows mixing it. Point effects
 * keep duration unchanged. Transitions belong to adjacent retained IDs; a
 * broken adjacency stays dormant and rejoining the same IDs restores it. */
export function outputJoins(clip: Pick<Clip, 'edit' | 'visualStory'>, transcript: Transcript | null): OutputJoin[] {
  const spans = clipKeptSegments(clip, transcript) ?? [clip.edit]
  const map = new TimeMap(spans)
  const pieces = orderedPieces(clip.edit).map(piece => ({ ...piece, spans: map.mapRange(piece) }))
    .filter(piece => piece.spans.length > 0)
  const speech = transcript ? [...(transcript.speech ?? []), ...transcript.segments.flatMap(s => s.words)] : []
  let removed = 0
  return pieces.slice(1).map((right, i) => {
    const left = pieces[i], tail = left.spans.at(-1)!, head = right.spans[0]
    // Use a midpoint to avoid ambiguous source timestamps at reordered joins.
    const leftEnd = map.toSource((tail.start + tail.end) / 2) + (tail.end - tail.start) / 2
    const rightStart = map.toSource(head.start)
    const leftDuration = tail.end - tail.start, rightDuration = head.end - head.start
    const maxPoint = Math.floor(Math.max(0, Math.min(1.5, leftDuration, rightDuration)) * 1000) / 1000
    let silentTail = leftDuration, silentHead = rightDuration
    for (const word of speech) {
      if (word.start < leftEnd && word.end > leftEnd - leftDuration) silentTail = Math.min(silentTail, Math.max(0, leftEnd - word.end - 0.05))
      if (word.end > rightStart && word.start < rightStart + rightDuration) silentHead = Math.min(silentHead, Math.max(0, word.start - rightStart - 0.05))
    }
    const protectSpeech = !allowsTransitionSpeechOverlap(clip.edit)
    const limit = Math.min(1.5, leftDuration / 2, rightDuration / 2,
      protectSpeech ? silentTail : Infinity, protectSpeech ? silentHead : Infinity)
    const maxOverlap = !protectSpeech || transcript ? Math.floor(Math.max(0, limit) * 1000 + 1e-6) / 1000 : 0
    const overlapReason = maxOverlap >= 0.1 ? undefined
      : Math.min(leftDuration, rightDuration) < 0.2 ? `Only ${leftDuration.toFixed(2)} s before / ${rightDuration.toFixed(2)} s after this join remains after cuts. At least 0.2 s on each side is needed; move the split or restore nearby cuts.`
        : !transcript ? 'No transcript: enable “Allow transitions over speech” to use these transitions.'
          : 'No pause on both sides: enable “Allow transitions over speech” to use these transitions.'
    const saved = clip.edit.transitions?.find(t => t.fromId === left.id && t.toId === right.id && Object.hasOwn(TRANSITION_NAMES, t.kind))
    const kind = saved?.kind ?? 'cut'
    const maxDuration = isOverlap(kind) ? maxOverlap : maxPoint
    const requested = saved && Number.isFinite(saved.duration) ? Math.max(0.1, saved.duration) : 0
    const duration = maxDuration >= 0.1 ? Math.min(maxDuration, requested) : 0
    const overlap = isOverlap(kind) ? duration : 0
    const time = head.start - removed - overlap / 2
    removed += overlap
    return { fromId: left.id, toId: right.id, kind, time, baseTime: head.start, maxDuration, duration, overlap, maxPoint, maxOverlap,
      overlapReason,
      leftSourceEnd: leftEnd, rightSourceStart: rightStart, leftDuration, rightDuration }
  })
}

/** Canonical playback clock including overlap; source annotations use the same offsets. */
export function playbackTimeMap(clip: Pick<Clip, 'edit' | 'visualStory'>, transcript: Transcript | null): TimeMap {
  const joins = outputJoins(clip, transcript)
  const kept = clipKeptSegments(clip, transcript) ?? [clip.edit]
  // Legacy splits are editable joins too, even before the first reorder.
  const segments = kept.flatMap(span => {
    const points = [span.start, ...joins.filter(j => j.overlap > 0).flatMap(j => [j.leftSourceEnd, j.rightSourceStart]).filter(t => t > span.start && t < span.end), span.end]
    const bounds = [...new Set(points)].sort((a, b) => a - b)
    return bounds.slice(0, -1).map((start, i) => ({ start, end: bounds[i + 1] }))
  })
  return new TimeMap(segments, segments.map(s => joins.find(j => j.rightSourceStart === s.start)?.overlap ?? 0))
}

/** A bounded two-piece render for the exact export transition, without AI work. */
export function joinPreviewClip(clip: Clip, join: OutputJoin): Clip {
  const tail = Math.min(join.leftDuration, join.duration * 2 + 0.35)
  const head = Math.min(join.rightDuration, join.duration * 2 + 0.35)
  const left = { layout: clip.edit.sequence?.find(p => p.id === join.fromId)?.layout, id: join.fromId, start: join.leftSourceEnd - tail, end: join.leftSourceEnd }
  const right = { layout: clip.edit.sequence?.find(p => p.id === join.toId)?.layout, id: join.toId, start: join.rightSourceStart, end: join.rightSourceStart + head }
  return { ...clip, edit: { ...clip.edit, start: Math.min(left.start, right.start), end: Math.max(left.end, right.end),
    sequence: [left, right], cuts: [], restored: [], splits: [], tightenCuts: false, autoZoom: false,
    transitions: join.kind === 'cut' ? [] : [{ fromId: left.id, toId: right.id, kind: join.kind, duration: join.duration }] } }
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
    const from = join.baseTime - half, until = join.baseTime + half
    return [
      `fade=t=out:st=${from}:d=${half}:enable='gte(t,${from})*lt(t,${join.baseTime})'`,
      `fade=t=in:st=${join.baseTime}:d=${half}:enable='gte(t,${join.baseTime})*lt(t,${until})'`
    ]
  })
  const zooms = joins.filter(j => j.kind === 'zoom' && j.duration > 0)
  if (zooms.length) {
    const rate = Number.isFinite(fps) && fps > 0 && fps <= 240 ? fps : 30
    // perspective evaluates by frame index: normalize VFR before using that clock.
    filters.unshift(`fps=${rate}`)
    const ramps = zooms.map(j => `pow(max(0,1-abs(in/${rate}-${j.baseTime})/${j.duration / 2}),2)`)
    const z = `(1+${TRANSITION_ZOOM_AMOUNT}*(${ramps.join('+')}))`
    const left = `(W-W/${z})/2`, right = `W-(W-W/${z})/2`
    const top = `(H-H/${z})/2`, bottom = `H-(H-H/${z})/2`
    filters.push(`perspective=x0='${left}':y0='${top}':x1='${right}':y1='${top}':` +
      `x2='${left}':y2='${bottom}':x3='${right}':y3='${bottom}':interpolation=cubic:eval=frame`)
  }
  return filters
}

/** Commit an editable duration only after blur/Enter; empty/invalid input cancels. */
export function parseTransitionDuration(text: string, current: number, maximum: number): number {
  const raw = text.trim().replace(',', '.')
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) ? Math.max(0.1, Math.min(maximum, parsed)) : current
}
