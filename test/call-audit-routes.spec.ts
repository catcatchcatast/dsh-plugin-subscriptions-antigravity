// 变更追溯：CHG-20261124-upstream-0914-b8023110；记录：.codex/doc/change-history/CHG-20261124-upstream-0914-b8023110.md
// 变更追溯：验证真实路由分发审计；见 .codex/doc/change-history/CHG-20261103-143200-subscription-account-audit-b8023110.md
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallAuditStore, auditedAccountAdapter, auditGenerationFetch, auditedRouteAdapter } from '../src/call-audit.js'
import { AccountPreferencesAdapter, accountModelId } from '../src/providers/account-preferences.js'
import { ProviderSettingsStore } from '../src/provider-settings.js'
import { PoolAdapter } from '../src/providers/pool.js'
import { PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'

class Raw extends LlmAdapter {
  dispatches: string[] = []
  failA = false
  async listOwnModels(provider: string) { return [{ provider, id: 'm', name: 'M' }] }
  async resolveOwnModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 100 } } }
  clearAccountCatalog() {}
  async *stream(): AsyncIterable<StreamChunk> { throw new Error('unexpected default') }
  async *streamAccount(_options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    const response = await auditGenerationFetch(async () => { this.dispatches.push(account); return new Response('', { status: this.failA && account === 'a' ? 503 : 200 }) })
    if (!response.ok) throw new LlmError('failed before output', 'SERVER')
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
test('direct, independent and pooled routes retain public alias and concrete dispatched account', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-routes-'))
  const store = new CallAuditStore(join(dir, 'calls.jsonl'))
  const settings = new ProviderSettingsStore(join(dir, 'settings.json'))
  await settings.set('codex', { accounts: { b: { independentEntry: true } } })
  const raw = new Raw()
  const audited = auditedAccountAdapter(raw, 'codex', store, async key => ({ key, label: key.toUpperCase() }))
  let pool: PoolAdapter | undefined
  const route = auditedRouteAdapter(new AccountPreferencesAdapter({ provider: 'codex', adapter: audited, settings,
    accounts: async () => [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], pool: () => pool }))
  const run = async (model: string) => { for await (const _ of route.stream({ provider: 'codex', model, messages: [], sessionId: 'session' as NonNullable<GenerateOptions['sessionId']> })) { /* drain */ } }
  await route.prepareCall('codex', 'm')
  assert.equal((await store.callAudit('session')).records.length, 0)
  await run('m')
  assert.equal((await store.sessionAccount('session', 'codex', 'm')).account?.key, 'a')
  const independent = accountModelId('b', 'm')
  await run(independent)
  assert.equal((await store.sessionAccount('session', 'codex', independent)).account?.key, 'b')
  pool = new PoolAdapter({ adapters: { codex: route.poolMember() },
    families: async () => new Map(), tiers: { tier: [
      { provider: 'codex', account: 'a', model: 'm' }, { provider: 'codex', account: 'b', model: 'm' },
    ] }, health: new PoolHealthRegistry(), usage: new PoolUsageTracker(() => undefined), strategy: 'priority',
    switchMargin: 2, defaultAccount: async () => 'a', onWarn: () => {} })
  raw.failA = true
  await run('tier')
  const last = await store.sessionAccount('session', 'codex', 'tier')
  assert.equal(last.account?.key, 'b')
  assert.equal(last.account?.model, 'm')
  assert.deepEqual(raw.dispatches, ['a', 'b', 'a', 'b'])
  const records = (await store.callAudit('session')).records
  assert.equal(records.filter(record => record.event === 'start').length, raw.dispatches.length)
  const grok = auditedAccountAdapter(new Raw(), 'grok', store, async key => ({ key }))
  pool = new PoolAdapter({ adapters: { codex: route.poolMember(), grok }, families: async () => new Map(),
    tiers: { cross: [{ provider: 'codex', account: 'a', model: 'm' }, { provider: 'grok', account: 'g', model: 'm' }] }, health: new PoolHealthRegistry(),
    usage: new PoolUsageTracker(() => undefined), strategy: 'priority', switchMargin: 2,
    defaultAccount: async () => 'g', onWarn: () => {} })
  const options = { provider: 'codex', model: 'cross', messages: [], sessionId: 'session' as NonNullable<GenerateOptions['sessionId']> }
  for await (const _ of route.stream(options)) { /* drain */ }
  assert.equal((await store.sessionAccount('session', 'codex', 'cross')).account?.key, 'g')
  const prepared = await route.prepareCall('codex', 'cross')
  for await (const _ of prepared.stream(options)) { /* drain */ }
  assert.equal((await store.sessionAccount('session', 'codex', 'cross')).account?.key, 'g')
})
