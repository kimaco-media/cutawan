import { it, expect } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeTranscript } from './helpers'
import { clipTimelineParts } from '@shared/clipTimeline'
import { manualCuePlan, type SoundAsset } from '@shared/manualSound'
import type { Clip } from '@shared/types'
import { soundDirectory, importSound, readSoundLibrary } from '../src/main/soundLibrary'
import { probeVideo, runFfmpeg } from '../src/main/pipeline/ffmpeg'
import { renderClip } from '../src/main/pipeline/render'
import { withManualSounds } from '../src/main/pipeline/manualSoundMix'

it('places a reused MP3 on the finished timeline of a silent reordered video', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cutawan-manual-sound-'))
  try {
    const dir = soundDirectory(root, 'project')
    expect(() => soundDirectory(root, '../elsewhere')).toThrow()
    const assets: SoundAsset[] = []
    const persist = async (asset: SoundAsset) => { assets.push(asset) }
    const picked = join(root, 'impact.mp3')
    await expect(importSound(dir, picked, persist)).rejects.toThrow(/Cannot read impact\.mp3.*select it again/)
    expect(assets).toHaveLength(0)
    await writeFile(picked, 'bad audio')
    await expect(importSound(dir, picked, persist)).rejects.toThrow(/Could not import/)
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=f=440:d=1', '-c:a', 'libmp3lame', '-y', picked])
    await importSound(dir, picked, persist)
    await rm(picked)
    const library = await readSoundLibrary(dir, assets)
    const assetId = assets[0].id
    const first = { id: 'one', assetId, startOutputSec: .3, trimStartSec: .1, trimEndSec: .4, gainDb: 0, enabled: true }
    const placements = [first, { ...first, id: 'two', startOutputSec: 2.8, gainDb: -6 },
      { ...first, id: 'three', startOutputSec: 2.9 }, { ...first, id: 'mute', startOutputSec: 1, enabled: false }]
    const plan = manualCuePlan(placements, library, 3)
    expect(plan.cues).toHaveLength(3)
    expect(plan.cues[1].duration).toBeCloseTo(.2)
    const graph = withManualSounds({ filterComplex: 'base', audioLabel: 'dubout',
      extraInputs: ['-i', 'caption', '-i', 'broll', '-i', 'logo', '-i', 'music', '-i', 'dub'] }, plan.cues, 3, 3)
    expect(graph.extraInputs.filter(a => a === '-i')).toHaveLength(6)
    expect(graph.filterComplex).toContain('[8:a:0]')
    expect(graph.filterComplex).toContain('[dubout][manual0][manual1][manual2]amix')
    const sourcePath = join(root, 'silent.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=25:d=4', '-an', sourcePath])
    const source = await probeVideo(sourcePath)
    const clip: Clip = { suggestedStart: 0, suggestedEnd: 4, summary: '', viralityScore: 0, viralityReason: '',
      visualSummary: null, hashtags: [], thumbnailPath: null, focusTrack: null, id: 'clip', title: '', hook: '', broll: [], edit: { aspect: 'original', framing: 'manual',
      reframeMode: 'crop', captionStyleId: 'clean', tightenCuts: false, focusX: .5, start: 0, end: 4, captionsEnabled: false, showTitle: false,
      sequence: [{ id: 'a', start: 2, end: 4 }, { id: 'b', start: 0, end: 2 }],
      transitions: [{ fromId: 'a', toId: 'b', duration: .4, kind: 'dissolve' }], manualSoundEffects: placements } }
    const outputPath = join(root, 'edit.mp4')
    await renderClip({ source, clip, transcript: null, soundLibrary: library, outputPath, encoder: 'cpu', quality: 'draft' })
    const exported = await probeVideo(outputPath)
    expect(exported.hasAudio).toBe(true)
    expect(exported.durationSec).toBeCloseTo(3.6, 1)
    const pcm = join(root, 'audio.raw')
    await runFfmpeg(['-i', outputPath, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', pcm])
    const samples = await readFile(pcm)
    const peak = (time: number) => {
      const from = Math.round(time * 8000)
      let max = 0
      for (let i = from; i < from + 160; i++) max = Math.max(max, Math.abs(samples.readInt16LE(i * 2)))
      return max
    }
    expect(peak(.16)).toBeLessThan(20)
    expect(peak(.42)).toBeGreaterThan(500)
    expect(peak(1.1)).toBeLessThan(20)
    expect(peak(2.84)).toBeGreaterThan(300)
    expect(peak(2.84)).toBeLessThan(peak(.42) * .65)
    expect(peak(2.95)).toBeGreaterThan(peak(2.84))
    expect(peak(3.4)).toBeLessThan(20)
    const longPath = join(root, 'long.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=25:d=16',
      '-f', 'lavfi', '-i', 'sine=f=180:d=16', '-c:v', 'libx264', '-c:a', 'aac', longPath])
    const extended: Clip = { ...clip, edit: { ...clip.edit, end: 16, coldOpen: true,
      sequence: [{ id: 'a', start: 8, end: 16 }, { id: 'b', start: 0, end: 8 }],
      manualSoundEffects: [{ ...first, startOutputSec: .2 }, { ...first, id: 'late', startOutputSec: 13.2 }] } }
    const transcript = makeTranscript(['Victory is finally ours!'], { startSec: 1, wordSec: .4, gapSec: .05 })
    const cold = clipTimelineParts(extended, transcript).coldOpen!
    expect(cold).toBeTruthy()
    const combined = join(root, 'joined.mp4')
    await renderClip({ clip: extended, source: await probeVideo(longPath), transcript, soundLibrary: library,
      outputPath: combined, encoder: 'cpu', quality: 'draft' })
    expect(Math.abs((await probeVideo(combined)).durationSec - (16 + cold.end - cold.start - .4))).toBeLessThan(.1)
    // Isolate the imported tone from the original voice tone to check both clocks.
    await runFfmpeg(['-y', '-i', combined, '-vn', '-af', 'highpass=f=380:p=2,highpass=f=380:p=2',
      '-ac', '1', '-ar', '8000', '-f', 's16le', pcm])
    const mixed = await readFile(pcm)
    const energy = (t: number) => {
      let total = 0
      for (let i = 0; i < 400; i++) total += mixed.readInt16LE((Math.round(t * 8000) + i) * 2) ** 2
      return total / 400
    }
    expect(energy(.3)).toBeGreaterThan(energy(.8) * 3)
    expect(energy(13.3)).toBeGreaterThan(energy(13.8) * 3)
    await writeFile(library[0].path!, 'damaged')
    const broken = await readSoundLibrary(dir, assets, new Set([assetId]))
    await expect(renderClip({ source, clip, transcript: null, soundLibrary: broken, outputPath })).rejects.toThrow(/damaged sound effect.*impact.mp3/)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60_000)
