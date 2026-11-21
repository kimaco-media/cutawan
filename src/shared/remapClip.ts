import type { Clip } from './types'
import { automaticLayoutShots } from './contentType'
import { remapFocusTrack, type TimeMap } from './tighten'

/** Apply the output map to source annotations, shared by captions and rendering. */
export function remapClipTimeline(clip: Clip, map: TimeMap): Clip {
  const shots = automaticLayoutShots(clip).flatMap(shot => map.mapRange(shot)).sort((a, b) => a.start - b.start)
  let end = 0
  const exclusiveShots = shots.flatMap(shot => {
    const start = Math.max(end, shot.start)
    if (shot.end <= start) return []
    end = shot.end
    return [{ ...shot, start }]
  })
  return {
    ...clip,
    edit: { ...clip.edit, start: 0, end: map.outputDuration },
    visualLayout: clip.visualLayout ? {
      ...clip.visualLayout, start: 0, end: map.outputDuration,
      shots: exclusiveShots
    } : undefined,
    broll: clip.broll.flatMap(b => map.mapRange(b)).filter(b => b.end - b.start > 0.6)
      .sort((a, b) => a.start - b.start),
    focusTrack: clip.focusTrack ? remapFocusTrack(clip.focusTrack, map) : null
  }
}
