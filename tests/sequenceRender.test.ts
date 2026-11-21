import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import ffmpeg from 'ffmpeg-static'
import { tightenGraph } from '../src/main/pipeline/render'

it('renders C → A → B with matching tone, picture, duration and silent-source support', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutawan-sequence-'))
  const run = (args: string[]): Buffer => execFileSync(ffmpeg!, ['-v', 'error', '-y', ...args], { maxBuffer: 8 * 1024 * 1024 })
  try {
    const source = join(dir, 'source.mkv'), output = join(dir, 'output.mp4')
    const inputs = ['red', 'green', 'blue'].flatMap((color, i) => [
      '-f', 'lavfi', '-i', `color=c=${color}:s=64x64:r=30:d=1`,
      '-f', 'lavfi', '-i', `sine=frequency=${440 * (i + 1)}:sample_rate=48000:duration=1`
    ])
    run([...inputs, '-filter_complex', '[0:v][1:a][2:v][3:a][4:v][5:a]concat=n=3:v=1:a=1[v][a]',
      '-map', '[v]', '-map', '[a]', '-c:v', 'libvpx-vp9', '-c:a', 'libopus', source])
    const ranges = [{ start: 2, end: 3 }, { start: 0, end: 1 }, { start: 1, end: 2 }]
    run([...ranges.flatMap(s => ['-ss', String(s.start), '-t', '1', '-i', source]),
      '-filter_complex', tightenGraph(ranges, 0, true, true), '-map', '[vcat]', '-map', '[acat]',
      '-c:v', 'libx264', '-c:a', 'aac', output])
    const rgb = run(['-i', output, '-vf', 'fps=1,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
    expect(rgb.length).toBe(9)
    expect([0, 1, 2].map(i => [...rgb.subarray(i * 3, i * 3 + 3)].indexOf(Math.max(...rgb.subarray(i * 3, i * 3 + 3))))).toEqual([2, 0, 1])
    const audio = run(['-i', output, '-vn', '-ar', '48000', '-ac', '1', '-f', 'f32le', 'pipe:1'])
    expect(audio.length / 4 / 48000).toBeCloseTo(3, 1)
    for (const [i, frequency] of [1320, 440, 880].entries()) {
      let crossings = 0
      for (let n = Math.round((i + 0.2) * 48000) + 1; n < (i + 0.8) * 48000; n++) {
        if (audio.readFloatLE((n - 1) * 4) < 0 && audio.readFloatLE(n * 4) >= 0) crossings++
      }
      expect(crossings / 0.6).toBeCloseTo(frequency, -1)
    }
    run([...ranges.flatMap(s => ['-ss', String(s.start), '-t', '1', '-i', source]),
      '-filter_complex', tightenGraph(ranges, 0, false, true), '-map', '[vcat]', '-an', '-f', 'null', '-'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 30_000)
