// 变更追溯：CHG-20261124-113809-agy-shell-c58464c9；记录：.codex/doc/change-history/CHG-20261124-113809-agy-shell-c58464c9.md
// 变更追溯：CHG-20261124-upstream-0914-b8023110；记录：.codex/doc/change-history/CHG-20261124-upstream-0914-b8023110.md
import { publishUsage, failUsage, retainUsageAccounts } from './usage-cache.js'
import type { ProviderUsage, ProviderStatus } from './SubscriptionsSection.js'
// 变更追溯：按会话所属电脑统一查询底栏；记录：.codex/doc/change-history/CHG-20261113-owner-quota-b8023110.md
// 变更追溯：底栏单次查询超时与生命周期取消；记录：.codex/doc/change-history/CHG-20261114-badge-overlay-b8023110.md
import type { ConnectionHandle, RpcResult } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * The node half mounts every endpoint as an exact POST route on the shared
 * `/api` channel (`/api/subscriptions-auth.<endpoint>`), so the browser
 * reaches it through the `/api` channel with a prefixed endpoint name.
 * A dedicated channel is no longer used: since dsh 0.1.5 `rpc.handle`
 * cannot register one from a plugin (see `src/auth/rpc.ts`).
 */
const SUBSCRIPTIONS_AUTH_CHANNEL = '/api'
const SUBSCRIPTIONS_AUTH_PREFIX = 'subscriptions-auth.'

/** Reuse the existing sessionAccount owner-host relay for badge-only reads. */
export function createSessionSubscriptionsRpc(rpc: ConnectionHandle['rpc'], sessionId: string, lifetime?: AbortSignal): ConnectionHandle['rpc'] {
  return {
    call: (channel, endpoint, payload, signal) => {
      const read = endpoint.slice(SUBSCRIPTIONS_AUTH_PREFIX.length)
      if (channel !== SUBSCRIPTIONS_AUTH_CHANNEL || !endpoint.startsWith(SUBSCRIPTIONS_AUTH_PREFIX)
        || !['status', 'usage', 'sessionAccount', 'antigravityStatus', 'antigravityQuota'].includes(read)) {
        throw new Error('Session subscription RPC only supports badge reads')
      }
      const bounded = AbortSignal.any([AbortSignal.timeout(20_000), ...signal ? [signal] : [], ...lifetime ? [lifetime] : []])
      bounded.throwIfAborted()
      return rpc.call(channel, `${SUBSCRIPTIONS_AUTH_PREFIX}sessionAccount`, {
        ...(payload as Record<string, unknown>), sessionId,
        ...(read === 'sessionAccount' ? {} : { read }),
      }, bounded).then(result => { bounded.throwIfAborted(); return result })
    },
  }
}

/** Business error returned by a `subscriptions-auth` endpoint (error branch message). */
export class SubscriptionsAuthError extends Error {}

/**
 * Call one `subscriptions-auth` endpoint and unwrap the business result.
 * Shared by the settings section, the composer Speed toggle, the usage
 * badge, and the image/video toolviews.
 * @param rpc - Connection RPC caller.
 * @param endpoint - endpoint name (`status`, `usage`, `image`, ...).
 * @param payload - endpoint-owned request payload.
 * @returns the success value, cast by the caller to the endpoint's shape.
 */
export async function callSubscriptionsAuth<T>(rpc: ConnectionHandle['rpc'], endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const request = payload as { provider?: string; account?: string } | undefined
  const usageKey = endpoint === 'usage' && request?.provider && request.account ? `${request.provider}:${request.account}` : undefined
  let result: RpcResult<unknown>
  try {
    result = await rpc.call(SUBSCRIPTIONS_AUTH_CHANNEL, `${SUBSCRIPTIONS_AUTH_PREFIX}${endpoint}`, payload, signal)
  } catch (error) {
    if (usageKey) failUsage(rpc, usageKey)
    // The transport rejected rather than answering; surface the same way.
    throw new SubscriptionsAuthError(error instanceof Error ? error.message : String(error))
  }
  if (!result.ok) {
    if (usageKey) failUsage(rpc, usageKey)
    throw new SubscriptionsAuthError(result.error.message)
  }
  let value = result.value
  if (usageKey) {
    // The server may return cached usage even for force=true. Keep receipt
    // time separate; never manufacture fetchedAt or reset server freshness.
    value = { ...value as ProviderUsage, receivedAt: Date.now() }
    publishUsage(rpc, usageKey, value as ProviderUsage)
  }
  if (endpoint === 'status') {
    const status = result.value as { providers: Record<string, ProviderStatus> }
    retainUsageAccounts(rpc, new Set(Object.entries(status.providers).flatMap(([provider, state]) =>
      state.accounts.map(account => `${provider}:${account.key}`))))
  }
  return value as T
}
