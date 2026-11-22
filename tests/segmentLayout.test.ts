import { expect, it } from 'vitest'
import { gamingComposition } from '@shared/composition'
import { movePiece, orderedPieces, pieceIdAt, splitAndSelect, splitAt } from '@shared/editOps'
import { segmentClip, normalizeProfiles } from '@shared/segmentLayout'
import type { Clip } from '@shared/types'

const composition = gamingComposition({ x: .1, y: .1, width: .3, height: .3 }, { x: 0, y: 0, width: 1, height: 1 })!
it('retains independent segment snapshots through splitting, reorder and serialization', () => {
  const clip = { edit: { start: 0, end: 3, aspect: '9:16', focusX: .8, sequence: [
    { id: 'a', start: 0, end: 2, layout: { mode: 'crop', focusX: .3, composition } },
    { id: 'b', start: 2, end: 3 }
  ] } } as Clip
  clip.edit = movePiece(splitAt(clip.edit, 1), 'b', 'a')
  const sequence = clip.edit.sequence!
  expect(sequence.map(p => p.id)).toEqual(['b', 'a', 'a@1'])
  expect(segmentClip(clip, sequence[0]).edit.focusX).toBe(.8)
  sequence[2].layout = { mode: 'crop', focusX: .2 }
  expect(segmentClip(JSON.parse(JSON.stringify(clip)), sequence[1]).visualLayout?.shots?.[0].composition).toEqual(composition)
  expect(segmentClip(clip, sequence[2]).visualLayout).toBeUndefined()
})

it('loads named local profiles and discards malformed or duplicate entries', () => {
  const valid = { name: 'Reaction', composition, sourcePath: 'source.mp4' }
  expect(normalizeProfiles(JSON.parse(JSON.stringify([valid, { ...valid, name: 'reaction' }, null,
    { ...valid, composition: {} }])))).toEqual([valid])
  expect(normalizeProfiles(undefined)).toEqual([])
})

it('targets the new right-hand segment when applying a saved profile after a second split', () => {
  const initial = { start: 0, end: 9 } as Clip['edit']
  const first = splitAndSelect(initial, 3)!
  const pieces = orderedPieces(first.edit)
  const profiles = ['Profil1', 'Profil2'].map((name, i) => ({
    mode: 'crop' as const, focusX: .5, profileName: name,
    composition: gamingComposition(composition.layers[0].source, composition.layers[1].source, i ? .35 : .25)!
  }))
  const edit = { ...first.edit, sequence: pieces.map((p, i) => ({ ...p, layout: profiles[i] })) }
  const second = splitAndSelect(edit, 6)!
  expect(second.selectedId).toBe(second.edit.sequence![2].id)
  expect(pieceIdAt(second.edit, 6.5)).toBe(second.selectedId)
  expect(second.edit.sequence![2].layout).toEqual(profiles[1])
  const applied = second.edit.sequence!.map(p => p.id === second.selectedId ? profiles[0] : p.layout)
  expect(applied).toEqual([profiles[0], profiles[1], profiles[0]])
  expect(splitAndSelect(second.edit, 6)).toBeNull()
})
