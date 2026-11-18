import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Clip, ContentRegion, Transcript } from '@shared/types'
import { compositionPixels, gamingComposition } from '@shared/composition'
import { contentRegionPixels } from '@shared/contentRegion'
import { probeVideo, runFfmpeg } from '../src/main/pipeline/ffmpeg'
import { renderClip } from '../src/main/pipeline/render'

/**
 * Full-bleed gaming export: both strips must cover the whole 1080x1920 frame
 * edge to edge — sampled at the panel corners and across the seam — with no
 * black margins above, between or below the facecam and gameplay crops.
 */
it('renders the gaming layout full-bleed with no black bars at the split', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cutawan-gaming-render-'))
  try {
    for (const split of [.3, .35]) {
      const sourcePath = join(dir, `source-${split}.mp4`)
      // Solid boxes mark the two source regions exactly as the crop sees them.
      const facecam: ContentRegion = { x: .70, y: .03, width: .27, height: .30 }
      const gameplay: ContentRegion = { x: .05, y: .35, width: .90, height: .60 }
      const box = (region: ContentRegion, color: string): string => {
        const p = contentRegionPixels(region, 1280, 720)
        return `drawbox=x=${p.x}:y=${p.y}:w=${p.width}:h=${p.height}:color=${color}:t=fill`
      }
      await runFfmpeg(['-f', 'lavfi', '-i', 'color=black:size=1280x720:rate=5:duration=1',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-vf', `${box(facecam, 'red')},${box(gameplay, 'blue')}`,
        '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', sourcePath])
      const source = await probeVideo(sourcePath)
      const composition = gamingComposition(facecam, gameplay, split)!
      const clip: Clip = { id: 'test', title: '', hook: '', summary: '', broll: [], focusTrack: null,
        suggestedStart: 0, suggestedEnd: 1, viralityScore: 0, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null,
        edit: { aspect: '9:16', framing: 'auto', reframeMode: 'crop', focusX: .5, captionStyleId: 'clean', showTitle: false,
          start: 0, end: 1, captionsEnabled: false, autoZoom: false, tightenCuts: false },
        visualLayout: { start: 0, end: 1, preserveContext: true, allowZoom: false, reason: 'fixture',
          shots: [{ start: 0, end: 1, mode: 'fit', composition }] } }
      const outputPath = join(dir, `output-${split}.mp4`)
      await renderClip({ clip, source, transcript: null, outputPath, encoder: 'cpu', quality: 'draft' })
      const info = await probeVideo(outputPath)
      expect([info.width, info.height]).toEqual([1080, 1920])
      const rawPath = join(dir, `frame-${split}.rgb`)
      await runFfmpeg(['-ss', '0.5', '-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawPath])
      const raw = await readFile(rawPath)
      const pixel = (x: number, y: number): number[] => [...raw.subarray((y * 1080 + x) * 3, (y * 1080 + x) * 3 + 3)]
      const seam = compositionPixels(composition, source, 1080, 1920)[0].target.height
      // Corners of both strips show their crop, not black margins.
      for (const [x, y] of [[8, 8], [1072, 8], [8, seam - 10], [1072, seam - 10]]) {
        expect(pixel(x, y)[0]).toBeGreaterThan(150)
        expect(pixel(x, y)[2]).toBeLessThan(80)
      }
      for (const [x, y] of [[8, seam + 10], [1072, seam + 10], [8, 1912], [1072, 1912]]) {
        expect(pixel(x, y)[2]).toBeGreaterThan(150)
        expect(pixel(x, y)[0]).toBeLessThan(80)
      }
      // No black band at the split: rows just above and below the seam are
      // filled by their crops (a letterbox would span far more than this).
      expect(pixel(540, seam - 4)[0]).toBeGreaterThan(150)
      expect(pixel(540, seam + 4)[2]).toBeGreaterThan(150)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 30000)

/** Captions must overlay the gameplay strip (below the seam, clear of the facecam). */
it('burns captions onto the gameplay without reaching the facecam strip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cutawan-gaming-captions-'))
  try {
    const sourcePath = join(dir, 'source.mp4')
    const facecam: ContentRegion = { x: .70, y: .03, width: .27, height: .30 }
    const gameplay: ContentRegion = { x: .05, y: .35, width: .90, height: .60 }
    const box = (region: ContentRegion, color: string): string => {
      const p = contentRegionPixels(region, 1280, 720)
      return `drawbox=x=${p.x}:y=${p.y}:w=${p.width}:h=${p.height}:color=${color}:t=fill`
    }
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=black:size=1280x720:rate=5:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-vf', `${box(facecam, 'red')},${box(gameplay, 'blue')}`,
      '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', sourcePath])
    const source = await probeVideo(sourcePath)
    const transcript: Transcript = { language: 'en', durationSec: 1,
      segments: [{ id: 0, text: 'hello world', start: 0, end: 1,
        words: [{ text: 'HELLO', start: .05, end: .5 }, { text: 'WORLD', start: .5, end: .95 }] }] }
    const clip: Clip = { id: 'test', title: '', hook: '', summary: '', broll: [], focusTrack: null,
      suggestedStart: 0, suggestedEnd: 1, viralityScore: 0, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null,
      edit: { aspect: '9:16', framing: 'auto', reframeMode: 'crop', focusX: .5, captionStyleId: 'beast', showTitle: false,
        start: 0, end: 1, captionsEnabled: true, autoZoom: false, tightenCuts: false },
      visualLayout: { start: 0, end: 1, preserveContext: true, allowZoom: false, reason: 'fixture',
        shots: [{ start: 0, end: 1, mode: 'fit', composition: gamingComposition(facecam, gameplay)! }] } }
    const outputPath = join(dir, 'output.mp4')
    await renderClip({ clip, source, transcript, outputPath, encoder: 'cpu', quality: 'draft' })
    const rawPath = join(dir, 'frame.rgb')
    await runFfmpeg(['-ss', '0.5', '-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawPath])
    const raw = await readFile(rawPath)
    const pixel = (x: number, y: number): number[] => [...raw.subarray((y * 1080 + x) * 3, (y * 1080 + x) * 3 + 3)]
    const white = (x: number, y: number): boolean => Math.min(...pixel(x, y)) > 100
    const seam = compositionPixels(clip.visualLayout!.shots![0].composition!, source, 1080, 1920)[0].target.height
    const anchor = Math.round(clip.visualLayout!.shots![0].composition!.captionY * 1920)
    expect(anchor).toBeGreaterThan(seam + 100)
    // Word-level caption text shows around the anchor, inside the gameplay.
    let captionPixels = 0
    for (let y = anchor - 120; y <= anchor + 120; y += 4) {
      for (let x = 120; x < 960; x += 8) if (white(x, y)) captionPixels++
    }
    expect(captionPixels).toBeGreaterThan(20)
    // Nothing is burned over the facecam strip above the seam.
    let facecamText = 0
    for (let y = 60; y < seam - 20; y += 4) {
      for (let x = 120; x < 960; x += 8) if (white(x, y)) facecamText++
    }
    expect(facecamText).toBe(0)
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 30000)
