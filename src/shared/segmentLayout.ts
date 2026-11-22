import { detailCaptionRanges } from './contentType'
import type { TimeMap } from './tighten'
import { validComposition } from './composition'
import { sequenceWithTrim } from './sequence'
import type { Clip, GamingProfile, SegmentLayout, TimeRange } from './types'

export function normalizeProfiles(value: unknown): GamingProfile[] {
  if (!Array.isArray(value)) return []
  const names = new Set<string>()
  return value.filter((p): p is GamingProfile => {
    if (!p || typeof p.name !== 'string' || !p.name.trim() || typeof p.sourcePath !== 'string' ||
      p.composition?.preset !== 'gaming' || !validComposition(p.composition)) return false
    const key = p.name.trim().toLowerCase()
    if (names.has(key)) return false
    names.add(key)
    return true
  })
}

export function segmentLayoutAt(clip: Clip, time: number): SegmentLayout | undefined {
  return sequenceWithTrim(clip.edit)?.find(p => time >= p.start && time < p.end)?.layout
}

/** Resolve one kept source span before concatenation and join effects. */
export function segmentClip(clip: Clip, span: TimeRange): Clip {
  const layout = segmentLayoutAt(clip, (span.start + span.end) / 2)
  const edit = { ...clip.edit, start: span.start, end: span.end }
  if (!layout) return { ...clip, edit }
  const composition = clip.edit.aspect === '9:16' && validComposition(layout.composition) ? layout.composition : undefined
  return { ...clip, focusTrack: null,
    edit: { ...edit, autoZoom: false, framing: composition ? 'auto' : 'manual', compositionPreference: 'auto',
      reframeMode: layout.mode, focusX: layout.focusX },
    visualLayout: composition ? { ...span, preserveContext: true, allowZoom: false, reason: 'Segment layout',
      shots: [{ ...span, mode: 'fit', composition }] } : undefined }
}

export function segmentCaptionRanges(clip: Clip, map: TimeMap): ReturnType<typeof detailCaptionRanges> {
  return map.segments.flatMap(span => detailCaptionRanges(segmentClip(clip, span)).flatMap(range => {
    const start = Math.max(span.start, range.start), end = Math.min(span.end, range.end)
    return end > start ? map.mapRange({ ...range, start, end }) : []
  }))
}
