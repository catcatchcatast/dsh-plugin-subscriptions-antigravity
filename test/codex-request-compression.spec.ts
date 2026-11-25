// 变更追溯：CHG-20261124-upstream-0914-b8023110；记录：.codex/doc/change-history/CHG-20261124-upstream-0914-b8023110.md
// 变更追溯：单帧规避连续帧解码截断；记录：.codex/doc/change-history/CHG-20261113-zstd-single-b8023110.md
// 变更追溯：标准独立Zstd帧兼容性；记录：.codex/doc/change-history/CHG-20261111-zstd-frames-b8023110.md
// 变更追溯：Codex无损HTTP压缩；记录：.codex/doc/change-history/CHG-20261103-transport-zstd-b8023110.md
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zstdDecompressSync } from 'node:zlib'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { codexHttpBody } from '../src/providers/codex-request-compression.js'
import { CodexAdapter } from '../src/providers/codex.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import { CallAuditStore, auditedAccountAdapter } from '../src/call-audit.js'

const json = JSON.stringify({ model: 'unchanged', instructions: '系统 🌍', input: [
  { role: 'user', content: [{ type: 'input_text', text: '完整上下文'.repeat(100) }, { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }] },
  { type: 'function_call', call_id: 'call_a', name: '工具', arguments: '{"汉字":true}' },
  { type: 'function_call_output', call_id: 'call_a', output: '原始结果' }], tools: [{ type: 'function', name: '工具', parameters: { type: 'object', properties: { 汉字: { type: 'boolean' } } } }], reasoning: { effort: 'high' }, stream: true })

test('native single-frame zstd preserves exact UTF8 JSON bytes with no size threshold', async () => {
  for (const value of [json, '{}']) {
    const encoded = await codexHttpBody(value, 'zstd')
    assert.ok(encoded.body instanceof Uint8Array)
    assert.equal(zstdDecompressSync(encoded.body).toString('utf8'), value)
    assert.equal(encoded.stats.plainBytes, Buffer.byteLength(value))
    assert.equal(encoded.stats.wireBytes, encoded.body.byteLength)
    assert.equal(encoded.stats.encoding, 'zstd'); assert.equal(encoded.stats.result, 'compressed')
    assert.ok(Number.isFinite(encoded.stats.compressionMs) && encoded.stats.compressionMs >= 0)
  }
})
test('single checked bounded-window frame preserves history for every decoder output chunk', async () => {
  for (const minimum of [65535, 65536, 65537, 786433, 1049817, 4 * 1024 * 1024, 24 * 1024 * 1024]) {
    const value = JSON.stringify({ history: json.repeat(Math.ceil(minimum / Buffer.byteLength(json))) })
    const original = Buffer.from(value)
    const encoded = await codexHttpBody(value, 'zstd')
    assert.ok(encoded.body instanceof Uint8Array)
    const wire = Buffer.from(encoded.body)
    for (const chunkSize of [16384, 65536, 131072, 1048576]) {
      const decoded = zstdDecompressSync(wire, { chunkSize })
      assert.ok(decoded.equals(original), `full decode at chunkSize ${chunkSize}`)
    }
    let offset = 0
    assert.equal(wire.readUInt32LE(offset), 0xfd2fb528); offset += 4
    const descriptor = wire[offset++]!
    assert.ok(descriptor & 4, 'frame checksum is enabled')
    assert.equal(descriptor & 3, 0, 'no dictionary required')
    const singleSegment = Boolean(descriptor & 32)
    if (!singleSegment) {
      const window = wire[offset++]!
      const base = 2 ** (10 + (window >>> 3))
      assert.ok(base + base / 8 * (window & 7) <= 65536, 'window at most 64KiB')
    }
    const flag = descriptor >>> 6, sizeBytes = flag ? 1 << flag : singleSegment ? 1 : 0
    assert.ok(sizeBytes > 0, 'exact source size declared')
    const size = Number(wire.readUIntLE(offset, sizeBytes)) + (sizeBytes === 2 ? 256 : 0); offset += sizeBytes
    assert.equal(size, original.length)
    let last = false
    do { const block = wire.readUIntLE(offset, 3); offset += 3; last = Boolean(block & 1); offset += ((block >>> 1) & 3) === 1 ? 1 : block >>> 3 } while (!last)
    offset += 4
    assert.equal(offset, wire.length, 'exactly one complete frame, not concatenated frames')
    assert.equal(encoded.stats.frames, 1)
    assert.equal(encoded.stats.codec, 'zstd-single64k-l1-v1')
  }
})
test('defaultoff identity and local compressor failure preserve original JSON without error details', async () => {
  const disabled = await codexHttpBody(json)
  assert.equal(disabled.body, json); assert.equal(disabled.stats.result, 'disabled')
  const failed = await codexHttpBody(json, 'zstd', undefined, async () => { throw new Error('secret-body-token') })
  assert.equal(failed.body, json); assert.equal(failed.stats.result, 'fallback'); assert.equal(failed.stats.encoding, 'identity')
  assert.equal(JSON.stringify(failed.stats).includes('secret'), false)
})
test('abort before or during compression rejects without identity fallback', async () => {
  const before = new AbortController(); before.abort(new Error('cancel'))
  let compressors = 0
  await assert.rejects(codexHttpBody(json, 'zstd', before.signal, async () => { compressors++; return new Uint8Array() }))
  assert.equal(compressors, 0)
  const during = new AbortController()
  const pending = codexHttpBody(json, 'zstd', during.signal, () => new Promise(() => {}))
  during.abort(new Error('cancel'))
  await assert.rejects(pending, /cancel/)
})

function tokens() {
  const session = { accessToken: 'secret-access', refreshToken: 'secret-refresh', accountId: 'actual', expiresAt: Date.now() + 3600000 }
  return new AccountTokenManager({ provider: 'codex', displayName: 'test', makeOptions: () => ({ preemptMs: 0, refresh: async () => session, isPermanent: () => false }),
    io: { list: async () => [{ key: 'actual', session }], get: async () => session, save: async () => {}, remove: async () => {} } })
}
const options: GenerateOptions = { provider: 'codex', model: 'm', messages: [], system: 'secret-context', sessionId: 's' as NonNullable<GenerateOptions['sessionId']> }
const sse = () => new Response('data: {"type":"response.output_text.delta","item_id":"i","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2}}}\n\ndata: [DONE]\n\n')
async function drain(stream: AsyncIterable<StreamChunk>) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }

for (const mode of [undefined, 'zstd'] as const) test(`Codex HTTP encoding ${mode ?? 'defaultoff'} retains SSE and audited per-attempt stats`, async t => {
  const home = await mkdtemp(join(tmpdir(), 'zstd-audit-')); process.env.DSH_HOME = home
  const store = new CallAuditStore(join(home, 'calls.jsonl'))
  const raw = new CodexAdapter({ models: [{ id: 'm' }], discovery: false, tokens: tokens(), streamIdleTimeoutMs: 1000, ...(mode === undefined ? {} : { requestCompression: mode }) })
  const adapter = auditedAccountAdapter(raw, 'codex', store, async key => ({ key }))
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests++
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('content-type'), 'application/json')
    assert.equal(headers.get('accept'), 'text/event-stream')
    assert.equal(headers.get('content-encoding'), mode === 'zstd' ? 'zstd' : null)
    const plain = mode === 'zstd' ? zstdDecompressSync(init!.body as Uint8Array).toString() : init!.body as string
    assert.equal(JSON.parse(plain).instructions.includes('secret-context'), true)
    if (requests === 1) return new Response('', { status: 401 })
    return sse()
  })
  const chunks = await drain(adapter.streamAccount(options, 'actual'))
  assert.equal(requests, 2); assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'ok'))
  const records = (await store.callAudit('s')).records
  assert.equal(records.length, 4)
  assert.deepEqual(records.filter(record => record.event === 'end').map(record => record.outcome), ['http-error', 'success'])
  for (const record of records) {
    assert.equal(record.account.key, 'actual'); assert.equal(record.requestBody?.encoding, mode === 'zstd' ? 'zstd' : 'identity')
    assert.equal(record.requestBody?.result, mode === 'zstd' ? 'compressed' : 'disabled')
  }
  assert.equal(JSON.stringify(records).includes('secret'), false)
})
for (const failure of [415, 500, 'disconnect'] as const) test(`zstd adds no postdispatch retry for ${failure}`, async t => {
  const home = await mkdtemp(join(tmpdir(), 'zstd-no-retry-')); process.env.DSH_HOME = home
  const adapter = new CodexAdapter({ models: [{ id: 'm' }], discovery: false, tokens: tokens(), streamIdleTimeoutMs: 1000, requestCompression: 'zstd' })
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; if (failure === 'disconnect') throw new TypeError('disconnect'); return new Response('', { status: failure }) })
  await assert.rejects(drain(adapter.streamAccount(options, 'actual')))
  assert.equal(requests, 1)
})
test('preaborted Codex request never dispatches', async t => {
  const home = await mkdtemp(join(tmpdir(), 'zstd-abort-')); process.env.DSH_HOME = home
  const adapter = new CodexAdapter({ models: [{ id: 'm' }], discovery: false, tokens: tokens(), streamIdleTimeoutMs: 1000, requestCompression: 'zstd' })
  let requests = 0; t.mock.method(globalThis, 'fetch', async () => { requests++; return sse() })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(drain(adapter.streamAccount({ ...options, signal: controller.signal }, 'actual')))
  assert.equal(requests, 0)
})
