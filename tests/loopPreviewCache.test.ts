import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Clip, VideoInfo } from '@shared/types'
import { renderLoopPreview } from '../src/main/pipeline/loopPreview'
import { renderClip } from '../src/main/pipeline/render'
import { extractLoopEdges } from '../src/main/pipeline/loopEdges'

vi.mock('../src/main/pipeline/render', () => ({ renderClip: vi.fn(async job => {
  await writeFile(job.outputPath, 'master')
  return {}
}) }))
vi.mock('../src/main/pipeline/loopEdges', () => ({ extractLoopEdges: vi.fn(async (_master, path, seconds) => {
  await writeFile(path, 'edges')
  return seconds
}) }))

it('shares the finished render across requests and window lengths until an asset or edit changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cutawan-loop-cache-'))
  try {
    const path = join(dir, 'source')
    const musicPath = join(dir, 'music')
    await writeFile(path, 'source')
    await writeFile(musicPath, 'track')
    const clip = { broll: [], edit: { coldOpen: true, sequence: [{ id: 'late', start: 10, end: 14 }, { id: 'early', start: 0, end: 3 }],
      transitions: [{ fromId: 'late', toId: 'early', kind: 'dissolve', duration: .3 }] } } as unknown as Clip
    const job = { source: { path } as VideoInfo, clip, transcript: null, musicPath }
    const request = (seconds: number) => renderLoopPreview(job, seconds, join(dir, 'loops'), 'test', new AbortController().signal)
    const [one, same] = await Promise.all([request(1), request(1)])
    expect(one).toEqual(same)
    expect(extractLoopEdges).toHaveBeenCalledTimes(1)
    expect((await request(2)).path).not.toBe(one.path)
    expect(renderClip).toHaveBeenCalledTimes(1)
    expect(vi.mocked(renderClip).mock.calls[0][0].clip).toEqual(clip)
    await writeFile(musicPath, 'replacement track')
    expect((await request(1)).path).not.toBe(one.path)
    clip.edit.coldOpen = false
    await request(1)
    expect(renderClip).toHaveBeenCalledTimes(3)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
