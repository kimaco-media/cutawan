import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Clip, Project } from '@shared/types'
import { gamingComposition } from '@shared/composition'
import { exportWaitsForReframe, manualLayoutSupersedesAnalysis, needsReframe } from '@shared/reframe'

/**
 * Regression tests for the export-blocking gaming layout: a manually
 * configured composition must never wait on (or start) automatic face
 * detection, speaker tracking or AI layout analysis, and an in-flight
 * analysis superseded by a manual choice must cancel without breaking
 * callers still attached to it. The analysis is mocked so the scheduling
 * behaviour is tested deterministically; the real analysis path is covered
 * by lazyReframe.test.ts.
 */

const { userData } = await vi.hoisted(async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  return { userData: path.join(os.tmpdir(), `cutawan-reframe-supersede-${process.pid}-${Date.now()}`) }
})

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => process.cwd(), isPackaged: false }
}))

const mocks = vi.hoisted(() => ({ analyse: vi.fn() }))
vi.mock('../src/main/pipeline/clipLayout', () => ({ analyzeClipLayout: mocks.analyse }))

const { ensureClipReframe, supersedeClipReframe } = await import('../src/main/pipeline/reframe')
const { loadProject, projectDir, updateProject } = await import('../src/main/projects')

const PROJECT_ID = 'reframe-supersede-test'

function pendingClip(id: string, end: number): Clip {
  return {
    id,
    suggestedStart: 0,
    suggestedEnd: end,
    title: id,
    hook: '',
    summary: '',
    viralityScore: 50,
    viralityReason: '',
    visualSummary: null,
    hashtags: [],
    thumbnailPath: null,
    focusTrack: null,
    reframeStatus: 'pending',
    contentType: null,
    broll: [],
    edit: {
      aspect: '9:16',
      reframeMode: 'crop',
      framing: 'auto',
      tightenCuts: false,
      autoZoom: false,
      focusX: 0.5,
      captionsEnabled: false,
      captionStyleId: 'beast',
      showTitle: false,
      start: 0,
      end
    }
  }
}

/** What CompositionControls.saveRegions persists for a manual Gaming layout. */
function chooseManualGaming(clip: Clip): void {
  const composition = gamingComposition({ x: .7, y: .03, width: .27, height: .3 },
    { x: .01, y: .01, width: .98, height: .98 })!
  composition.layers[0].focus = { x: .5, y: .4 }
  clip.visualLayout = { start: clip.edit.start, end: clip.edit.end, preserveContext: true, allowZoom: false,
    reason: 'Manually selected source regions.', revision: 1,
    shots: [{ start: clip.edit.start, end: clip.edit.end, mode: 'fit', composition,
      review: { status: 'needs-review', reason: 'Source regions adjusted manually; review this shot before exporting.' } }] }
  Object.assign(clip.edit, { layoutChosen: true, framing: 'auto', reframeMode: 'crop', autoZoom: false })
}

async function writeManualGaming(clipId: string): Promise<void> {
  await updateProject(PROJECT_ID, (fresh) => {
    const clip = fresh.clips.find((c) => c.id === clipId)
    if (clip) chooseManualGaming(clip)
  })
}

/** The automatic analysis: never settles until aborted, like a long real run. */
function hangUntilAborted(): void {
  mocks.analyse.mockImplementation((_path, _clip, _type, _key, _model, _transcript, signal) =>
    new Promise((_resolve, reject) => {
      const abort = (): void => reject(new DOMException('Reframe analysis cancelled', 'AbortError'))
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    }))
}

beforeAll(async () => {
  const dir = projectDir(PROJECT_ID)
  await mkdir(dir, { recursive: true })
  // The video only needs to exist: analysis and rendering are mocked here.
  const videoPath = join(dir, 'source.mp4')
  await writeFile(videoPath, 'stub', 'utf8')
  const project: Project = {
    id: PROJECT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    name: 'Reframe supersede',
    video: { path: videoPath, fileName: 'source.mp4', durationSec: 30, width: 1920, height: 1080,
      fps: 30, sizeBytes: 1, hasAudio: true },
    transcript: null,
    clips: [pendingClip('gaming', 30), pendingClip('mid', 30), pendingClip('late', 30), pendingClip('auto', 30)],
    prompt: '',
    videoType: 'auto'
  }
  await writeFile(join(dir, 'project.json'), JSON.stringify(project), 'utf8')
  hangUntilAborted()
})

afterAll(async () => {
  await rm(userData, { recursive: true, force: true })
})

describe('manual gaming layout versus automatic analysis', () => {
  it('never analyses a clip whose manual gaming composition is already saved', async () => {
    const saved = await updateProject(PROJECT_ID, (fresh) => {
      chooseManualGaming(fresh.clips.find((c) => c.id === 'gaming')!)
    })
    const clip = saved.clips.find((c) => c.id === 'gaming')!
    expect(manualLayoutSupersedesAnalysis(clip)).toBe(true)
    expect(needsReframe(clip)).toBe(false)

    const project = await ensureClipReframe(PROJECT_ID, 'gaming')
    expect(mocks.analyse).not.toHaveBeenCalled()
    const after = project.clips.find((c) => c.id === 'gaming')!
    // No analysis started, landed or restarted: the manual layout is the result.
    expect(after.reframeStatus).toBe('pending')
    expect(after.focusTrack).toBeNull()
    expect(after.visualLayout?.shots?.[0].composition?.preset).toBe('gaming')
    expect(needsReframe(after)).toBe(false)
  })

  it('cancels an in-flight analysis superseded by a manual layout without failing its waiters', async () => {
    const editorWait = ensureClipReframe(PROJECT_ID, 'mid')
    await vi.waitFor(() => expect(mocks.analyse).toHaveBeenCalledTimes(1))
    // An export joined the running analysis before the manual choice landed.
    const exportController = new AbortController()
    const exportWait = ensureClipReframe(PROJECT_ID, 'mid', exportController.signal)
    await writeManualGaming('mid')
    // What the updateClip handler does once the manual layout is durable.
    supersedeClipReframe(PROJECT_ID, 'mid')

    const editorResult = await editorWait
    const exported = await exportWait
    for (const result of [editorResult, exported]) {
      const clip = result.clips.find((c) => c.id === 'mid')!
      expect(clip.visualLayout?.shots?.[0].composition?.preset).toBe('gaming')
      expect(clip.visualLayout?.revision).toBe(1)
      expect(clip.focusTrack).toBeNull()
    }
    // Cancelled, not failed, and not restarted.
    expect(mocks.analyse).toHaveBeenCalledTimes(1)
  })

  it('lets an export skip the obsolete in-flight analysis and render the saved layout', async () => {
    const staleRun = ensureClipReframe(PROJECT_ID, 'late')
    await vi.waitFor(() => expect(mocks.analyse).toHaveBeenCalledTimes(2))
    // The manual choice is on disk; the old run is still analysing. The
    // export handler's gate says render as saved: no ensureClipReframe call,
    // so nothing waits on the obsolete analysis.
    await writeManualGaming('late')
    const fresh = await loadProject(PROJECT_ID)
    const clip = fresh.clips.find((c) => c.id === 'late')!
    expect(exportWaitsForReframe(clip)).toBe(false)
    expect(needsReframe(clip)).toBe(false)
    // The updateClip handler then cancels the obsolete analysis.
    supersedeClipReframe(PROJECT_ID, 'late')
    const result = await staleRun
    expect(result.clips.find((c) => c.id === 'late')?.visualLayout?.shots?.[0].composition?.preset).toBe('gaming')
    expect(mocks.analyse).toHaveBeenCalledTimes(2)
    // A later export-style call is a plain no-op: no analysis restarts.
    const again = await ensureClipReframe(PROJECT_ID, 'late')
    expect(again.clips.find((c) => c.id === 'late')?.visualLayout?.revision).toBe(1)
    expect(mocks.analyse).toHaveBeenCalledTimes(2)
  })

  it('still analyses pending clips without a manual layout', async () => {
    mocks.analyse.mockImplementationOnce(async (_path, clip: Clip) => {
      clip.reframeStatus = 'done'
      clip.reframeAnalysis = { start: clip.edit.start, end: clip.edit.end, version: 2 }
      clip.contentType = 'speaker'
      clip.focusTrack = [{ t: clip.edit.start, x: .5 }]
    })
    const project = await ensureClipReframe(PROJECT_ID, 'auto')
    const clip = project.clips.find((c) => c.id === 'auto')!
    expect(clip.reframeStatus).toBe('done')
    expect(clip.focusTrack).toEqual([{ t: 0, x: .5 }])
    expect(needsReframe(clip)).toBe(false)
  })
})
