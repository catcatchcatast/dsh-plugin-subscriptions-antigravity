// 变更追溯：CHG-20261124-upstream-0914-b8023110；记录：.codex/doc/change-history/CHG-20261124-upstream-0914-b8023110.md
// 变更追溯：.codex/doc/change-history/CHG-20261103-143200-subscription-account-audit-b8023110.md

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { auditedAccountAdapter, auditGenerationFetch, CallAuditStore, withAuditRoute } from '../src/call-audit.js'
import type { AccountAwareAdapter } from '../src/providers/accounts.js'

const text: StreamChunk = { type: 'text-delta', index: 0, text: 'ok' }
const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const session = (id: string) => id as NonNullable<GenerateOptions['sessionId']>
const options = (model = 'model-a', sessionId = 'session-a', provider = 'codex'): GenerateOptions => ({
  provider, model, messages: [], sessionId: session(sessionId),
})

async function fixture(run: (f: {
  store: CallAuditStore
  raw: AccountAwareAdapter
  audited: AccountAwareAdapter
  path: string
  options: GenerateOptions
}) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'call-audit-'))
  const path = join(dir, 'calls.jsonl')
  const store = new CallAuditStore(path)
  const raw = {
    async *streamAccount(_options: GenerateOptions, _account: string): AsyncIterable<StreamChunk> {
      await auditGenerationFetch(async () => new Response('ok'))
      yield text
      yield finish
    },
    async listOwnModels() {
      await auditGenerationFetch(async () => new Response('discovery'))
      return []
    },
  } as unknown as AccountAwareAdapter
  const audited = auditedAccountAdapter(raw, 'codex', store, async account => ({ key: account, label: `label-${account}` }))
  try { await run({ store, raw, audited, path, options: options() }) }
  finally { await rm(dir, { recursive: true, force: true }) }
}

async function consume(adapter: AccountAwareAdapter, opts: GenerateOptions, account = 'acct'): Promise<void> {
  for await (const _chunk of adapter.streamAccount(opts, account)) { /* drain */ }
}

async function records(store: CallAuditStore, sessionId = 'session-a') {
  return (await store.callAudit(sessionId)).records
}

test('audits each generation dispatch including each 401 retry, never discovery', async () => {
  await fixture(async ({ store, raw, audited, options }) => {
    let dispatches = 0
    raw.streamAccount = async function* () {
      await auditGenerationFetch(async () => { dispatches++; return new Response('unauthorized', { status: 401 }) })
      await auditGenerationFetch(async () => { dispatches++; return new Response('ok', { status: 200 }) })
      yield text
      yield finish
    }
    await audited.listOwnModels('codex')
    await consume(audited, options)
    assert.equal(dispatches, 2)
    assert.deepEqual((await records(store)).filter(row => row.event === 'start').length, 2)
    assert.deepEqual((await records(store)).filter(row => row.event === 'end').map(row => row.outcome), ['http-error', 'success'])
  })
})

test('records only finite nonnegative allowlisted usage and excludes secrets and bodies', async () => {
  await fixture(async ({ store, raw, audited, path, options }) => {
    raw.streamAccount = async function* () {
      await auditGenerationFetch(async () => new Response('SENSITIVE_RESPONSE_BODY', {
        status: 200,
        headers: { authorization: 'Bearer SECRET_HEADER', 'x-request-id': 'req.123' },
      }))
      yield { type: 'usage', usage: {
        inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6, reasoningTokens: 7,
        secret: 99, negative: -1, nan: Number.NaN, infinite: Number.POSITIVE_INFINITY, string: '8',
      } } as unknown as StreamChunk
      yield finish
    }
    await consume(audited, { ...options, messages: [{ role: 'user', content: [{ type: 'text', text: 'SENSITIVE_REQUEST_BODY' }] }] } as GenerateOptions)
    const textFile = await readFile(path, 'utf8')
    const rows = (await records(store))
    const end = rows.find(row => row.event === 'end')!
    assert.deepEqual(end.usage, { inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6, reasoningTokens: 7 })
    assert.equal(end.requestId, 'req.123')
    for (const secret of ['SECRET_HEADER', 'SENSITIVE_REQUEST_BODY', 'SENSITIVE_RESPONSE_BODY', 'secret', 'negative', 'nan', 'infinite', 'string']) {
      assert.equal(textFile.includes(secret), false, `JSONL must not contain ${secret}`)
    }
  })
})

test('replays durable last served account after store restart', async () => {
  await fixture(async ({ path, store }) => {
    const start = { event: 'start', callId: 'call-1', provider: 'codex', account: { key: 'acct', label: 'Account' }, model: 'model-a', routeProvider: 'codex', routeModel: 'model-a', sessionId: 'session-a', startedAt: 100 } as const
    await store.append(start)
    await store.append({ ...start, event: 'end', endedAt: 200, outcome: 'success', served: true })
    const restarted = new CallAuditStore(path)
    assert.deepEqual(await restarted.sessionAccount('session-a', 'codex', 'model-a'), {
      state: 'last', account: { key: 'acct', label: 'Account', model: 'model-a', callId: 'call-1', startedAt: 100 },
    })
  })
})

test('isolates last account by session, routed provider, and routed model', async () => {
  await fixture(async ({ store, audited }) => {
    const opts = [
      { options: options('model-a', 'session-a'), provider: 'codex', model: 'model-a' },
      { options: options('model-a', 'session-b'), provider: 'codex', model: 'model-a' },
      { options: options('model-a', 'session-a'), provider: 'claude', model: 'model-a' },
      { options: options('model-b', 'session-a'), provider: 'codex', model: 'model-b' },
    ]
    for (let i = 0; i < opts.length; i++) {
      const { options: optsForCall, provider, model } = opts[i]
      await consume(audited, withAuditRoute({ ...optsForCall, provider, model } as GenerateOptions), `acct-${i}`)
    }
    assert.equal((await store.sessionAccount('session-a', 'codex', 'model-a')).account?.key, 'acct-0')
    assert.equal((await store.sessionAccount('session-b', 'codex', 'model-a')).account?.key, 'acct-1')
    assert.equal((await store.sessionAccount('session-a', 'claude', 'model-a')).account?.key, 'acct-2')
    assert.equal((await store.sessionAccount('session-a', 'codex', 'model-b')).account?.key, 'acct-3')
  })
})

test('concurrent streams keep latest-started served account despite older completion finishing last', async () => {
  await fixture(async ({ store, raw, audited, options }) => {
    let enteredFirst!: () => void
    let enteredSecond!: () => void
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstDispatched = new Promise<void>(resolve => { enteredFirst = resolve })
    const secondDispatched = new Promise<void>(resolve => { enteredSecond = resolve })
    const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve })
    const secondResponse = new Promise<void>(resolve => { releaseSecond = resolve })
    raw.streamAccount = async function* (_opts, account) {
      await auditGenerationFetch(async () => {
        if (account === 'older') { enteredFirst(); await firstResponse }
        else { enteredSecond(); await secondResponse }
        return new Response('ok', { status: 200 })
      })
      yield text
      yield finish
    }
    const older = consume(audited, options, 'older')
    await firstDispatched
    const newer = consume(audited, options, 'newer')
    await secondDispatched
    releaseSecond()
    await newer
    assert.equal((await store.sessionAccount('session-a', 'codex', 'model-a')).account?.key, 'newer')
    releaseFirst()
    await older
    const rows = await records(store)
    assert.equal(rows.filter(row => row.event === 'start').length, 2)
    assert.equal(rows.filter(row => row.event === 'end').length, 2)
    assert.equal((await store.sessionAccount('session-a', 'codex', 'model-a')).account?.key, 'newer')
  })
})

test('empty, cancelled, and failed streams do not replace the last served account', async () => {
  await fixture(async ({ store, raw, audited, options }) => {
    raw.streamAccount = async function* (_opts, account) {
      await auditGenerationFetch(async () => new Response('ok'))
      if (account === 'empty') return
      if (account === 'failure') throw new Error('stream failure')
      yield text
      yield finish
    }
    await consume(audited, options, 'last-good')
    await consume(audited, options, 'empty')
    await assert.rejects(consume(audited, options, 'failure'), /stream failure/)
    const controller = new AbortController()
    raw.streamAccount = async function* () {
      await auditGenerationFetch(async () => new Response('ok'))
      controller.abort()
      return
    }
    await consume(audited, { ...options, signal: controller.signal }, 'cancelled')
    assert.equal((await store.sessionAccount('session-a', 'codex', 'model-a')).account?.key, 'last-good')
    const endings = (await records(store)).filter(row => row.event === 'end')
    assert.deepEqual(endings.slice(-3).map(row => row.outcome), ['empty', 'error', 'cancelled'])
  })
})

test('newer failed dispatch reveals the older still-active stream', async () => {
  await fixture(async ({ store, raw, audited, options }) => {
    raw.streamAccount = async function* (_options, account) {
      const response = await auditGenerationFetch(async () => new Response('', { status: account === 'new' ? 503 : 200 }))
      if (!response.ok) throw new Error('pre-output')
      yield text
      yield finish
    }
    const older = audited.streamAccount(options, 'old')[Symbol.asyncIterator]()
    await older.next()
    assert.equal((await store.sessionAccount('session-a', 'codex', 'model-a')).account?.key, 'old')
    await assert.rejects(consume(audited, options, 'new'))
    assert.equal((await store.sessionAccount('session-a', 'codex', 'model-a')).state, 'active')
    assert.equal((await store.sessionAccount('session-a', 'codex', 'model-a')).account?.key, 'old')
    await older.return?.()
    const last = await store.sessionAccount('session-a', 'codex', 'model-a')
    assert.equal(last.state, 'last')
    assert.equal(last.account?.key, 'old')
  })
})
