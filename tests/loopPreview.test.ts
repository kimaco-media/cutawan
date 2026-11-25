import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runFfmpeg } from '../src/main/pipeline/ffmpeg'
import { extractLoopEdges, loopWindow } from '../src/main/pipeline/loopEdges'

it('selects whole frames on the final clock and clamps short clips', () => {
  expect(loopWindow(300, '30/1', 2)).toEqual({ start: 8, seam: 2, count: 60 })
  expect(loopWindow(7, '30/1', 5).count).toBe(3)
  expect(loopWindow(1, '24/1', 2).count).toBe(1)
  expect(loopWindow(300, '30000/1001', 1).seam).toBeCloseTo(1.001)
  expect(() => loopWindow(1, '30/1', 0)).toThrow()
})

it('decodes the tail then head with the matching tone and no extra picture at the seam', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cutawan-loop-'))
  const master = join(dir, 'master.mp4')
  const preview = join(dir, 'preview.mp4')
  try {
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=white:s=64x64:r=24:d=3,drawbox=color=black:t=fill:enable=gte(t\\,1.5)',
      '-f', 'lavfi', '-i', 'aevalsrc=0.25*sin(2*PI*if(lt(t\\,1.5)\\,400\\,800)*t):s=48000:d=3',
      '-c:v', 'libx264', '-c:a', 'aac', master])
    expect(await extractLoopEdges(master, preview, 1)).toBe(1)
    const picture = join(dir, 'picture.raw')
    const sound = join(dir, 'sound.raw')
    await runFfmpeg(['-i', preview, '-vf', 'scale=1:1', '-pix_fmt', 'gray', '-f', 'rawvideo', picture,
      '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 's16le', sound])
    const pixels = [...await readFile(picture)]
    expect(pixels).toHaveLength(48)
    expect(Math.max(...pixels.slice(0, 24))).toBeLessThan(8)
    expect(Math.min(...pixels.slice(24))).toBeGreaterThan(247)
    const pcm = await readFile(sound)
    for (const [start, hz] of [[0.9, 800], [1.01, 400]]) {
      let crossings = 0
      for (let i = Math.round(start * 48000); i < Math.round((start + 0.08) * 48000); i++) {
        if (pcm.readInt16LE(2*i) <= 0 && pcm.readInt16LE(2*i+2) > 0) crossings++
      }
      expect(Math.abs(crossings - hz * 0.08)).toBeLessThanOrEqual(1)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
