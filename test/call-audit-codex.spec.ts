// 变更追溯：CHG-20261124-upstream-0914-b8023110；记录：.codex/doc/change-history/CHG-20261124-upstream-0914-b8023110.md
// 变更追溯：真实 Codex SSE 分发与重试审计；见 .codex/doc/change-history/CHG-20261103-143200-subscription-account-audit-b8023110.md
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CodexAdapter, CODEX_API_URL } from '../src/providers/codex.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { CallAuditStore, auditedAccountAdapter } from '../src/call-audit.js'

test('real Codex generation fetch retries 401 separately and records streamed usage and served account', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-codex-'))
  process.env.DSH_HOME = dir
  const store = new CallAuditStore(join(dir, 'calls.jsonl'))
  const session = { accessToken: 'secret-access', refreshToken: 'secret-refresh', accountId: 'real', expiresAt: Date.now() + 3600000 }
  const tokens = new AccountTokenManager({ provider: 'codex', displayName: 'test',
    makeOptions: () => ({ preemptMs: 0, refresh: async () => session, isPermanent: () => false }),
    io: { list: async () => [{ key: 'real', session }], get: async () => session, save: async () => {}, remove: async () => {} } })
  const raw = new CodexAdapter({ models: [{ id: 'm' }], discovery: false, tokens, streamIdleTimeoutMs: 1000 })
  const adapter = auditedAccountAdapter(raw, 'codex', store, async key => ({ key, label: 'Actual' }))
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => {
    assert.equal(String(url), CODEX_API_URL)
    requests++
    if (requests === 1) return new Response('secret-error-body', { status: 401 })
    return new Response('data: {"type":"response.output_text.delta","item_id":"i","delta":"secret-assistant"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2}}}\n\ndata: [DONE]\n\n', { headers: { 'x-request-id': 'req-2' } })
  })
  const options: GenerateOptions = { provider: 'codex', model: 'm', messages: [], sessionId: 's' as NonNullable<GenerateOptions['sessionId']> }
  for await (const _ of adapter.streamAccount(options, 'real')) { /* drain */ }
  const records = (await store.callAudit('s')).records
  assert.equal(requests, 2)
  assert.equal(records.filter(record => record.event === 'start').length, 2)
  assert.deepEqual(records.filter(record => record.event === 'end').map(record => record.outcome), ['http-error', 'success'])
  assert.deepEqual(records.at(-1)?.usage, { inputTokens: 7, outputTokens: 2 })
  assert.equal(records.at(-1)?.requestId, 'req-2')
  assert.equal((await store.sessionAccount('s', 'codex', 'm')).account?.key, 'real')
  assert.equal(JSON.stringify(records).includes('secret'), false)
})

test('audit persistence failure rejects before any generation dispatch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-closed-'))
  process.env.DSH_HOME = dir
  const blocker = join(dir, 'not-a-directory')
  await writeFile(blocker, 'blocked')
  const store = new CallAuditStore(join(blocker, 'calls.jsonl'))
  const session = { accessToken: 'a', refreshToken: 'r', accountId: 'actual', expiresAt: Date.now() + 3600000 }
  const tokens = new AccountTokenManager({ provider: 'codex', displayName: 'test',
    makeOptions: () => ({ preemptMs: 0, refresh: async () => session, isPermanent: () => false }),
    io: { list: async () => [{ key: 'actual', session }], get: async () => session, save: async () => {}, remove: async () => {} } })
  const adapter = auditedAccountAdapter(new CodexAdapter({ models: [{ id: 'm' }], discovery: false, tokens, streamIdleTimeoutMs: 1000 }),
    'codex', store, async key => ({ key }))
  let dispatches = 0
  t.mock.method(globalThis, 'fetch', async () => { dispatches++; return new Response('') })
  await assert.rejects(async () => { for await (const _ of adapter.streamAccount({ provider: 'codex', model: 'm', messages: [] }, 'actual')) { /* drain */ } })
  assert.equal(dispatches, 0)
})
