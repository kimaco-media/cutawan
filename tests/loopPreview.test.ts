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

it.each([1.5, 2.75, 3, 3.25, 3.271, 4.5])('joins decoded picture and sound when the audio lasts %s seconds', async audioEnd => {
  const dir = await mkdtemp(join(tmpdir(), 'cutawan-loop-'))
  const master = join(dir, 'master.mp4')
  const preview = join(dir, 'preview.mp4')
  try {
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=white:s=64x64:r=24:d=3,drawbox=color=black:t=fill:enable=gte(t\\,1.5)',
      '-f', 'lavfi', '-i', `aevalsrc=0.25*sin(2*PI*if(lt(t\\,${audioEnd - 0.125})\\,400\\,800)*t):s=48000:d=${audioEnd}`,
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
    for (const [start, hz] of [[0.9, audioEnd < 3 ? 0 : 800], [1.01, 400]]) {
      if (!hz) {
        expect(pcm.subarray(2 * 43200, 2 * 47040).every(byte => byte === 0)).toBe(true)
        continue
      }
      let crossings = 0
      for (let i = Math.round(start * 48000); i < Math.round((start + 0.08) * 48000); i++) {
        if (pcm.readInt16LE(2*i) <= 0 && pcm.readInt16LE(2*i+2) > 0) crossings++
      }
      expect(Math.abs(crossings - hz * 0.08)).toBeLessThanOrEqual(1)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
