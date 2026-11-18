import type { Composition, ContentRegion, RegionFocus } from './types'
import { contentRegionPixels } from './contentRegion'

export function validRectangle(r: ContentRegion | undefined): r is ContentRegion {
  return Boolean(r && [r.x, r.y, r.width, r.height].every(Number.isFinite) &&
    r.x >= 0 && r.y >= 0 && r.width >= .02 && r.height >= .02 &&
    r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001)
}

function intersection(a: ContentRegion, b: ContentRegion): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
}

export function validComposition(c: Composition | undefined): c is Composition {
  if (c?.version === 1 && c.preset === 'speakers') return validSpeakerComposition(c)
  if (c?.version === 1 && c.preset === 'gaming') return validGamingComposition(c)
  if (!c || c.version !== 1 || !['content-first', 'stacked', 'content-only'].includes(c.preset) ||
    !Array.isArray(c.layers) || c.layers.length < 1 || c.layers.length > 2 ||
    !Number.isFinite(c.captionY) || c.captionY < .78 || c.captionY > .86) return false
  const roles = new Set<string>()
  for (const layer of c.layers) {
    if (!layer || !['content', 'presenter'].includes(layer.role) || roles.has(layer.role) ||
      !validRectangle(layer.source) || !validRectangle(layer.target) ||
      layer.target.y + layer.target.height > c.captionY - .07) return false
    roles.add(layer.role)
  }
  return roles.has('content') && (c.layers.length === 1 || intersection(c.layers[0].target, c.layers[1].target) < .000001)
}

/** Two stacked speaker panels, captions on the seam between them. */
const SPEAKER_PANELS: ContentRegion[] = [{ x: 0, y: 0, width: 1, height: .5 }, { x: 0, y: .5, width: 1, height: .5 }]
export const SPEAKER_CAPTION_Y = .5

function validSpeakerComposition(c: Composition): boolean {
  return Array.isArray(c.layers) && c.layers.length === 2 && Number.isFinite(c.captionY) &&
    c.captionY >= .4 && c.captionY <= .6 &&
    c.layers.every(l => l?.role === 'speaker' && validRectangle(l.source) && validRectangle(l.target)) &&
    intersection(c.layers[0].target, c.layers[1].target) < .000001
}

/**
 * Stack two people from the same shot: `top` and `bottom` are source
 * rectangles already shaped like a half-height 9:16 panel, so each fills its
 * panel exactly.
 */
export function speakerComposition(top: ContentRegion, bottom: ContentRegion): Composition | undefined {
  if (!validRectangle(top) || !validRectangle(bottom)) return undefined
  return { version: 1, preset: 'speakers', captionY: SPEAKER_CAPTION_Y,
    layers: [{ role: 'speaker', source: top, target: SPEAKER_PANELS[0] }, { role: 'speaker', source: bottom, target: SPEAKER_PANELS[1] }] }
}

/** Whether a composition separates screen content from a presenter inset. */
export function isPresenterComposition(c: Composition | undefined): boolean {
  return Boolean(c && c.preset !== 'speakers')
}

/** Gaming split presets offered in the editor, as the facecam share of the frame. */
export const GAMING_SPLITS = [.25, .3, .35] as const
export const DEFAULT_GAMING_SPLIT = .3
/** Allowed facecam share of the output frame. */
const GAMING_SPLIT_MIN = .2
const GAMING_SPLIT_MAX = .45
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6

function validFocus(f: Composition['layers'][number]['focus']): f is RegionFocus {
  return Boolean(f && [f.x, f.y].every(v => Number.isFinite(v) && v >= 0 && v <= 1))
}

/** The facecam share of the frame a saved gaming composition was built with. */
export function gamingSplit(c: Composition): number {
  return c.layers.find(l => l.role === 'presenter')?.target?.height ?? DEFAULT_GAMING_SPLIT
}

function validGamingComposition(c: Composition): boolean {
  if (!Array.isArray(c.layers) || c.layers.length !== 2 || !Number.isFinite(c.captionY)) return false
  const [presenter, content] = c.layers
  const split = presenter?.target?.height
  if (presenter?.role !== 'presenter' || content?.role !== 'content' ||
    !validRectangle(presenter.source) || !validRectangle(content.source) ||
    !near(presenter.target.x, 0) || !near(presenter.target.y, 0) || !near(presenter.target.width, 1) ||
    !near(content.target.x, 0) || !near(content.target.width, 1) ||
    !near(content.target.y, split) || !near(content.target.height, 1 - split) ||
    split < GAMING_SPLIT_MIN - 1e-9 || split > GAMING_SPLIT_MAX + 1e-9 ||
    // Captions overlay the gameplay panel: clear of the seam and the bottom edge.
    c.captionY < split + .1 || c.captionY > .9) return false
  return (presenter.focus === undefined || validFocus(presenter.focus)) &&
    (content.focus === undefined || validFocus(content.focus))
}

/**
 * Full-bleed gaming layout: the facecam crop covers the top `split` of the
 * 9:16 frame, the gameplay crop the rest, both edge to edge — cover crops
 * instead of letterboxed insets. The regions may overlap (a facecam embedded
 * in the gameplay), unlike the presenter presets.
 */
export function gamingComposition(
  presenter: ContentRegion, content: ContentRegion, split = DEFAULT_GAMING_SPLIT
): Composition | undefined {
  if (!validRectangle(presenter) || !validRectangle(content) ||
    split < GAMING_SPLIT_MIN || split > GAMING_SPLIT_MAX) return undefined
  // Captions sit toward the lower-middle of the gameplay panel, with safe
  // margins from both the seam and the frame bottom.
  const captionY = split + (1 - split) * .63
  return { version: 1, preset: 'gaming', captionY,
    layers: [{ role: 'presenter', source: presenter, target: { x: 0, y: 0, width: 1, height: split } },
      { role: 'content', source: content, target: { x: 0, y: split, width: 1, height: 1 - split } }] }
}

/**
 * Rebuild a gaming composition after an edit (regions or split) while keeping
 * what the edit did not touch: the split — and with it the caption anchor —
 * survives a region adjustment, and per-panel focus survives a split change.
 */
export function rebuildGaming(
  presenter: ContentRegion, content: ContentRegion,
  keep: { split?: number; presenterFocus?: RegionFocus; contentFocus?: RegionFocus } = {}
): Composition | undefined {
  const rebuilt = gamingComposition(presenter, content, keep.split ?? DEFAULT_GAMING_SPLIT)
  if (!rebuilt) return undefined
  if (keep.presenterFocus) rebuilt.layers[0].focus = keep.presenterFocus
  if (keep.contentFocus) rebuilt.layers[1].focus = keep.contentFocus
  return rebuilt
}

/** The source rectangles are independent of the source webcam's corner. */
export function presenterComposition(
  content: ContentRegion, presenter: ContentRegion,
  preset: 'content-first' | 'stacked' | 'content-only' = 'content-first'
): Composition | undefined {
  // Content-only renders the content layer alone, so its (unused) presenter
  // rectangle has no business failing the disjointness rule.
  if (!validRectangle(content) || !validRectangle(presenter) ||
    (preset !== 'content-only' &&
      intersection(content, presenter) > presenter.width * presenter.height * .15)) return undefined
  const layers: Composition['layers'] = [{ role: 'content', source: content,
    target: preset === 'content-only' ? { x: .04, y: .08, width: .92, height: .66 } :
      { x: .04, y: .29, width: .92, height: .46 } }]
  if (preset !== 'content-only') layers.push({ role: 'presenter', source: presenter,
    target: preset === 'stacked' ? { x: .12, y: .03, width: .76, height: .23 } :
      { x: .64, y: .03, width: .30, height: .23 } })
  return { version: 1, preset, layers, captionY: .83 }
}

/**
 * Cover-crop window for a full-bleed panel: the largest even-pixel sub-rect
 * of `crop` whose aspect matches the panel, positioned by `focus` (0..1 per
 * axis; 0.5 centres). Shared by the preview canvas and the export graph.
 */
function coverWindow(crop: ContentRegion, panel: ContentRegion, focus: RegionFocus): ContentRegion {
  const panelAspect = panel.width / panel.height
  // Fit the window to the shorter relative overflow: a crop wider than the
  // panel keeps its full height and crops horizontally, and vice versa.
  let height = Math.min(crop.height, Math.max(2, Math.floor(crop.width / panelAspect / 2) * 2))
  let width = Math.max(2, Math.floor(height * panelAspect / 2) * 2)
  if (width > crop.width) {
    width = Math.max(2, Math.floor(crop.width / 2) * 2)
    height = Math.max(2, Math.min(crop.height, Math.floor(width / panelAspect / 2) * 2))
  }
  const even = (v: number, max: number): number => Math.max(0, Math.min(max, Math.round(v / 2) * 2))
  return { x: crop.x + even(focus.x * (crop.width - width), crop.width - width),
    y: crop.y + even(focus.y * (crop.height - height), crop.height - height), width, height }
}

/** Return the actual fitted rectangles, not an approximate CSS contain calculation. */
export function compositionPixels(c: Composition, source: { width: number; height: number }, width: number, height: number):
  Array<{ source: ContentRegion; target: ContentRegion }> {
  if (!validComposition(c) || Math.min(source.width, source.height, width, height) < 2) return []
  return c.layers.map(layer => {
    const crop = contentRegionPixels(layer.source, source.width, source.height)
    const panel = contentRegionPixels(layer.target, width, height)
    if (c.preset === 'gaming') {
      // Panels are already exactly the destination strips; cover them edge to
      // edge instead of fitting the crop inside with black margins.
      return { source: coverWindow(crop, panel, layer.focus ?? { x: .5, y: .5 }), target: panel }
    }
    const scale = Math.min(panel.width / crop.width, panel.height / crop.height)
    const w = Math.max(2, Math.floor(crop.width * scale / 2) * 2)
    const h = Math.max(2, Math.floor(crop.height * scale / 2) * 2)
    return { source: crop, target: { x: panel.x + Math.floor((panel.width - w) / 4) * 2,
      y: panel.y + Math.floor((panel.height - h) / 4) * 2, width: w, height: h } }
  })
}

/** Keep small insets from becoming soft close-ups and require a useful content gain. */
export function usefulComposition(c: Composition, source: { width: number; height: number }): boolean {
  return compositionIssue(c, source) === undefined
}

/** Actionable proposal feedback; keep the acceptance threshold unchanged. */
export function compositionIssue(c: Composition, source: { width: number; height: number }): string | undefined {
  const pixels = compositionPixels(c, source, 1080, 1920)
  const baseline = Math.min(1080 / source.width, 1920 / source.height)
  if (!pixels.length) return 'Invalid or overlapping destination panels.'
  if (c.preset === 'gaming') {
    // Broad gameplay bounds are the point of the layout; only a tiny facecam
    // stretched across the full output width reads as a defect. Nonblocking.
    const presenter = pixels[c.layers.findIndex(l => l.role === 'presenter')]
    if (presenter && presenter.target.width / presenter.source.width > 4) {
      return 'The facecam region is small for a full-width panel and will look soft when upscaled. Widen it if the source allows.'
    }
    return undefined
  }
  for (const [i, p] of pixels.entries()) {
    if (c.layers[i].role === 'content') {
      if (p.target.width / p.source.width < baseline * 1.2) {
        return 'Content bounds are too broad to enlarge meaningfully. Remove empty margins and unrelated page chrome; retain the relevant text, chart and labels.'
      }
    } else if (Math.min(p.source.width, p.source.height) < 80 || p.target.width / p.source.width > 3) {
      return 'Presenter bounds are too small for a clear inset. Locate the entire webcam panel, not a tight face crop.'
    }
  }
  return undefined
}
