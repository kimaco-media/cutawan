import { sequenceWithTrim } from './sequence'
import type { Clip, ClipEditState, TimeRange, Transcript } from './types'
import { editedClipDuration, normalizeRanges } from './tighten'

/**
 * Pure timeline edits shared by keyboard shortcuts, the timeline and the
 * transcript. Each returns a new edit state; the caller saves it (and records
 * undo history). Times are source seconds.
 */

/** Razor points closer than this to an existing point or a clip edge are ignored. */
const SPLIT_TOLERANCE_SEC = 0.05
/** The trim never shrinks below this. */
export const MIN_CLIP_SEC = 1

/** Add a razor point at `t` (inside the trim). */
export function splitAt(edit: ClipEditState, t: number): ClipEditState {
  if (t <= edit.start + SPLIT_TOLERANCE_SEC || t >= edit.end - SPLIT_TOLERANCE_SEC) return edit
  const splits = edit.splits ?? []
  if (splits.some(s => Math.abs(s - t) < SPLIT_TOLERANCE_SEC)) return edit
  const sequence = sequenceWithTrim(edit)?.flatMap(p => t > p.start + SPLIT_TOLERANCE_SEC && t < p.end - SPLIT_TOLERANCE_SEC
    ? [{ ...p, end: t }, { ...p, id: `${p.id}@${t}`, start: t, ...(p.layout ? { layout: structuredClone(p.layout) } : {}) }] : [p])
  return { ...edit, splits: [...splits, t].sort((a, b) => a - b), ...(sequence ? { sequence } : {}) }
}

/** Pieces between the trim edges and razor points, in order. */
export function timelinePieces(edit: ClipEditState): TimeRange[] {
  const bounds = [edit.start, ...(edit.splits ?? []).filter(s => s > edit.start && s < edit.end).sort((a, b) => a - b), edit.end]
  return bounds.slice(0, -1).map((start, i) => ({ start, end: bounds[i + 1] }))
}

/** The piece containing `t`; none outside the trim. */
export function pieceAt(edit: ClipEditState, t: number): TimeRange | undefined {
  const pieces = timelinePieces(edit)
  return pieces.find(p => t >= p.start && t < p.end) ?? (t === edit.end ? pieces.at(-1) : undefined)
}

/** Remove a source range from playback (ripple: later material closes the gap). */
export function cutRange(edit: ClipEditState, range: TimeRange): ClipEditState {
  const cuts = normalizeRanges([...(edit.cuts ?? []), range], edit.start, edit.end)
  const sequence = edit.sequence?.map(piece => piece.layout && cuts.some(c => c.start <= piece.start && c.end >= piece.end)
    ? { ...piece, layout: undefined } : piece)
  return { ...edit, cuts, ...(sequence ? { sequence } : {}) }
}

/** Put back the user cut containing `t`. */
export function uncutAt(edit: ClipEditState, t: number): ClipEditState {
  const cuts = (edit.cuts ?? []).filter(c => !(t >= c.start && t <= c.end))
  return cuts.length === (edit.cuts ?? []).length ? edit : { ...edit, cuts }
}

/** Keep a pause that automatic removal took out, or remove it again. */
export function toggleRestored(edit: ClipEditState, pause: TimeRange): ClipEditState {
  const restored = edit.restored ?? []
  const existing = restored.find(r => r.start < pause.end && r.end > pause.start)
  return { ...edit, restored: existing ? restored.filter(r => r !== existing) : [...restored, { ...pause }] }
}

/**
 * The source range covering transcript words [first, last] (indices into the
 * clip's words), with each edge halfway into the neighbouring gap so the cut
 * falls between words rather than on them.
 */
export function wordsRange(
  words: Array<{ start: number; end: number }>, first: number, last: number
): TimeRange {
  const a = words[first], b = words[last]
  const before = words[first - 1], after = words[last + 1]
  const start = before ? Math.max(before.end, (before.end + a.start) / 2) : a.start
  const end = after ? Math.min(after.start, (b.end + after.start) / 2) : b.end
  return { start, end }
}

/** Words of `transcript` inside the trim, in order (same set the editor shows). */
export function clipWords(transcript: Transcript, start: number, end: number): Array<{ start: number; end: number; text: string }> {
  return transcript.segments.flatMap(s => s.words).filter(w => {
    const mid = (w.start + w.end) / 2
    return mid >= start && mid <= end
  }).sort((a, b) => a.start - b.start)
}

/** Set the in or out point at `t`, keeping at least MIN_CLIP_SEC. */
export function setTrimEdge(edit: ClipEditState, which: 'start' | 'end', t: number): ClipEditState {
  if (which === 'start') return { ...edit, start: Math.max(0, Math.min(t, edit.end - MIN_CLIP_SEC)) }
  return { ...edit, end: Math.max(t, edit.start + MIN_CLIP_SEC) }
}

/** A cut must leave something to play: never less than MIN_CLIP_SEC. */
export function keepsPlayback(clip: Pick<Clip, 'edit' | 'visualStory'>, transcript: Transcript | null): boolean {
  return editedClipDuration(clip, transcript) >= MIN_CLIP_SEC
}

/** Lazily migrate source-order projects without changing their saved edits. */
export function orderedPieces(edit: ClipEditState): NonNullable<ClipEditState['sequence']> {
  return sequenceWithTrim(edit) ?? timelinePieces(edit).map(p => ({ ...p, id: `source:${p.start}` }))
}

/** Move before an ID, or to the end. Source references and IDs stay unchanged. */
export function movePiece(edit: ClipEditState, id: string, before: string | null): ClipEditState {
  const sequence = orderedPieces(edit)
  const piece = sequence.find(p => p.id === id)
  if (!piece || id === before || (before !== null && !sequence.some(p => p.id === before))) return edit
  const rest = sequence.filter(p => p.id !== id)
  rest.splice(before === null ? rest.length : rest.findIndex(p => p.id === before), 0, piece)
  return { ...edit, sequence: rest }
}
