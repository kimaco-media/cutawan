import { describe, expect, it } from 'vitest'
import { clipKeptSegments, remapFocusTrack, remapTranscript, TimeMap } from '@shared/tighten'
import { cutRange, movePiece, orderedPieces, splitAt, toggleRestored } from '@shared/editOps'
import { clearHistory, recordSave, redo, trackClip, undo } from '@shared/editHistory'
import { focusAt } from '@shared/focusTrack'
import { captionLayoutBudget, groupDisplayEnd, groupWords, wordsInRange } from '@shared/captionLayout'
import { resolveCaptionStyle } from '@shared/captionStyles'
import type { Clip, ClipEditState } from '@shared/types'
import { remapClipTimeline } from '@shared/remapClip'
import { automaticLayoutShots, detailCaptionRanges } from '@shared/contentType'
import { gamingComposition } from '@shared/composition'
import { makeTranscript } from './helpers'

const original = { start: 0, end: 9 } as ClipEditState
function reordered(): ClipEditState {
  const edit = splitAt(splitAt(original, 3), 6)
  const pieces = orderedPieces(edit)
  return movePiece(edit, pieces[2].id, pieces[0].id)
}

describe('ordered output sequence', () => {
  it('migrates lazily, persists stable IDs, and records undo/redo', () => {
    expect(clipKeptSegments({ edit: original }, null)).toBeNull()
    clearHistory()
    const clip = { id: 'sequence', edit: original } as Clip
    trackClip(clip)
    const changed = { ...clip, edit: reordered() }
    recordSave(changed)
    const restored = JSON.parse(JSON.stringify(changed)) as Clip
    expect(orderedPieces(restored.edit).map(p => p.start)).toEqual([6, 0, 3])
    const previous = undo(restored)!
    expect(previous.edit.sequence).toBeUndefined()
    expect(redo(previous)!.edit.sequence).toEqual(changed.edit.sequence)
  })

  it('preserves order and IDs through splitting, cutting and source trimming', () => {
    const edit = reordered()
    const split = splitAt(edit, 7)
    expect(split.sequence?.map(p => p.start)).toEqual([6, 7, 0, 3])
    expect(split.sequence?.[0].id).toBe(edit.sequence?.[0].id)
    const cut = cutRange(split, { start: 1, end: 4 })
    expect(clipKeptSegments({ edit: { ...cut, start: 0.5, end: 8 } }, null)).toEqual([
      { start: 6, end: 7 }, { start: 7, end: 8 }, { start: 0.5, end: 1 }, { start: 4, end: 6 }
    ])
    expect(clipKeptSegments({ edit: { ...edit, end: 10 } }, null)?.[0]).toEqual({ start: 6, end: 10 })
  })

  it('maps exact boundaries and seeks/plays forward and backward across joins', () => {
    const map = new TimeMap(clipKeptSegments({ edit: reordered() }, null)!)
    expect([0, 2, 3, 5, 6, 9].map(t => map.toSource(t))).toEqual([6, 8, 0, 2, 3, 6])
    expect([0, 3, 6, 8].map(t => map.toOutput(t))).toEqual([3, 6, 0, 2])
    expect(map.advance(9.02, 0)).toEqual({ time: 0, index: 1 })
    expect(map.advance(3.01, 1)).toEqual({ time: 3, index: 2 })
    expect(map.advance(6, 2)).toEqual({ time: 6, index: 0 })
    expect(map.toSource(map.toOutput(0) - 0.1)).toBeCloseTo(8.9)
    expect(map.mapRange({ start: 2, end: 7, value: 'layout' })).toEqual([
      { start: 0, end: 1, value: 'layout' }, { start: 5, end: 6, value: 'layout' }, { start: 6, end: 9, value: 'layout' }
    ])
  })

  it('retains order when tightening and restoring pauses', () => {
    const transcript = makeTranscript(['one two three', 'four five six'], { sentenceGapSec: 4 })
    const edit = { ...reordered(), tightenCuts: true }
    const restored = toggleRestored(edit, { start: 2, end: 5 })
    const spans = clipKeptSegments({ edit: restored }, transcript)!
    expect(spans[0].start).toBeGreaterThanOrEqual(6)
    expect(spans.some(r => r.start <= 2 && r.end >= 3)).toBe(true)
    expect(restored.sequence).toEqual(edit.sequence)
  })

  it('orders captions and prevents groups or held words leaking across joins', () => {
    const transcript = makeTranscript(['a b c d e f g h i'], { wordSec: 0.8, gapSec: 0.2 })
    const map = new TimeMap(clipKeptSegments({ edit: reordered() }, null)!)
    const mapped = remapTranscript(transcript, map, 0, 9)
    const words = wordsInRange(mapped, 0, 9)
    expect(words.map(w => w.text)).toEqual(['g', 'h', 'i', 'a', 'b', 'c', 'd', 'e', 'f'])
    const groups = groupWords(words, captionLayoutBudget(resolveCaptionStyle('bold'), 9 / 16))
    groups.forEach((group, i) => {
      expect(new Set(group.words.map(w => w.timelineEnd)).size).toBe(1)
      expect(groupDisplayEnd(groups, i, 9)).toBeLessThanOrEqual(group.words[0].timelineEnd!)
    })
  })

  it('keeps gaming crops and caption placement through reordered multi-shot layouts', () => {
    const composition = gamingComposition({ x: .7, y: .03, width: .27, height: .3 },
      { x: .01, y: .01, width: .98, height: .98 })!
    const clip = { edit: { ...reordered(), aspect: '9:16', reframeMode: 'crop', framing: 'auto' },
      broll: [], focusTrack: null,
      visualLayout: { start: 0, end: 9, preserveContext: true, allowZoom: false, reason: 'gaming', shots: [
        { start: 0, end: 4, mode: 'fit', composition }, { start: 4, end: 9, mode: 'crop' }
      ] } } as unknown as Clip
    const map = new TimeMap(clipKeptSegments(clip, null)!)
    const output = remapClipTimeline(clip, map)
    expect(automaticLayoutShots(output).map(s => [s.start, s.end, s.mode])).toEqual([
      [0, 3, 'crop'], [3, 6, 'fit'], [6, 7, 'fit'], [7, 9, 'crop']
    ])
    expect(automaticLayoutShots(output)[1].composition).toEqual(composition)
    expect(detailCaptionRanges(output)).toEqual([
      { start: 3, end: 6, positionY: composition.captionY }, { start: 6, end: 7, positionY: composition.captionY }
    ])
  })

  it('carries clipped focus pans and hard camera cuts to the new locations', () => {
    const track = [{ t: 0, x: 0.2 }, { t: 2, x: 0.4, pan: 2 }, { t: 6, x: 0.8, cut: true }]
    const map = new TimeMap([{ start: 6, end: 8 }, { start: 2.5, end: 3.5 }, { start: 0, end: 2 }])
    const mapped = remapFocusTrack(track, map)
    for (let t = 0; t < map.outputDuration; t += 1 / 60) {
      expect(focusAt(mapped, t)).toBeCloseTo(focusAt(track, map.toSource(t)), 2)
    }
  })
})
