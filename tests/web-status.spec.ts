/**
 * Web-status document tests.
 *
 * The document is the contract between the host and the browser half. The card
 * and the control both read it, so the assertions here pin what it must contain
 * — a region's provider id, its control path, the sign-in flag distinct from the
 * model roster, and a control key — which is exactly the surface a half-built
 * implementation would silently omit.
 */

import { describe, expect, it } from 'vitest'
import { workBuddyWebStatus } from '../src/web-status.ts'
import type { WorkBuddyRegionView } from '../src/web-status.ts'
import { WORKBUDDY_AI_CONTROL_PATH, WORKBUDDY_CONTROL_PATH } from '../src/status-paths.ts'
import { FALLBACK_WORKBUDDY_MODELS } from '../src/catalog.ts'
import type { WorkBuddyCredential } from '../src/credentials.ts'

function regionView(region: 'cn' | 'global', models: readonly { id: string; name: string }[] = []): WorkBuddyRegionView {
  return {
    region,
    providerId: region === 'global' ? 'workbuddy-standalone-ai' : 'workbuddy-standalone',
    models: () => models as never,
    probeRunning: () => false,
    probeCandidates: () => [],
    probeResults: () => [],
    hiddenModels: () => [],
    useMaximumContextWindow: () => false,
  }
}

function credential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs: Date.now() + 60_000,
    domain: 'workbuddy.ai',
    uid: 'uid-1',
    region: 'cn',
    ...overrides,
  }
}

describe('workBuddyWebStatus', () => {
  it('reports a stable ok discriminator, version, and control key', async () => {
    const document = await workBuddyWebStatus({
      regions: [],
      controlKey: 'k',
      credentials: async () => [],
    })
    expect(document.status).toBe('ok')
    expect(typeof document.version).toBe('string')
    expect(document.controlKey).toBe('k')
  })

  it('lists accounts with label, region, expiry, and enabled state', async () => {
    const document = await workBuddyWebStatus({
      regions: [],
      controlKey: 'k',
      credentials: async () => [credential({ nickname: '爱在', expiresAtMs: 1234 })],
    })
    expect(document.accounts).toEqual([
      { uid: 'uid-1', label: '爱在', region: 'cn', expiresAtMs: 1234, enabled: true },
    ])
  })

  it('reports a disabled account as still listed but not enabled', async () => {
    // Disabling is not signing out: the credential file stays, so the card must
    // keep showing the row (it is still an account) while marking it unusable.
    const document = await workBuddyWebStatus({
      regions: [],
      controlKey: 'k',
      credentials: async () => [credential({ nickname: '爱在' })],
      disabled: async () => new Set(['uid-1']),
    })
    expect(document.accounts[0]?.enabled).toBe(false)
    expect(document.accounts[0]?.label).toBe('爱在')
  })

  it('masks a phone-number nickname in the document the card renders', async () => {
    // The card is a display surface, so it must not publish a raw mobile number.
    const document = await workBuddyWebStatus({
      regions: [],
      controlKey: 'k',
      credentials: async () => [credential({ nickname: '13800138000' })],
    })
    expect(document.accounts[0]?.label).toBe('138*****000')
  })

  it('marks a region signed in independently of its roster', async () => {
    // An account whose catalog fetch has not landed has a credential and no
    // models; the card must not read that as "signed out".
    const document = await workBuddyWebStatus({
      regions: [regionView('cn')],
      controlKey: 'k',
      credentials: async () => [credential({ region: 'cn' })],
    })
    expect(document.regions[0]?.signedIn).toBe(true)
    expect(document.regions[0]?.models).toEqual([])
  })

  it('reports the empty roster while signed out rather than the fallback', async () => {
    const document = await workBuddyWebStatus({
      regions: [regionView('cn', FALLBACK_WORKBUDDY_MODELS)],
      controlKey: 'k',
      credentials: async () => [],
    })
    expect(document.regions[0]?.signedIn).toBe(false)
  })

  it('gives each region its own provider id and control path', async () => {
    const document = await workBuddyWebStatus({
      regions: [regionView('cn'), regionView('global')],
      controlKey: 'k',
      credentials: async () => [],
    })
    const byRegion = new Map(document.regions.map(region => [region.region, region]))
    expect(byRegion.get('cn')?.providerId).toBe('workbuddy-standalone')
    expect(byRegion.get('cn')?.controlPath).toBe(WORKBUDDY_CONTROL_PATH)
    expect(byRegion.get('global')?.providerId).toBe('workbuddy-standalone-ai')
    expect(byRegion.get('global')?.controlPath).toBe(WORKBUDDY_AI_CONTROL_PATH)
  })

  it('carries probe results paired with their model id and name', async () => {
    const models = [{ id: 'hy3', name: 'Hy3' }]
    const view = regionView('cn', models)
    const document = await workBuddyWebStatus({
      regions: [{
        ...view,
        probeResults: () => [{
          id: 'hy3',
          record: {
            fingerprint: 'f', validation: 'validating', efforts: ['low', 'high'],
            probedAtMs: 100, pluginVersion: '0.0.1', account: 'uid-1:',
          },
        }],
      }],
      controlKey: 'k',
      credentials: async () => [credential()],
    })
    expect(document.regions[0]?.probeResults).toEqual([
      { id: 'hy3', name: 'Hy3', validation: 'validating', efforts: ['low', 'high'], probedAt: 100 },
    ])
  })

  it('drops a probe result whose model left the catalog', async () => {
    const document = await workBuddyWebStatus({
      regions: [{
        ...regionView('cn', [{ id: 'hy3', name: 'Hy3' }]),
        probeResults: () => [{
          id: 'vanished',
          record: {
            fingerprint: 'f', validation: 'validating', efforts: ['low'],
            probedAtMs: 100, pluginVersion: '0.0.1', account: 'uid-1:',
          },
        }],
      }],
      controlKey: 'k',
      credentials: async () => [credential()],
    })
    expect(document.regions[0]?.probeResults).toEqual([])
  })
})
