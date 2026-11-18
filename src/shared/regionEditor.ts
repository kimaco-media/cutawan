import type { Composition, ContentRegion, RegionFocus } from './types'
import { presenterComposition, rebuildGaming, validComposition } from './composition'

/**
 * Pure geometry for the visual source-region editor: pointer mapping, drag,
 * resize and preset-aware validation. Everything here is normalized (0..1 of
 * the source frame) and free of DOM types so the editor's behaviour is
 * unit-testable; the component only supplies container measurements.
 */

/** Matches validRectangle's floor: regions cannot be thinner than 2% per side. */
export const MIN_REGION_SIDE = .02

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export interface RegionDraft {
  presenter: ContentRegion
  content: ContentRegion
  presenterFocus?: RegionFocus
  contentFocus?: RegionFocus
}

/** Facecam starting rectangle when the edited composition has none (content-only). */
const DEFAULT_PRESENTER: ContentRegion = { x: .70, y: .03, width: .27, height: .30 }

/** The draft a composition opens the editor with: its layers, by role. */
export function draftFromComposition(composition: Composition): RegionDraft {
  const layer = (role: 'presenter' | 'content') => composition.layers.find(l => l.role === role)
  return {
    presenter: { ...(layer('presenter')?.source ?? DEFAULT_PRESENTER) },
    content: { ...layer('content')!.source },
    presenterFocus: layer('presenter')?.focus ? { ...layer('presenter')!.focus! } : undefined,
    contentFocus: layer('content')?.focus ? { ...layer('content')!.focus! } : undefined
  }
}

/** Pointer position in container pixels → normalized source coordinates. */
export function pointerToSource(
  point: { x: number; y: number },
  container: { width: number; height: number }
): { x: number; y: number } {
  const clamp = (v: number): number => Math.max(0, Math.min(1, v))
  return {
    x: clamp(point.x / Math.max(1, container.width)),
    y: clamp(point.y / Math.max(1, container.height))
  }
}

/** Keep stored coordinates free of float dust (0.1 + 0.2 − 0.3 style). */
const round = (v: number): number => Math.round(v * 1e6) / 1e6

/** Move the region so `grab` (the pointer's offset from its top-left at drag
 * start) follows the pointer, inside the frame. The position is derived from
 * the pointer and the captured grab offset alone — never accumulated against
 * the region's own position, which would jump and drift on repeated moves. */
export function dragRegion(
  region: ContentRegion, grab: { x: number; y: number }, point: { x: number; y: number }
): ContentRegion {
  const x = round(Math.max(0, Math.min(1 - region.width, point.x - grab.x)))
  const y = round(Math.max(0, Math.min(1 - region.height, point.y - grab.y)))
  return { x, y, width: region.width, height: region.height }
}

/**
 * Resize one edge or corner; the opposite edges stay put. Clamped to the frame
 * and to the minimum side, so a drag can never produce an invalid rectangle.
 */
export function resizeRegion(
  region: ContentRegion, handle: ResizeHandle, point: { x: number; y: number }
): ContentRegion {
  let { x, y, width, height } = region
  if (handle.includes('e')) width = Math.max(MIN_REGION_SIDE, Math.min(1 - x, point.x - x))
  if (handle.includes('w')) {
    const right = x + width
    x = Math.max(0, Math.min(right - MIN_REGION_SIDE, point.x))
    width = right - x
  }
  if (handle.includes('s')) height = Math.max(MIN_REGION_SIDE, Math.min(1 - y, point.y - y))
  if (handle.includes('n')) {
    const bottom = y + height
    y = Math.max(0, Math.min(bottom - MIN_REGION_SIDE, point.y))
    height = bottom - y
  }
  return { x: round(x), y: round(y), width: round(width), height: round(height) }
}

/** Nudge a region by whole-percent steps without leaving the frame. */
export function nudgeRegion(
  region: ContentRegion, dx: number, dy: number
): ContentRegion {
  return dragRegion(region, { x: 0, y: 0 }, { x: region.x + dx, y: region.y + dy })
}

/** Smallest region containing the point — the top one to grab when they overlap. */
export function regionAt(draft: RegionDraft, point: { x: number; y: number }): 'presenter' | 'content' | null {
  const inside = (r: ContentRegion): boolean =>
    point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height
  const hits = (['presenter', 'content'] as const)
    .filter(role => inside(draft[role]))
    .sort((a, b) => draft[a].width * draft[a].height - draft[b].width * draft[b].height)
  return hits[0] ?? null
}

/** The rectangle the editor selects first: the facecam when the composition has one. */
export function initialSelectedRole(composition: Composition): 'presenter' | 'content' {
  return composition.layers.some(l => l.role === 'presenter') ? 'presenter' : 'content'
}

/**
 * Specific bounds feedback for hand-typed values (the visual editor clamps
 * instead): names the region, the edge and the constraint that failed.
 */
export function regionBoundsIssue(label: string, region: ContentRegion): string | undefined {
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite)) {
    return `${label}: enter a number for every field.`
  }
  if (region.x < 0) return `${label} extends beyond the left edge.`
  if (region.y < 0) return `${label} extends beyond the top edge.`
  if (region.x + region.width > 1.000001) return `${label} extends beyond the right edge.`
  if (region.y + region.height > 1.000001) return `${label} extends beyond the bottom edge.`
  if (region.width < MIN_REGION_SIDE || region.height < MIN_REGION_SIDE) {
    return `${label} is too small; keep each side at least 2% of the source.`
  }
  return undefined
}

const PRESET_LABELS: Record<string, string> = {
  'content-first': 'Content first', stacked: 'Stacked', 'content-only': 'Content only', gaming: 'Gaming'
}

/**
 * Preset-aware draft validation. Gaming deliberately allows overlapping
 * regions (a facecam embedded in the gameplay); the legacy presenter presets
 * keep presenterComposition's overlap restriction, phrased as an actionable
 * message naming the preset and the way out.
 */
export function compositionDraftIssue(draft: RegionDraft, composition: Composition): string | undefined {
  const gaming = composition.preset === 'gaming'
  const bounds = regionBoundsIssue(gaming ? 'Facecam' : 'Presenter', draft.presenter) ??
    regionBoundsIssue(gaming ? 'Gameplay' : 'Content', draft.content)
  if (bounds) return bounds
  if (gaming || composition.preset === 'content-only') return undefined
  const presenter = presenterComposition(draft.content, draft.presenter,
    composition.preset === 'stacked' ? 'stacked' : 'content-first')
  if (!presenter) {
    return `Presenter and content overlap too much for ${PRESET_LABELS[composition.preset] ?? composition.preset}; use Gaming if intentional.`
  }
  return undefined
}

/**
 * Build the composition an Apply saves. Gaming keeps the split and per-panel
 * focus of the composition being edited; legacy presets rebuild through
 * presenterComposition, which owns their overlap rule and caption geometry.
 */
export function draftComposition(draft: RegionDraft, composition: Composition): Composition | undefined {
  if (compositionDraftIssue(draft, composition)) return undefined
  if (composition.preset === 'gaming') {
    const rebuilt = rebuildGaming(draft.presenter, draft.content, {
      split: composition.layers.find(l => l.role === 'presenter')?.target?.height,
      presenterFocus: draft.presenterFocus, contentFocus: draft.contentFocus
    })
    return rebuilt && validComposition(rebuilt) ? rebuilt : undefined
  }
  const preset = composition.preset === 'stacked' ? 'stacked' : composition.preset === 'content-only' ? 'content-only' : 'content-first'
  const rebuilt = presenterComposition(draft.content, draft.presenter, preset)
  return rebuilt && validComposition(rebuilt) ? rebuilt : undefined
}
