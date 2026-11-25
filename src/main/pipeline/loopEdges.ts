import { FFPROBE_PATH, FFMPEG_PATH, runBinary, runFfmpegWith } from './ffmpeg'

/** Use the encoded picture clock, including frame rounding and overlap edits. */
export function loopWindow(frames: number, rate: string, seconds: number) {
  const [num, den] = rate.split('/').map(Number)
  const fps = num / den
  if (!Number.isSafeInteger(frames) || frames < 1 || !(fps > 0) || !Number.isFinite(fps) ||
      !Number.isInteger(seconds) || seconds < 1 || seconds > 5) throw new Error('Invalid loop preview window.')
  const count = Math.max(1, Math.min(Math.floor(frames / 2), Math.round(seconds * fps)))
  return { start: (frames - count) / fps, seam: count / fps, count }
}

export async function extractLoopEdges(master: string, output: string, seconds: number, signal?: AbortSignal) {
  const info = JSON.parse(await runBinary(FFPROBE_PATH, ['-v', 'error', '-show_entries',
    'stream=codec_type,nb_frames,avg_frame_rate,r_frame_rate,duration', '-of', 'json', master], { signal })) as {
      streams: { codec_type: string; nb_frames: string; avg_frame_rate: string; r_frame_rate: string; duration: string }[]
    }
  const video = info.streams.find(s => s.codec_type === 'video')
  if (!video) throw new Error('Rendered clip has no picture.')
  const { start, seam, count } = loopWindow(Number(video.nb_frames), video.avg_frame_rate, seconds)
  const [num, den] = video.r_frame_rate.split('/').map(Number)
  if (Math.abs(count / seam - num / den) > 0.001) {
    throw new Error('This export has variable frame timing. Inspect the exported MP4 to judge its loop.')
  }
  const audio = info.streams.find(s => s.codec_type === 'audio')
  if (audio && Math.abs(Number(audio.duration) - Number(video.duration)) > seam / count) {
    throw new Error('The exported sound and picture end more than a frame apart. Inspect the exported MP4 to judge its loop.')
  }
  const graph = [0, 1].map(i => `[${i}:v]trim=end_frame=${count},setpts=PTS-STARTPTS[v${i}]`)
  graph.push(`[v0][v1]concat=n=2:v=1:a=0,settb=1/(${video.avg_frame_rate}),setpts=N,scale=w=min(720\\,iw):h=-2[v]`)
  if (audio) {
    for (const i of [0, 1]) graph.push(`[${i}:a]apad,atrim=duration=${seam},asetpts=PTS-STARTPTS[a${i}]`)
    graph.push('[a0][a1]concat=n=2:v=0:a=1[a]')
  }
  await runFfmpegWith(FFMPEG_PATH, ['-ss', String(Math.max(0, start - 0.00001)), '-i', master,
    '-i', master, '-filter_complex', graph.join(';'), '-map', '[v]', ...(audio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '192k'] : []),
    '-r', video.avg_frame_rate, '-c:v', 'libx264', '-crf', '16', '-preset', 'veryfast', '-movflags', '+faststart', output], { signal })
  return seam
}
