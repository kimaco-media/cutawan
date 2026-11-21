import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import ffmpeg from 'ffmpeg-static'
import { overlapGraph } from '../src/main/pipeline/transitionGraph'
import { buildFilterGraph, renderClip } from '../src/main/pipeline/render'
import { gamingComposition } from '@shared/composition'
import { outputJoins, transitionFilters, type TransitionKind } from '@shared/transitions'
import { DEFAULT_CAPTION_STYLE_ID } from '@shared/captionStyles'
import type { Clip, Transcript, VideoInfo } from '@shared/types'

const transcript: Transcript = { language: 'en', durationSec: 4, segments: [] }
function clipFor(kind: TransitionKind): Clip {
  return { id: 'render-transitions', suggestedStart: 0, suggestedEnd: 4, title: 'Transition', hook: '', summary: '',
    viralityScore: 50, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null, broll: [], focusTrack: null, edit: {
    start: 0, end: 4, aspect: 'original', framing: 'manual', reframeMode: 'crop', focusX: .5,
    captionsEnabled: false, captionStyleId: DEFAULT_CAPTION_STYLE_ID, tightenCuts: false, showTitle: false,
    sequence: [{ id: 'a', start: 0, end: 2 }, { id: 'b', start: 2, end: 4 }],
    transitions: [{ fromId: 'a', toId: 'b', kind, duration: .4 }]
  } }
}
const run = (args: string[]): Buffer => execFileSync(ffmpeg!, ['-v', 'error', '-y', '-filter_complex_threads', '1', ...args], { maxBuffer: 32 * 1024 * 1024 })

describe('real FFmpeg transitions', () => {
  for (const kind of ['dissolve', 'slide-left', 'slide-right', 'whip-pan', 'fade-black', 'zoom'] as const) {
    it(`renders ${kind} with the canonical duration and expected midpoint`, () => {
      const joins = outputJoins(clipFor(kind), transcript)
      const point = transitionFilters(joins, 10)
      const parts = ['[0:v][1:v]concat=n=2:v=1:a=0[base]']
      if (point.length) parts.push(`[base]${point.join(',')}[point]`)
      const blend = overlapGraph(joins, 4, 10, point.length ? 'point' : 'base', null)
      parts.push(...blend.filters)
      const rgb = run(['-f', 'lavfi', '-i', 'color=red:s=32x32:r=10:d=2',
        '-f', 'lavfi', '-i', 'color=blue:s=32x32:r=10:d=2', '-filter_complex', parts.join(';'),
        '-map', `[${blend.video}]`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
      const frameSize = 32 * 32 * 3
      const duration = 4 - joins[0].overlap
      expect(rgb.length / frameSize / 10).toBeCloseTo(duration, 1)
      const pixel = (t: number, x: number): number[] => [...rgb.subarray(Math.round(t * 10) * frameSize + (16 * 32 + x) * 3,
        Math.round(t * 10) * frameSize + (16 * 32 + x) * 3 + 3)]
      expect(pixel(0, 16)[0]).toBeGreaterThan(200)
      expect(pixel(duration - .2, 16)[2]).toBeGreaterThan(200)
      if (kind === 'dissolve') {
        const middle = pixel(1.8, 16)
        expect(middle[0]).toBeGreaterThan(70)
        expect(middle[2]).toBeGreaterThan(70)
      } else if (kind === 'slide-left') {
        expect(pixel(1.8, 4)[0]).toBeGreaterThan(180)
        expect(pixel(1.8, 28)[2]).toBeGreaterThan(180)
      } else if (kind === 'slide-right') {
        expect(pixel(1.8, 4)[2]).toBeGreaterThan(180)
        expect(pixel(1.8, 28)[0]).toBeGreaterThan(180)
      } else if (kind === 'fade-black') {
        expect(Math.max(...pixel(2, 16))).toBeLessThan(5)
      }
    }, 20_000)
  }

  it('leaves the exact hard-cut export graph unchanged for old/default projects', () => {
    const clip = clipFor('dissolve')
    delete clip.edit.transitions
    const source = { path: 'source.mkv', width: 64, height: 64, fps: 30, hasAudio: true } as VideoInfo
    expect(buildFilterGraph(clip, source, null, 4, null, { transitions: outputJoins(clip, transcript) }))
      .toEqual(buildFilterGraph(clip, source, null, 4, null))
  })

  for (const fps of [24, 29.97, 60]) {
    it(`normalizes a dissolve at ${fps} fps without extra blank frames`, () => {
      const clip = clipFor('dissolve')
      const graph = overlapGraph(outputJoins(clip, transcript), 4, fps, '0:v', null)
      const bytes = run(['-f', 'lavfi', '-i', `testsrc2=s=32x32:r=${fps}:d=4`,
        '-filter_complex', graph.filters.join(';'), '-map', `[${graph.video}]`,
        '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
      const size = 32 * 32 * 3
      expect(Math.abs(bytes.length / size / fps - 3.6)).toBeLessThanOrEqual(1 / fps + 0.001)
      for (let start = 0; start < bytes.length; start += size) {
        expect(bytes.subarray(start, start + size).some(v => v > 50)).toBe(true)
      }
    })
  }

  it('keeps mixed overlaps, cuts and audio on one timeline', () => {
    const clip = clipFor('dissolve')
    clip.edit.end = 8
    clip.edit.sequence!.push({ id: 'c', start: 4, end: 6 }, { id: 'd', start: 6, end: 8 })
    clip.edit.transitions!.push({ fromId: 'c', toId: 'd', kind: 'slide-right', duration: .6 })
    const graph = overlapGraph(outputJoins(clip, transcript), 8, 10, '0:v', '1:a')
    const dir = mkdtempSync(join(tmpdir(), 'cutawan-transition-audio-'))
    try {
      const path = join(dir, 'mixed.mp4')
      run(['-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=10:d=8', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=8',
        '-filter_complex', graph.filters.join(';'), '-map', `[${graph.video}]`, '-map', `[${graph.audio}]`,
        '-c:v', 'libx264', '-c:a', 'aac', path])
      const audio = run(['-i', path, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'])
      expect(audio.length / 4 / 48000).toBeCloseTo(7, 1)
      for (const t of [1.8, 5.3]) {
        let peak = 0
        for (let sample = Math.round((t - .05) * 48000); sample < (t + .05) * 48000; sample++) peak = Math.max(peak, Math.abs(audio.readFloatLE(sample * 4)))
        expect(peak).toBeGreaterThan(.05)
        expect(peak).toBeLessThan(.2)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 20_000)

  it('exports Gaming composition, Opus audio and subtitles through a dissolve', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cutawan-transition-gaming-'))
    try {
      const sourcePath = join(dir, 'gaming.mkv')
      run(['-f', 'lavfi', '-i', 'testsrc2=s=192x108:r=10:d=4', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=4',
        '-c:v', 'libvpx-vp9', '-c:a', 'libopus', sourcePath])
      const clip = clipFor('dissolve')
      clip.edit.aspect = '9:16'
      clip.edit.framing = 'auto'
      const composition = gamingComposition({ x: .7, y: .03, width: .27, height: .3 }, { x: .01, y: .01, width: .98, height: .98 })!
      clip.visualLayout = { start: 0, end: 4, preserveContext: true, allowZoom: false, reason: 'gaming',
        shots: [{ start: 0, end: 4, mode: 'fit', composition }] }
      const captions: Transcript = { ...transcript, segments: [{ id: 0, start: .2, end: .7, text: 'Hello', words: [{ start: .2, end: .7, text: 'Hello' }] }] }
      clip.edit.captionsEnabled = true
      const source = { path: sourcePath, fileName: 'gaming.mkv', sizeBytes: 1, width: 192, height: 108, fps: 10, hasAudio: true, durationSec: 4 } as VideoInfo
      const output = join(dir, 'gaming.mp4')
      const result = await renderClip({ clip, source, transcript: captions, outputPath: output, encoder: 'cpu', quality: 'draft' })
      expect(result.bytes).toBeGreaterThan(0)
      const frames = run(['-i', output, '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
      expect(frames.length / 3 / 10).toBeCloseTo(3.6, 1)
      expect([...frames].some(v => v > 30)).toBe(true)
      const audio = run(['-i', output, '-vn', '-ar', '48000', '-ac', '1', '-f', 's16le', 'pipe:1'])
      expect(audio.length / 2 / 48000).toBeCloseTo(3.6, 1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)
})
