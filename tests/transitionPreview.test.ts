import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { BrandingSettings, Clip, Project } from '@shared/types'
import { renderTransitionPreview } from '../src/main/pipeline/transitionPreview'
import { renderClip } from '../src/main/pipeline/render'

vi.mock('../src/main/pipeline/render', () => ({ renderClip: vi.fn(async (job) => {
  await writeFile(job.outputPath, 'preview')
  return { outputPath: job.outputPath, bytes: 7, sizePlan: null }
}) }))

describe('bounded transition preview cache', () => {
  it('reuses identical work, invalidates changed edits and never analyses an intervening source gap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cutawan-preview-'))
    try {
      const source = join(dir, 'source.mkv'), fonts = join(dir, 'fonts')
      await writeFile(source, 'source')
      await mkdir(fonts)
      const clip = { id: 'clip', broll: [], edit: { start: 0, end: 600, autoZoom: false,
        sequence: [{ id: 'later', start: 590, end: 600 }, { id: 'first', start: 0, end: 10 }],
        transitions: [{ fromId: 'later', toId: 'first', kind: 'dissolve', duration: 1 }] } } as unknown as Clip
      const project = { clips: [clip], video: { path: source }, transcript: { language: 'en', durationSec: 600, segments: [] } } as unknown as Project
      const branding = { enabled: false, imagePath: null } as BrandingSettings
      const request = (snapshot: Clip = clip): Promise<string> => renderTransitionPreview(project, snapshot, 'later', 'first', join(dir, 'cache'), branding, fonts)
      vi.mocked(renderClip).mockClear()
      const [first, second] = await Promise.all([request(), request()])
      expect(first).toBe(second)
      expect(await request()).toBe(first)
      expect(renderClip).toHaveBeenCalledTimes(1)
      const job = vi.mocked(renderClip).mock.calls[0][0]
      expect(job.preview).toBe(true)
      expect(job.clip.edit.sequence?.reduce((sum, s) => sum + s.end - s.start, 0)).toBeLessThan(7)
      expect(job.clip.edit.sequence?.map(s => s.id)).toEqual(['later', 'first'])
      const updated = { ...clip, edit: { ...clip.edit, transitions: [{ ...clip.edit.transitions![0], duration: 0.5 }] } }
      expect(await request(updated)).not.toBe(first)
      expect(renderClip).toHaveBeenCalledTimes(2)
      await expect(request({ ...clip, edit: { ...clip.edit, autoZoom: true } })).rejects.toThrow('Auto zoom')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
