export interface SoundAsset {
  id: string
  name: string
  duration: number
  sha256: string
}

export interface LibrarySound extends SoundAsset {
  path: string | null
}

export interface SoundPlacement {
  id: string
  assetId: string
  startOutputSec: number
  trimStartSec: number
  trimEndSec: number
  gainDb: number
  enabled: boolean
}

export interface ManualCue {
  id: string
  path: string
  start: number
  offset: number
  duration: number
  gainDb: number
}

export function manualCuePlan(placements: SoundPlacement[] = [], library: LibrarySound[], end: number) {
  const cues: ManualCue[] = []
  const missing = new Set<string>()
  const assets = new Map(library.map(a => [a.id, a]))
  for (const p of placements) {
    if (!p.enabled || p.startOutputSec >= end) continue
    const a = assets.get(p.assetId)
    if (!a?.path) {
      missing.add(a?.name ?? p.assetId)
      continue
    }
    if (![p.startOutputSec, p.trimStartSec, p.trimEndSec, p.gainDb].every(Number.isFinite)) continue
    const start = Math.max(0, p.startOutputSec)
    const offset = Math.max(0, p.trimStartSec)
    const duration = Math.min(end - start, Math.min(a.duration, p.trimEndSec) - offset)
    if (duration > 0) cues.push({ id: p.id, path: a.path, start, offset, duration, gainDb: Math.min(0, Math.max(-60, p.gainDb)) })
  }
  return { cues, missing: [...missing] }
}
