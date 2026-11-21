import type { ClipEditState } from './types'

/** Extend the outer source edges when the source trim is widened, preserving order. */
export function sequenceWithTrim(edit: ClipEditState): ClipEditState['sequence'] {
  if (!edit.sequence?.length) return edit.sequence
  const first = Math.min(...edit.sequence.map(p => p.start))
  const last = Math.max(...edit.sequence.map(p => p.end))
  return edit.sequence.map(p => ({ ...p,
    start: p.start === first ? Math.min(edit.start, p.start) : p.start,
    end: p.end === last ? Math.max(edit.end, p.end) : p.end
  }))
}
