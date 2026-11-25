// 变更追溯：CHG-20261124-upstream-0914-b8023110；记录：.codex/doc/change-history/CHG-20261124-upstream-0914-b8023110.md
// 变更追溯：所属电脑只读入口；记录：.codex/doc/change-history/CHG-20261113-owner-quota-b8023110.md
// 变更追溯：.codex/doc/change-history/CHG-20261103-143200-subscription-account-audit-b8023110.md

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubscriptionsRpcHandler as ConnectionRpcHandler } from '../src/auth/rpc.js'
import { createFakeConnection } from './fake-connection.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'call-audit-rpc-'))

const plugin = await import('../src/index.js')

async function mount(): Promise<ConnectionRpcHandler> {
  const ctx = new Context()
  ctx.provide('llm', { registerAdapter: () => Object.assign(() => {}, { replace: () => {} }) })
  const fake = createFakeConnection()
  ctx.provide('connection', fake.connection)
  ctx.plugin(plugin, { providers: ['codex'] })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(fake.registered(), 'the subscriptions-auth routes were registered')
  return fake.handler
}

test('sessionAccount endpoint validates sessionId, provider, and model', async () => {
  const handler = await mount()
  const signal = new AbortController().signal
  assert.deepEqual(await handler('sessionAccount', { sessionId: 's1', provider: 'codex', model: 'm' }, signal), {
    ok: true,
    value: { state: 'unknown' },
  })
  const bad = [
    [{}, /sessionId/],
    [{ sessionId: '', provider: 'codex', model: 'm' }, /sessionId/],
    [{ sessionId: 's1', provider: 'unknown', model: 'm' }, /provider/],
    [{ sessionId: 's1', provider: 'codex', model: '' }, /model/],
    ['nope', /object/],
  ] as const
  for (const [payload, pattern] of bad) {
    const result = await handler('sessionAccount', payload, signal)
    assert.equal(result.ok, false, JSON.stringify(payload))
    if (!result.ok) {
      assert.equal(result.error.code, 'bad-request')
      assert.match(result.error.message, pattern)
    }
  }
})

test('session owner route exposes only existing status and quota reads', async () => {
  const handler = await mount()
  const signal = new AbortController().signal
  for (const read of ['status', 'usage']) {
    const payload = { sessionId: 'owner-session', read, provider: 'codex', account: 'missing' }
    assert.deepEqual(await handler('sessionAccount', payload, signal), await handler(read, payload, signal))
  }
  for (const payload of [
    { read: 'status' }, { sessionId: '', read: 'usage' },
    ...['logout', 'login', 'setDefault', 'setRoutingMode', 'callAudit', 3].map(read => ({ sessionId: 's', read })),
  ]) {
    const result = await handler('sessionAccount', payload, signal)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'bad-request')
  }
})

test('callAudit endpoint validates sessionId and optional limit', async () => {
  const handler = await mount()
  const signal = new AbortController().signal
  for (const limit of [undefined, 1, 100]) {
    assert.deepEqual(await handler('callAudit', { sessionId: 's1', ...(limit === undefined ? {} : { limit }) }, signal), {
      ok: true,
      value: { records: [] },
    })
  }
  const bad = [
    [{}, /sessionId/],
    [{ sessionId: '' }, /sessionId/],
    [{ sessionId: 's1', limit: 0 }, /limit/],
    [{ sessionId: 's1', limit: 101 }, /limit/],
    [{ sessionId: 's1', limit: 1.5 }, /limit/],
    [{ sessionId: 's1', limit: '50' }, /limit/],
    ['nope', /object/],
  ] as const
  for (const [payload, pattern] of bad) {
    const result = await handler('callAudit', payload, signal)
    assert.equal(result.ok, false, JSON.stringify(payload))
    if (!result.ok) {
      assert.equal(result.error.code, 'bad-request')
      assert.match(result.error.message, pattern)
    }
  }
})
