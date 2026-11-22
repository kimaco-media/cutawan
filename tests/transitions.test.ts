import { describe, expect, it } from 'vitest'
import type { Clip, Transcript } from '@shared/types'
import { outputJoins, playbackTimeMap, joinPreviewClip, transitionOpacity, transitionZoom, transitionFilters, parseTransitionDuration } from '@shared/transitions'
import { editedClipDuration, remapTranscript } from '@shared/tighten'
import { movePiece, splitAt, cutRange } from '@shared/editOps'
import { clearHistory, trackClip, recordSave, undo, redo } from '@shared/editHistory'

export const silent: Transcript = { language: 'en', durationSec: 12, segments: [] }
export function transitionClip(): Clip {
  return { id: 'transitions', suggestedStart: 0, suggestedEnd: 12, title: 'Transition', hook: '', summary: '',
    viralityScore: 50, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null, broll: [], focusTrack: null, edit: {
    start: 0, end: 12, aspect: '9:16', reframeMode: 'crop', framing: 'manual',
    focusX: 0.5, captionStyleId: 'bold', tightenCuts: false, captionsEnabled: false, showTitle: false,
    sequence: [{ id: 'a', start: 0, end: 4 }, { id: 'b', start: 4, end: 8 }, { id: 'c', start: 8, end: 12 }],
    transitions: [{ fromId: 'a', toId: 'b', kind: 'dissolve', duration: 0.8 },
      { fromId: 'b', toId: 'c', kind: 'slide-left', duration: 0.6 }]
  } }
}

describe('transition timeline', () => {
  it('keeps legacy projects as identical cuts and applies no filters', () => {
    const clip = transitionClip()
    delete clip.edit.sequence
    delete clip.edit.transitions
    clip.edit.splits = [4, 8]
    const joins = outputJoins(clip, null)
    expect(joins.map(j => [j.kind, j.duration])).toEqual([['cut', 0], ['cut', 0]])
    expect(transitionFilters(joins)).toEqual([])
    expect(playbackTimeMap(clip, null).outputDuration).toBe(12)
    expect(editedClipDuration(clip, null)).toBe(12)
  })

  it('shares overlap offsets across duration, seeking and caption words', () => {
    const clip = transitionClip()
    const transcript: Transcript = { ...silent, segments: [0.5, 5, 9.2].map((start, id) => ({
      id, start, end: start + 0.5, text: `word${id}`, words: [{ start, end: start + 0.5, text: `word${id}` }]
    })) }
    const joins = outputJoins(clip, transcript)
    expect(joins[0].time).toBeCloseTo(3.6)
    expect(joins[1].time).toBeCloseTo(6.9)
    const map = playbackTimeMap(clip, transcript)
    expect(map.outputDuration).toBeCloseTo(10.6)
    expect(editedClipDuration(clip, transcript)).toBeCloseTo(map.outputDuration)
    expect(map.toSource(3.5)).toBe(3.5)
    const clocks = map.sourcesAt(3.5)
    expect(clocks.map(c => c.segmentIndex)).toEqual([0, 1])
    expect(clocks[0].sourceTime).toBeCloseTo(3.5)
    expect(clocks[1].sourceTime).toBeCloseTo(4.3)
    expect(map.toSource(4)).toBeCloseTo(4.8)
    expect(map.advance(4, 0)).toEqual({ time: 4.8, index: 1 })
    const words = remapTranscript(transcript, map, 0, 12).segments.flatMap(s => s.words)
    expect(words.map(w => w.text)).toEqual(['word0', 'word1', 'word2'])
    expect(words.map(w => Number(w.start.toFixed(2)))).toEqual([0.5, 4.2, 7.8])
  })

  it('clamps overlap to speech-free handles and respects VAD and missing transcripts', () => {
    const clip = transitionClip()
    expect(outputJoins(clip, null)[0].overlap).toBe(0)
    expect(outputJoins(clip, null)[0].overlapReason).toContain('transcript')
    const transcript = { ...silent, speech: [{ start: 2, end: 3.7 }, { start: 4.4, end: 5 }] }
    expect(outputJoins(clip, transcript)[0].overlap).toBeCloseTo(0.25, 2)
    expect(outputJoins(clip, { ...silent, speech: [{ start: 3, end: 5 }] })[0].overlap).toBe(0)
    expect(editedClipDuration(clip, null)).toBe(12)
  })

  it('lets users enable transitions during speech or without a transcript, with undo and persistence', () => {
    clearHistory()
    const original = transitionClip()
    trackClip(original)
    const clip = { ...original, edit: { ...original.edit, allowTransitionSpeechOverlap: true } }
    recordSave(clip)
    const speech = { ...silent, speech: [{ start: 0, end: 12 }] }
    expect(outputJoins(clip, speech)[0].overlap).toBe(0.8)
    expect(outputJoins(clip, null)[0].overlap).toBe(0.8)
    expect(outputJoins(clip, null)[0].overlapReason).toBeUndefined()
    expect(outputJoins(JSON.parse(JSON.stringify(clip)), null)[0].overlap).toBe(0.8)
    expect(outputJoins(undo(clip)!, null)[0].overlap).toBe(0)
    const preview = joinPreviewClip(clip, outputJoins(clip, null)[0])
    expect(outputJoins(preview, null)[0].overlap).toBe(0.8)
    expect(editedClipDuration(clip, null)).toBeCloseTo(10.6)
  })

  it('still rejects too-short edges when speech overlap is allowed', () => {
    const clip = transitionClip()
    clip.edit.allowTransitionSpeechOverlap = true
    clip.edit.cuts = [{ start: 0, end: 3.9 }]
    const join = outputJoins(clip, null)[0]
    expect(join.overlap).toBe(0)
    expect(join.overlapReason).toContain('0.2 s')
  })

  it('preserves adjacency through persistence, undo, reorder and split', () => {
    clearHistory()
    const clip = transitionClip()
    trackClip(clip)
    const moved = { ...clip, edit: movePiece(clip.edit, 'b', 'a') }
    recordSave(moved)
    expect(outputJoins(moved, silent).every(j => j.duration === 0)).toBe(true)
    const restored = JSON.parse(JSON.stringify(undo(moved))) as Clip
    expect(outputJoins(restored, silent)[0].kind).toBe('dissolve')
    expect(redo(restored)?.edit.sequence?.[0].id).toBe('b')
    const split = { ...clip, edit: splitAt(clip.edit, 2) }
    expect(outputJoins(split, silent)[1].duration).toBe(0)
    const cut = { ...clip, edit: cutRange(clip.edit, { start: 4, end: 8 }) }
    expect(outputJoins(cut, silent)[0].duration).toBe(0)
  })

  it('clamps short trims and pause cuts without removing speech or making negative times', () => {
    const clip = transitionClip()
    clip.edit.cuts = [{ start: 0, end: 3.8 }]
    const join = outputJoins(clip, silent)[0]
    expect(join.maxOverlap).toBeLessThanOrEqual(0.1)
    expect(join.duration).toBeLessThanOrEqual(join.maxOverlap)
    expect(playbackTimeMap(clip, silent).outputDuration).toBeGreaterThan(0)
  })

  it('builds bounded previews that keep the chosen overlap and reordered source IDs', () => {
    const clip = transitionClip()
    clip.edit.sequence = [clip.edit.sequence![2], clip.edit.sequence![0], clip.edit.sequence![1]]
    const join = outputJoins(clip, silent).find(j => j.fromId === 'a')!
    const preview = joinPreviewClip(clip, join)
    expect(outputJoins(preview, silent)[0].overlap).toBe(join.overlap)
    expect(preview.edit.sequence?.map(p => p.id)).toEqual(['a', 'b'])
    expect(editedClipDuration(preview, silent)).toBeLessThan(7)
    expect(preview.edit.autoZoom).toBe(false)
  })

  it('keeps point effects and their preview curves distinct and time-preserving', () => {
    const clip = transitionClip()
    clip.edit.transitions![0].kind = 'fade-black'
    clip.edit.transitions![1].kind = 'zoom'
    const joins = outputJoins(clip, null)
    expect(editedClipDuration(clip, null)).toBe(12)
    expect(transitionOpacity(joins, 4)).toBe(1)
    expect(transitionOpacity(joins, 8)).toBe(0)
    expect(transitionZoom(joins, 8)).toBeCloseTo(1.8)
    expect(transitionZoom(joins, 9)).toBe(1)
    expect(transitionFilters(joins, 60).join(',')).toContain('perspective=')
  })

  it('commits decimal durations without clobbering incomplete or cancelled input', () => {
    expect(parseTransitionDuration('0,75', 0.4, 1.5)).toBe(0.75)
    expect(parseTransitionDuration('', 0.4, 1.5)).toBe(0.4)
    expect(parseTransitionDuration('bad', 0.4, 1.5)).toBe(0.4)
    expect(parseTransitionDuration('4', 0.4, 1.5)).toBe(1.5)
    expect(parseTransitionDuration('0', 0.4, 1.5)).toBe(0.1)
  })
})
