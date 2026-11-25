// 变更追溯：CHG-20261124-113809-agy-shell-c58464c9；记录：.codex/doc/change-history/CHG-20261124-113809-agy-shell-c58464c9.md
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.js'
import type { AntigravityAcpReads, AntigravityQuota, AntigravityQuotaRequest } from '../src/antigravity-bridge.js'
import { createFakeConnection } from './fake-connection.js'

const MODEL = 'gemini-4-argon'
const signal = new AbortController().signal

async function mount(t: TestContext, providers: plugin.Config['providers'] = []) {
  const home = await mkdtemp(join(tmpdir(), 'antigravity-bridge-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const registrations: string[] = []
  ctx.provide('llm', { registerAdapter: (routes: string[]) => {
    registrations.push(...routes)
    return Object.assign(() => {}, { replace: () => {} })
  } })
  const connection = createFakeConnection()
  const dispose = ctx.provide('connection', connection.connection)
  const runtime = ctx.plugin(plugin, { providers, codexClientVersion: '0.157.1', pool: { enabled: false } })
  t.after(async () => {
    await runtime.dispose()
    await dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(connection.registered())
  const call = (endpoint: string, payload: unknown) => connection.handler(endpoint, payload, signal)
  return { ctx, registrations, call }
}

function fakeBridge(requests: AntigravityQuotaRequest[]): AntigravityAcpReads {
  const accounts = ['last-used', 'alice', 'bob'].map(id => ({
    id, label: `${id} (ACP)`, state: 'ready' as const, enabled: true, env: { PRIVATE_FLAG: 'hidden' },
  }))
  const status = { displayName: 'Official Google', state: 'ready' as const, accounts, lastAccount: 'last-used' }
  return {
    status: () => status,
    async quota(request) {
      requests.push(request)
      const accountId = 'accountId' in request ? request.accountId : request.sessionId === 'owned-1' ? 'alice' : 'bob'
      const group = {
        kind: 'argon' as const, name: 'Argon', description: '',
        buckets: [{ id: 'weekly', name: 'Weekly', window: 'weekly', remainingFraction: accountId === 'alice' ? 0.7 : 0.4, resetTime: '2026-12-01T00:00:00Z' }],
      }
      return {
        status: 'ok', updatedAt: '2026-11-24T00:00:00Z', groups: [group], accountId, accountLabel: `${accountId} (ACP)`,
        ...'model' in request ? { model: request.model, focus: { model: request.model, family: 'argon', entitled: true, group } } : {},
      }
    },
  }
}

test('bridge status and quota work after late service mount, including through the owner route', async t => {
  const { call, ctx } = await mount(t)
  const absent = await call('antigravityStatus', {})
  assert.ok(!absent.ok)
  assert.match(absent.error.message, /antigravityAcp.*unavailable on this host/)
  const requests: AntigravityQuotaRequest[] = []
  const disposeBridge = ctx.provide('antigravityAcp', fakeBridge(requests))
  t.after(disposeBridge)
  const status = await call('antigravityStatus', {})
  assert.deepEqual(status, { ok: true, value: {
    displayName: 'Official Google', state: 'ready',
    accounts: ['last-used', 'alice', 'bob'].map(id => ({ id, label: `${id} (ACP)`, enabled: true, state: 'ready' })),
  } })
  assert.deepEqual(await call('sessionAccount', { sessionId: 'owned-1', read: 'antigravityStatus' }), status)
  for (const [sessionId, accountId, expectedFraction] of [['owned-1', 'alice', 0.7], ['owned-2', 'bob', 0.4]] as const) {
    const result = await call('sessionAccount', { sessionId, read: 'antigravityQuota', model: MODEL, force: true })
    assert.ok(result.ok)
    const quota = result.value as AntigravityQuota
    assert.equal(quota.accountId, accountId)
    assert.equal(quota.focus?.group?.buckets[0].remainingFraction, expectedFraction)
  }
  assert.ok((await call('antigravityQuota', { accountId: 'bob', force: true })).ok)
  assert.ok((await call('sessionAccount', { read: 'antigravityQuota', sessionId: 'owned-1', accountId: 'last-used' })).ok)
  assert.deepEqual(requests, [
    { model: MODEL, sessionId: 'owned-1', force: true },
    { model: MODEL, sessionId: 'owned-2', force: true },
    { accountId: 'bob', force: true },
    { accountId: 'last-used', force: false },
  ])
})

test('bridge errors are surfaced and invalid quota inputs never fall back to a different account', async t => {
  const { call, ctx } = await mount(t)
  const requests: AntigravityQuotaRequest[] = []
  const bridge = fakeBridge(requests)
  const disposeBridge = ctx.provide('antigravityAcp', bridge)
  t.after(disposeBridge)
  for (const [endpoint, payload] of [
    ['antigravityQuota', {}],
    ['antigravityQuota', { accountId: 'not-configured' }],
    ['antigravityQuota', { model: MODEL, sessionId: 'local-must-not-bypass-owner' }],
    ['antigravityQuota', { accountId: 'bob', force: 'true' }],
    ['sessionAccount', { read: 'antigravityQuota', model: MODEL }],
    ['sessionAccount', { read: 'antigravityQuota', sessionId: 'owned-1', model: MODEL, accountId: 'bob' }],
  ] as const) {
    const result = await call(endpoint, payload)
    assert.ok(!result.ok)
    assert.equal(result.error.code, 'bad-request')
  }
  assert.deepEqual(requests, [])
  bridge.quota = async () => { throw new Error('official quota failed') }
  const result = await call('antigravityQuota', { accountId: 'bob' })
  assert.ok(!result.ok)
  assert.equal(result.error.message, 'official quota failed')
})

test('raw configuration rejects removed Google routes and pool members', () => {
  const ctx = new Context()
  for (const config of [
    { providers: ['antigravity'] },
    { pool: { families: { 'removed-model': [{ provider: 'antigravity', model: MODEL }] } } },
    { pool: { tiers: { 'removed-tier': [{ provider: 'antigravity', model: MODEL }] } } },
  ]) {
    assert.throws(() => plugin.apply(ctx, config as plugin.Config), /unsupported subscription provider "antigravity"/)
  }
})

test('subscriptions does not register an Antigravity adapter or serve legacy Google endpoints', async t => {
  const { call, registrations } = await mount(t, ['codex', 'claude', 'grok', 'copilot'])
  assert.deepEqual(registrations, ['codex', 'claude', 'grok', 'copilot'])
  const cases = [
    'login', 'manual', 'cancel', 'logout', 'setDefault', 'providerSettings', 'setProviderSettings', 'setModelDefault', 'usage', 'sessionAccount',
  ]
  for (const endpoint of cases) {
    const result = await call(endpoint, { provider: 'antigravity', sessionId: 's', model: MODEL, input: 'code', account: 'alice' })
    assert.ok(!result.ok, endpoint)
    assert.equal(result.error.code, 'bad-request', endpoint)
  }
  const status = await call('status', {})
  assert.ok(status.ok)
  assert.deepEqual(Object.keys((status.value as { providers: object }).providers), registrations)
})
