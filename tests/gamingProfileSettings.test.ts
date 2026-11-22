import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { gamingComposition } from '@shared/composition'

const location = vi.hoisted(() => ({ profile: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => location.profile, getVersion: () => 'test' },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../src/main/pipeline/encoders', () => ({ getGpuStatus: async () => ({}) }))

it('reopens local Gaming profiles after the settings cache is discarded', async () => {
  location.profile = await mkdtemp(join(tmpdir(), 'cutawan-profiles-'))
  try {
    const { updateSettings, getSettings } = await import('../src/main/settings')
    expect((await getSettings()).gamingProfiles).toEqual([])
    const r = { x: .1, y: .1, width: .5, height: .5 }
    const profile = { name: 'Camera left', sourcePath: '/video.mp4', composition: gamingComposition(r, r)! }
    await updateSettings({ gamingProfiles: [profile] })
    vi.resetModules()
    const reopened = await import('../src/main/settings')
    expect((await reopened.getSettings()).gamingProfiles).toEqual([profile])
    await reopened.updateSettings({ gamingProfiles: [] })
    vi.resetModules()
    expect((await (await import('../src/main/settings')).getSettings()).gamingProfiles).toEqual([])
  } finally { await rm(location.profile, { recursive: true, force: true }) }
})
