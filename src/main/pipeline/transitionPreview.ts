import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrandingSettings, Clip, Project } from '@shared/types'
import { joinPreviewClip, outputJoins } from '@shared/transitions'
import { renderClip } from './render'

const pending = new Map<string, Promise<string>>()

/** User-requested, bounded local preview. Cache identity includes every render input. */
export async function renderTransitionPreview(project: Project, clip: Clip, fromId: string, toId: string,
  cacheDir: string, branding: BrandingSettings, fontsDirPath: string): Promise<string> {
  if (clip.edit.autoZoom) throw new Error('Turn off Auto zoom before rendering a join preview; its full-clip plan cannot be reproduced in a short excerpt.')
  const boundary = outputJoins(clip, project.transcript).find(j => j.fromId === fromId && j.toId === toId)
  if (!boundary || !boundary.duration) throw new Error('Choose a valid transition first.')
  const sourceStat = await stat(project.video.path)
  const fontStat = await stat(fontsDirPath)
  const key = createHash('sha256').update(JSON.stringify([2, clip, boundary, project.transcript, project.video,
    sourceStat.size, sourceStat.mtimeMs, branding, fontsDirPath, fontStat.mtimeMs])).digest('hex')
  const outputPath = join(cacheDir, `${key}.mp4`)
  if (existsSync(outputPath)) return outputPath
  const existing = pending.get(key)
  if (existing) return existing
  const work = (async (): Promise<string> => {
    await mkdir(cacheDir, { recursive: true })
    const previewClip = joinPreviewClip(clip, boundary)
    const previewStart = boundary.baseTime - (previewClip.edit.sequence![0].end - previewClip.edit.sequence![0].start)
    await renderClip({ clip: previewClip, source: project.video, transcript: project.transcript, outputPath,
      encoder: 'cpu', quality: 'draft', preview: true, branding, fontsDirPath,
      titleDuration: Math.max(0, 4 - previewStart) })
    // Bound accumulated previews; active renders have distinct .partial names.
    const files = await Promise.all((await readdir(cacheDir)).filter(name => name.endsWith('.mp4') && !name.includes('.partial-'))
      .map(async name => ({ name, mtime: (await stat(join(cacheDir, name)).catch(() => null))?.mtimeMs ?? 0 })))
    await Promise.all(files.sort((a, b) => b.mtime - a.mtime).slice(32).filter(file => file.name !== `${key}.mp4`)
      .map(file => rm(join(cacheDir, file.name), { force: true })))
    return outputPath
  })()
  pending.set(key, work)
  try { return await work } finally { pending.delete(key) }
}
