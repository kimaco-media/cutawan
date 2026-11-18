import { describe, expect, it } from 'vitest'
import type { Composition, ContentRegion } from '@shared/types'
import {
  compositionPixels,
  gamingComposition,
  presenterComposition,
  validComposition
} from '@shared/composition'
import {
  MIN_REGION_SIDE,
  compositionDraftIssue,
  draftComposition,
  draftFromComposition,
  dragRegion,
  initialSelectedRole,
  nudgeRegion,
  parsePercent,
  pointerToSource,
  regionAt,
  regionBoundsIssue,
  resizeRegion,
  type RegionDraft
} from '@shared/regionEditor'

const facecam = { x: .70, y: .03, width: .27, height: .30 }
const gameplay = { x: .01, y: .01, width: .98, height: .98 }
const gaming = gamingComposition(facecam, gameplay)!
const stacked = presenterComposition({ x: .05, y: .35, width: .75, height: .6 },
  { x: .82, y: .02, width: .16, height: .28 }, 'stacked')!

describe('visual region editor geometry', () => {
  it('maps container pixels to normalized source coordinates, clamped to the frame', () => {
    const container = { width: 1280, height: 720 }
    expect(pointerToSource({ x: 640, y: 360 }, container)).toEqual({ x: .5, y: .5 })
    expect(pointerToSource({ x: 0, y: 0 }, container)).toEqual({ x: 0, y: 0 })
    expect(pointerToSource({ x: 1280, y: 720 }, container)).toEqual({ x: 1, y: 1 })
    // Beyond the stage (dragging out of the window) clamps inside, so drags
    // can never carry a region out of the source frame.
    expect(pointerToSource({ x: -50, y: 800 }, container)).toEqual({ x: 0, y: 1 })
    expect(pointerToSource({ x: 5000, y: -1 }, container)).toEqual({ x: 1, y: 0 })
  })

  it('drags by the grab offset and stops at every frame edge', () => {
    const region: ContentRegion = { x: .2, y: .3, width: .4, height: .2 }
    // Grab offset .3/.4 (pointer at .5/.7); moving the pointer to .1/.1 pulls
    // the top-left to -.2/-.3, clamped to the frame.
    const moved = dragRegion(region, { x: .3, y: .4 }, { x: .1, y: .1 })
    expect(moved).toEqual({ x: 0, y: 0, width: .4, height: .2 })
    // Pointer to .95/.95 wants the top-left at .75/.65; clamped to the right
    // and bottom frame edges.
    expect(dragRegion(region, { x: .2, y: .3 }, { x: .95, y: .95 }))
      .toEqual({ x: .6, y: .65, width: .4, height: .2 })
    // The size never changes while moving.
    expect(dragRegion(region, { x: .6, y: .5 }, { x: .601, y: .501 }).width).toBe(.4)
  })

  it('follows the pointer exactly from a nonzero origin, without jump or drift', () => {
    const region: ContentRegion = { x: .3, y: .25, width: .2, height: .15 }
    // Pointer-down inside the region at (.35, .3): the grab offset from the
    // top-left is what the drag captures.
    const grab = { x: .35 - region.x, y: .3 - region.y }
    // No movement at all: same pointer position leaves the region untouched.
    expect(dragRegion(region, grab, { x: .35, y: .3 })).toEqual(region)
    // The first move lands exactly where the grab point maps — no jump by the
    // region's own origin, no dependence on how many moves came before.
    expect(dragRegion(region, grab, { x: .5, y: .4 }))
      .toEqual({ x: .45, y: .35, width: .2, height: .15 })
    // A long series of pointer moves tracks without cumulative drift, and
    // drags while overlapping another region behave identically.
    const draft = draftFromComposition(gaming)
    let moved = region
    for (let i = 0; i < 50; i++) {
      const pointer = { x: .35 + i * .01, y: .3 - i * .002 }
      moved = dragRegion(moved, grab, pointer)
      expect(moved.x).toBeCloseTo(pointer.x - grab.x, 5)
      expect(moved.y).toBeCloseTo(pointer.y - grab.y, 5)
      expect(moved.width).toBe(.2)
      expect(moved.height).toBe(.15)
      expect(regionAt(draft, { x: moved.x, y: moved.y })).not.toBeNull()
    }
    // After the whole series the region sits exactly where the pointer says.
    expect(moved.x).toBeCloseTo((.35 + 49 * .01) - grab.x, 5)
  })

  it('resizes against the opposite edge with frame and minimum-side clamping', () => {
    const region: ContentRegion = { x: .1, y: .1, width: .3, height: .3 }
    expect(resizeRegion(region, 'e', { x: .8, y: .25 })).toEqual({ x: .1, y: .1, width: .7, height: .3 })
    // East drag beyond the right edge clamps to the edge, not past it.
    const farEast = resizeRegion(region, 'e', { x: 1.5, y: .25 })
    expect(farEast.x + farEast.width).toBe(1)
    // Shrinking below the minimum side holds the minimum.
    expect(resizeRegion(region, 'e', { x: .11, y: .25 }).width).toBe(MIN_REGION_SIDE)
    // West edge drag keeps the right edge fixed and clamps at the frame.
    const west = resizeRegion(region, 'w', { x: -.2, y: .25 })
    expect(west).toEqual({ x: 0, y: .1, width: .4, height: .3 })
    const northWest = resizeRegion(region, 'nw', { x: .05, y: .05 })
    expect(northWest).toEqual({ x: .05, y: .05, width: .35, height: .35 })
    const south = resizeRegion(region, 's', { x: .2, y: .95 })
    expect(south).toEqual({ x: .1, y: .1, width: .3, height: .85 })
  })

  it('nudges by whole steps without leaving the frame', () => {
    const region: ContentRegion = { x: .5, y: .5, width: .3, height: .3 }
    expect(nudgeRegion(region, -.02, -.02)).toEqual({ x: .48, y: .48, width: .3, height: .3 })
    expect(nudgeRegion(region, -1, -1)).toEqual({ x: 0, y: 0, width: .3, height: .3 })
    expect(nudgeRegion(region, 1, 1)).toEqual({ x: .7, y: .7, width: .3, height: .3 })
  })

  it('picks the smallest region under a point so overlaps stay editable', () => {
    const draft = draftFromComposition(gaming)
    expect(regionAt(draft, { x: .8, y: .1 })).toBe('presenter')
    expect(regionAt(draft, { x: .5, y: .9 })).toBe('content')
    expect(regionAt(draft, { x: .995, y: .995 })).toBeNull()
  })

  it('commits nothing while a percentage field is cleared or half-typed', () => {
    // Number('') is 0, not NaN — clearing a field must not snap a region to 0.
    expect(parsePercent('')).toBeUndefined()
    expect(parsePercent('   ')).toBeUndefined()
    expect(parsePercent('abc')).toBeUndefined()
    expect(parsePercent('-')).toBeUndefined()
    expect(parsePercent('0')).toBe(0)
    expect(parsePercent('3.5')).toBeCloseTo(.035, 10)
    expect(parsePercent(' 41 ')).toBeCloseTo(.41, 10)
  })

  it('reports specific bounds problems for hand-typed values', () => {
    expect(regionBoundsIssue('Facecam', { x: -.1, y: 0, width: .2, height: .2 })).toMatch(/left edge/)
    expect(regionBoundsIssue('Facecam', { x: 0, y: -.1, width: .2, height: .2 })).toMatch(/top edge/)
    expect(regionBoundsIssue('Facecam', { x: .9, y: 0, width: .2, height: .2 })).toMatch(/right edge/)
    expect(regionBoundsIssue('Gameplay', { x: 0, y: .9, width: .2, height: .2 })).toMatch(/bottom edge/)
    expect(regionBoundsIssue('Facecam', { x: 0, y: 0, width: .01, height: .2 })).toMatch(/too small/)
    expect(regionBoundsIssue('Facecam', { x: Number.NaN, y: 0, width: .2, height: .2 })).toMatch(/number/)
    expect(regionBoundsIssue('Facecam', facecam)).toBeUndefined()
  })
})

describe('draft validation and composition building', () => {
  it('allows overlapping regions for Gaming and builds with split and focus preserved', () => {
    const withFocus = gamingComposition(facecam, gameplay, .35)!
    withFocus.layers[0].focus = { x: .5, y: .25 }
    const draft = draftFromComposition(withFocus)
    draft.presenter = { x: .3, y: .2, width: .3, height: .5 }  // deep inside the gameplay
    expect(compositionDraftIssue(draft, withFocus)).toBeUndefined()
    const built = draftComposition(draft, withFocus)!
    expect(built.preset).toBe('gaming')
    expect(built.layers[0].source).toEqual(draft.presenter)
    expect(built.layers[0].target.height).toBe(.35)          // split preserved
    expect(built.layers[0].focus).toEqual({ x: .5, y: .25 }) // focus preserved
    expect(built.captionY).toBeCloseTo(withFocus.captionY, 10)
    expect(validComposition(built)).toBe(true)
  })

  it('keeps the legacy presenter overlap restriction with an actionable message', () => {
    const draft = draftFromComposition(stacked)
    expect(compositionDraftIssue(draft, stacked)).toBeUndefined()
    const overlapping: RegionDraft = {
      presenter: { x: .4, y: .3, width: .3, height: .4 },
      content: { x: .2, y: .2, width: .6, height: .6 }
    }
    const issue = compositionDraftIssue(overlapping, stacked)
    expect(issue).toMatch(/overlap too much for Stacked/)
    expect(issue).toMatch(/Gaming/)
    expect(draftComposition(overlapping, stacked)).toBeUndefined()
    // A valid disjoint edit still applies.
    const moved: RegionDraft = { ...draft, presenter: { x: .02, y: .02, width: .2, height: .2 } }
    expect(compositionDraftIssue(moved, stacked)).toBeUndefined()
    expect(draftComposition(moved, stacked)!.layers.find(l => l.role === 'presenter')!.source)
      .toEqual({ x: .02, y: .02, width: .2, height: .2 })
  })

  it('blocks invalid drafts from Apply, whatever produced them', () => {
    const draft = draftFromComposition(gaming)
    draft.content = { x: .95, y: 0, width: .1, height: .2 }  // beyond the right edge (numeric path)
    expect(compositionDraftIssue(draft, gaming)).toMatch(/Gameplay extends beyond the right edge/)
    expect(draftComposition(draft, gaming)).toBeUndefined()
  })

  it('round-trips through the saved structures the editor reads and writes', () => {
    const source = gamingComposition({ x: .62, y: .11, width: .31, height: .29 }, gameplay, .25)!
    const draft = draftFromComposition(JSON.parse(JSON.stringify(source)) as Composition)
    const built = draftComposition(draft, source)!
    // Same draft twice is idempotent, and Reset (draftFromComposition) restores
    // exactly the saved values.
    expect(draftComposition(draft, source)).toEqual(built)
    expect(draftFromComposition(built)).toEqual(draft)
    // The built composition renders with the exact preview/export geometry.
    const pixels = compositionPixels(built, { width: 1920, height: 1080 }, 1080, 1920)
    expect(pixels[0].target).toEqual({ x: 0, y: 0, width: 1080, height: 480 })
    expect(pixels[1].target).toEqual({ x: 0, y: 480, width: 1080, height: 1440 })
  })

  it('falls back to a facecam default when editing a content-only composition', () => {
    const contentOnly = presenterComposition({ x: .05, y: .2, width: .9, height: .7 },
      { x: .82, y: .02, width: .16, height: .28 }, 'content-only')!
    expect(contentOnly.layers).toHaveLength(1)
    // The editor starts on a rectangle that actually exists.
    expect(initialSelectedRole(gaming)).toBe('presenter')
    expect(initialSelectedRole(stacked)).toBe('presenter')
    expect(initialSelectedRole(contentOnly)).toBe('content')
    const draft = draftFromComposition(contentOnly)
    expect(draft.content).toEqual({ x: .05, y: .2, width: .9, height: .7 })
    // The unused presenter rectangle (a hidden default, overlapping here)
    // must not block a content-only edit.
    expect(draft.presenter).toBeDefined()
    expect(compositionDraftIssue(draft, contentOnly)).toBeUndefined()
    const built = draftComposition(draft, contentOnly)!
    expect(built.layers).toHaveLength(1)
    expect(built.layers[0].role).toBe('content')
    expect(built.layers[0].source).toEqual(draft.content)
  })
})
