// 变更追溯：CHG-20261124-upstream-0914-b8023110；记录：.codex/doc/change-history/CHG-20261124-upstream-0914-b8023110.md
// 变更追溯：单帧编码审计标识；记录：.codex/doc/change-history/CHG-20261113-zstd-single-b8023110.md
// 变更追溯：标准独立Zstd帧兼容性；记录：.codex/doc/change-history/CHG-20261111-zstd-frames-b8023110.md
// 变更追溯：Codex无损HTTP压缩；记录：.codex/doc/change-history/CHG-20261103-transport-zstd-b8023110.md
// 变更追溯：实际调用审计与会话账号归属；见 .codex/doc/change-history/CHG-20261103-143200-subscription-account-audit-b8023110.md
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { llmErrorFromFailure } from './providers/common.js'
import { type LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ProviderId } from './auth/store.js'
import type { AccountAwareAdapter } from './providers/accounts.js'

export interface RequestBodyStats {
  plainBytes: number
  wireBytes: number
  encoding: 'identity' | 'zstd'
  compressionMs: number
  result: 'disabled' | 'compressed' | 'fallback'
  codec?: 'zstd-frames64k-v1' | 'zstd-single64k-l1-v1'
  frames?: number
}

export interface CallAuditRecord {
  requestBody?: RequestBodyStats
  event: 'start' | 'end'
  callId: string
  provider: ProviderId
  account: { key: string; label?: string }
  model: string
  routeProvider: string
  routeModel: string
  sessionId?: string
  startedAt: number
  endedAt?: number
  status?: number
  requestId?: string
  outcome?: 'success' | 'http-error' | 'transport-error' | 'error' | 'cancelled' | 'empty'
  served?: boolean
  usage?: Record<string, number>
}
export interface SessionAccountState {
  state: 'active' | 'last' | 'unknown'
  account?: { key: string; label?: string; model: string; callId: string; startedAt: number }
}
const routeKey = Symbol('subscriptions-audit-route')
type RoutedOptions = GenerateOptions & { [routeKey]?: { provider: string; model: string } }
export function withAuditRoute(options: GenerateOptions): GenerateOptions {
  return { ...options, [routeKey]: (options as RoutedOptions)[routeKey] ?? { provider: options.provider, model: options.model } } as RoutedOptions
}
function keyOf(record: CallAuditRecord): string {
  return JSON.stringify([record.sessionId, record.routeProvider, record.routeModel])
}
export class CallAuditStore {
  private ready?: Promise<void>
  private queue: Promise<void> = Promise.resolve()
  private records: CallAuditRecord[] = []
  private active = new Map<string, Map<string, CallAuditRecord>>()
  private last = new Map<string, CallAuditRecord>()
  private order = new Map<string, number>()
  private sequence = 0
  private lastOrder = new Map<string, number>()
  constructor(private readonly path = dshHomePath('plugins', 'subscriptions', 'calls.jsonl')) {}
  private apply(record: CallAuditRecord, replay = false): void {
    this.records.push(record)
    if (this.records.length > 2000) this.records.shift()
    const key = keyOf(record)
    if (record.event === 'start') {
      this.order.set(record.callId, ++this.sequence)
      if (!replay) {
        const active = this.active.get(key) ?? new Map<string, CallAuditRecord>()
        active.set(record.callId, record)
        this.active.set(key, active)
      }
    } else {
      const active = this.active.get(key)
      active?.delete(record.callId)
      if (active?.size === 0) this.active.delete(key)
      const order = this.order.get(record.callId) ?? 0
      if (record.served && order > (this.lastOrder.get(key) ?? 0)) {
        this.last.set(key, record)
        this.lastOrder.set(key, order)
      }
      this.order.delete(record.callId)
    }
  }
  private load(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const file = await open(this.path, 'a+', 0o600)
      try { await file.chmod(0o600) } finally { await file.close() }
      const lines = createInterface({ input: createReadStream(this.path), crlfDelay: Infinity })
      for await (const line of lines) {
        if (line) this.apply(JSON.parse(line) as CallAuditRecord, true)
      }
    })()
    return this.ready
  }
  async append(record: CallAuditRecord): Promise<void> {
    try { await this.load() } catch (error) {
      throw llmErrorFromFailure({ message: 'Subscription call audit initialization failed', code: 'AUDIT_PERSISTENCE' }, { cause: error })
    }
    const pending = this.queue.then(async () => {
      const file = await open(this.path, 'a', 0o600)
      try { await file.writeFile(`${JSON.stringify(record)}\n`); await file.sync() } finally { await file.close() }
      this.apply(record)
    })
    this.queue = pending
    try { await pending } catch (error) {
      throw llmErrorFromFailure({ message: 'Subscription call audit persistence failed', code: 'AUDIT_PERSISTENCE' }, { cause: error })
    }
  }
  async sessionAccount(sessionId: string, provider: ProviderId, model: string): Promise<SessionAccountState> {
    await this.load()
    const key = JSON.stringify([sessionId, provider, model])
    const candidate = [...this.active.get(key)?.values() ?? []].at(-1)
    const active = candidate && (this.order.get(candidate.callId) ?? 0) > (this.lastOrder.get(key) ?? 0) ? candidate : undefined
    const record = active ?? this.last.get(key)
    if (!record) return { state: 'unknown' }
    return { state: active ? 'active' : 'last', account: { ...record.account, model: record.model, callId: record.callId, startedAt: record.startedAt } }
  }
  async callAudit(sessionId: string, limit = 50): Promise<{ records: CallAuditRecord[] }> {
    await this.load()
    return { records: this.records.filter(record => record.sessionId === sessionId).slice(-limit) }
  }
}
interface Scope {
  store: CallAuditStore
  options: GenerateOptions
  provider: ProviderId
  identity(): Promise<{ key: string; label?: string }>
  current?: CallAuditRecord
  served: boolean
  usage: Record<string, number>
}
const calls = new AsyncLocalStorage<Scope>()
async function end(scope: Scope, outcome: NonNullable<CallAuditRecord['outcome']>): Promise<void> {
  if (!scope.current) return
  const record = scope.current
  delete scope.current
  await scope.store.append({ ...record, event: 'end', endedAt: Date.now(), outcome, served: scope.served, ...(Object.keys(scope.usage).length ? { usage: scope.usage } : {}) })
}
/** Only generation fetch call sites use this helper; preparation and discovery never count. */
export async function auditGenerationFetch(dispatch: () => Promise<Response>, signal?: AbortSignal, requestBody?: RequestBodyStats): Promise<Response> {
  const scope = calls.getStore()
  if (!scope) return dispatch()
  const route = (scope.options as RoutedOptions)[routeKey] ?? { provider: scope.options.provider, model: scope.options.model }
  const record: CallAuditRecord = {
    event: 'start', callId: randomUUID(), provider: scope.provider, account: await scope.identity(),
    model: scope.options.model, routeProvider: route.provider, routeModel: route.model,
    ...(scope.options.sessionId ? { sessionId: scope.options.sessionId } : {}), startedAt: Date.now(),
    ...requestBody === undefined ? {} : { requestBody: {
      plainBytes: requestBody.plainBytes, wireBytes: requestBody.wireBytes, encoding: requestBody.encoding,
      compressionMs: requestBody.compressionMs, result: requestBody.result,
      ...requestBody.codec === undefined ? {} : { codec: requestBody.codec },
      ...requestBody.frames === undefined ? {} : { frames: requestBody.frames },
    } },
  }
  await scope.store.append(record)
  scope.current = record
  scope.served = false
  scope.usage = {}
  let response: Response
  try { response = await dispatch() } catch (error) {
    await end(scope, signal?.aborted ? 'cancelled' : 'transport-error')
    throw error
  }
  record.status = response.status
  const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id')
  if (requestId && /^[\w.:-]{1,200}$/.test(requestId)) record.requestId = requestId
  if (!response.ok) await end(scope, 'http-error')
  return response
}
/** Capture the public route before the official pool selects a concrete provider. */
export function auditedRouteAdapter<T extends LlmAdapter>(adapter: T): T {
  return new Proxy(adapter, { get(target, property) {
    if (property === 'stream') return (options: GenerateOptions) => target.stream(withAuditRoute(options))
    if (property === 'prepareCall') return async (provider: string, model: string, signal?: AbortSignal) => {
      const prepared = await target.prepareCall(provider, model, signal)
      return { ...prepared, stream: (options: GenerateOptions) => prepared.stream(withAuditRoute(options)) }
    }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
const usageFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const
export function auditedAccountAdapter(
  adapter: AccountAwareAdapter, provider: ProviderId, store: CallAuditStore,
  identity: (account: string) => Promise<{ key: string; label?: string }>,
): AccountAwareAdapter {
  return new Proxy(adapter, { get(target, property) {
    if (property === 'streamAccount') return async function* (options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
      const scope: Scope = { store, options, provider, identity: () => identity(account), served: false, usage: {} }
      const iterator = target.streamAccount(options, account)[Symbol.asyncIterator]()
      let outcome: NonNullable<CallAuditRecord['outcome']> = 'cancelled'
      try {
        while (true) {
          const next = await calls.run(scope, () => iterator.next())
          if (next.done) { if (outcome !== 'error') outcome = scope.served ? 'success' : 'empty'; break }
          const chunk = next.value
          if (chunk.type === 'usage') {
            for (const field of usageFields) {
              const value = (chunk.usage as unknown as Record<string, unknown>)[field]
              if (typeof value === 'number' && Number.isFinite(value) && value >= 0) scope.usage[field] = value
            }
          } else if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'error') outcome = 'error'
          } else if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text.length > 0
            || chunk.type === 'tool-call-delta') scope.served = true
          yield chunk
        }
      } catch (error) { outcome = options.signal?.aborted ? 'cancelled' : 'error'; throw error }
      finally {
        try { await calls.run(scope, () => iterator.return?.()) } finally { await end(scope, options.signal?.aborted ? 'cancelled' : outcome) }
      }
    }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
