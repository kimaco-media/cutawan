import { describe, expect, it } from 'vitest'
import type { Clip, Composition } from '@shared/types'
import {
  compositionIssue,
  compositionPixels,
  gamingComposition,
  gamingSplit,
  presenterComposition,
  usefulComposition,
  validComposition
} from '@shared/composition'
import { automaticLayoutShots, detailCaptionRanges, validLayoutShots } from '@shared/contentType'
import { contentRegionPixels } from '@shared/contentRegion'
import { compositionGraph } from '../src/main/pipeline/layoutFilters'

const facecam = { x: .70, y: .03, width: .27, height: .30 }
const gameplay = { x: .01, y: .01, width: .98, height: .98 }
const source = { width: 1920, height: 1080 }

const gamingClip = (composition: Composition): Clip => ({
  edit: { start: 10, end: 20, aspect: '9:16', reframeMode: 'crop', framing: 'auto' },
  visualLayout: { start: 10, end: 20, preserveContext: true, allowZoom: false, reason: 'gaming',
    shots: [{ start: 10, end: 20, mode: 'fit', composition,
      review: { status: 'needs-review', reason: 'Source regions adjusted manually' } }] }
}) as unknown as Clip

describe('gaming composition', () => {
  it('builds a full-bleed 30/70 default with captions over the gameplay', () => {
    const c = gamingComposition(facecam, gameplay)!
    expect(c.preset).toBe('gaming')
    expect(validComposition(c)).toBe(true)
    expect(c.layers[0].target).toEqual({ x: 0, y: 0, width: 1, height: .3 })
    expect(c.layers[1].target).toEqual({ x: 0, y: .3, width: 1, height: .7 })
    // Lower-middle of the gameplay panel, clear of the seam and the bottom.
    expect(c.captionY).toBeGreaterThan(.3 + .3)
    expect(c.captionY).toBeLessThanOrEqual(.9)
    expect(detailCaptionRanges(gamingClip(c))).toEqual([{ start: 10, end: 20, positionY: c.captionY }])
  })

  it('allows the facecam to sit inside the gameplay, unlike the presenter presets', () => {
    expect(gamingComposition(facecam, gameplay)).toBeDefined()
    expect(presenterComposition(gameplay, facecam, 'stacked')).toBeUndefined()
    expect(usefulComposition(gamingComposition(facecam, gameplay)!, source)).toBe(true)
  })

  it('rejects invalid regions and split ratios', () => {
    expect(gamingComposition({ ...facecam, x: NaN }, gameplay)).toBeUndefined()
    expect(gamingComposition(facecam, { ...gameplay, width: 1.2 })).toBeUndefined()
    expect(gamingComposition(facecam, gameplay, .15)).toBeUndefined()
    expect(gamingComposition(facecam, gameplay, .5)).toBeUndefined()
  })

  it('validates the exact full-bleed geometry, caption band and focus', () => {
    const c = gamingComposition(facecam, gameplay)!
    expect(validComposition({ ...c, preset: 'gaming', layers: [c.layers[1], c.layers[0]] } as Composition)).toBe(false)
    expect(validComposition({ ...c, captionY: .95 })).toBe(false)
    expect(validComposition({ ...c, captionY: .35 })).toBe(false)
    const gapped: Composition = { ...c, layers: [c.layers[0], { ...c.layers[1], target: { ...c.layers[1].target, y: .31 } }] }
    expect(validComposition(gapped)).toBe(false)
    const focused: Composition = { ...c, layers: [{ ...c.layers[0], focus: { x: .5, y: 1.1 } }, c.layers[1]] }
    expect(validComposition(focused)).toBe(false)
    focused.layers[0].focus = { x: 0, y: 1 }
    expect(validComposition(focused)).toBe(true)
    expect(gamingSplit(focused)).toBe(.3)
  })

  it('covers each strip edge to edge with aspect-preserving, even-pixel windows', () => {
    for (const split of [.25, .3, .35]) {
      const c = gamingComposition(facecam, gameplay, split)!
      const pixels = compositionPixels(c, source, 1080, 1920)
      expect(pixels).toHaveLength(2)
      const [presenter, content] = pixels
      const presenterPanel = Math.floor(1920 * split / 2) * 2
      expect(presenter.target).toEqual({ x: 0, y: 0, width: 1080, height: presenterPanel })
      expect(content.target).toEqual({ x: 0, y: presenterPanel, width: 1080, height: 1920 - presenterPanel })
      // Together the strips cover the whole canvas with no gaps or margins.
      expect(presenter.target.y + presenter.target.height).toBe(content.target.y)
      expect(content.target.y + content.target.height).toBe(1920)
      for (const p of pixels) {
        expect(Object.values(p.source).every(n => n % 2 === 0)).toBe(true)
        expect(p.source.x).toBeGreaterThanOrEqual(0)
        expect(p.source.y).toBeGreaterThanOrEqual(0)
        expect(p.source.x + p.source.width).toBeLessThanOrEqual(source.width)
        expect(p.source.y + p.source.height).toBeLessThanOrEqual(source.height)
        expect(Math.abs(p.target.width / p.target.height - p.source.width / p.source.height)).toBeLessThan(.03)
      }
      // A wide crop keeps its full height and crops horizontally; a narrower
      // crop keeps its full width and crops vertically.
      expect(content.source.height).toBeGreaterThan(content.source.width)
      expect(presenter.source.width).toBeGreaterThan(presenter.source.height)
    }
  })

  it('positions the cover window by focus so faces stay in frame', () => {
    const c = gamingComposition(facecam, gameplay)!
    const crop = contentRegionPixels(gameplay, source.width, source.height)
    c.layers[1].focus = { x: 0, y: .5 }
    const left = compositionPixels(c, source, 1080, 1920)[1].source
    c.layers[1].focus = { x: 1, y: .5 }
    const right = compositionPixels(c, source, 1080, 1920)[1].source
    expect(left.x).toBe(crop.x)
    expect(right.x + right.width).toBe(crop.x + crop.width)
    expect(left.width).toBe(right.width)
    const facecamTall = gamingComposition({ x: .4, y: .2, width: .2, height: .6 }, gameplay)!
    facecamTall.layers[0].focus = { x: .5, y: 0 }
    expect(compositionPixels(facecamTall, source, 1080, 1920)[0].source.y).toBeGreaterThan(0)
    facecamTall.layers[0].focus = { x: .5, y: 1 }
    const bottom = compositionPixels(facecamTall, source, 1080, 1920)[0].source
    expect(bottom.y + bottom.height).toBe(864)
  })

  it('warns without blocking when a tiny facecam is stretched across the strip', () => {
    const c = gamingComposition(facecam, gameplay)!
    expect(compositionIssue(c, source)).toBeUndefined()
    const tiny = gamingComposition({ x: .8, y: .05, width: .08, height: .09 }, gameplay)!
    expect(compositionIssue(tiny, source)).toMatch(/soft/)
    expect(compositionIssue(tiny, source)).toMatch(/facecam/i)
  })

  it('switches layouts through the composition preference in both directions', () => {
    const presenter = presenterComposition({ x: .2, y: .3, width: .6, height: .6 }, { x: .82, y: .02, width: .16, height: .26 })!
    const clip = gamingClip(presenter)
    clip.edit.compositionPreference = 'gaming'
    const switched = automaticLayoutShots(clip)[0].composition!
    expect(switched.preset).toBe('gaming')
    expect(switched.layers.map(l => l.source)).toEqual([
      presenter.layers.find(l => l.role === 'presenter')!.source,
      presenter.layers.find(l => l.role === 'content')!.source
    ])
    expect(switched.layers[0].target).toEqual({ x: 0, y: 0, width: 1, height: .3 })
    // Disjoint regions also switch back to the presenter presets.
    clip.edit.compositionPreference = 'stacked'
    const back = automaticLayoutShots(clip)[0].composition!
    expect(back.preset).toBe('stacked')
    // Overlapping gaming regions cannot become a presenter preset; the layout
    // the user can see is kept instead of a broken switch.
    const overlap = gamingClip(gamingComposition(facecam, gameplay)!)
    overlap.edit.compositionPreference = 'stacked'
    expect(automaticLayoutShots(overlap)[0].composition!.preset).toBe('gaming')
  })

  it('survives persistence: JSON round-trip keeps the layout valid and exported graph full-bleed', () => {
    const c = gamingComposition(facecam, gameplay, .35)!
    c.layers[0].focus = { x: .5, y: .4 }
    const clip = gamingClip(JSON.parse(JSON.stringify(c)) as Composition)
    expect(validLayoutShots(clip.visualLayout, 10, 20)).toBe(true)
    expect(validComposition(clip.visualLayout!.shots![0].composition!)).toBe(true)
    const pixels = compositionPixels(clip.visualLayout!.shots![0].composition!, source, 1080, 1920)
    expect(pixels[0].target).toEqual({ x: 0, y: 0, width: 1080, height: 672 })
    expect(pixels[1].target).toEqual({ x: 0, y: 672, width: 1080, height: 1248 })
    // The export graph crops the same cover windows into the same strips.
    const graph = compositionGraph('0:v', 'reframed', 'g', source, 1080, 1920, clip.visualLayout!.shots![0].composition!)
    for (const p of pixels) {
      expect(graph).toContain(`crop=${p.source.width}:${p.source.height}:${p.source.x}:${p.source.y}`)
      expect(graph).toContain(`scale=${p.target.width}:${p.target.height}`)
      expect(graph).toContain(`overlay=${p.target.x}:${p.target.y}`)
    }
  })
})
