// 变更追溯：CHG-20261124-145318-quota-models-47c9e254；记录：.codex/doc/change-history/CHG-20261124-145318-quota-models-47c9e254.md
// 变更追溯：CHG-20261124-113809-agy-shell-c58464c9；记录：.codex/doc/change-history/CHG-20261124-113809-agy-shell-c58464c9.md
import { symbols, type Context } from '@deepseek-ai/cordis'

/** Read-only subset of the pinned antigravityAcp service contract. */
type State = 'idle' | 'starting' | 'ready' | 'error'
type SubscriptionTier = 'ULTRA' | 'PRO' | 'FREE' | 'ENTERPRISE'

export interface AntigravityStatus {
  displayName: string
  state: State
  error?: string | undefined
  accounts: {
    id: string
    label: string
    enabled: boolean
    state: State
    error?: string | undefined
    subscriptionTier?: SubscriptionTier
    subscriptionName?: string
  }[]
}

export interface AntigravityQuotaGroup {
  kind?: 'gemini' | 'argon' | 'claude'
  name: string
  description: string
  buckets: {
    id: string
    name: string
    window: string
    remainingFraction: number
    resetTime: string
    disabled?: boolean
  }[]
}

export interface AntigravityQuota {
  status: 'ok' | 'error'
  updatedAt: string
  groups: AntigravityQuotaGroup[]
  error?: string
  subscriptionTier?: SubscriptionTier
  subscriptionName?: string
  accountId?: string
  accountLabel?: string
  model?: string
  focus?: {
    model: string
    family: NonNullable<AntigravityQuotaGroup['kind']>
    entitled: boolean
    reason?: 'model-not-entitled' | 'no-groups'
    group?: AntigravityQuotaGroup
  }
}

export type AntigravityQuotaRequest = { force: boolean } & (
  | { accountId: string }
  | { model: string; sessionId: string }
)

export interface AntigravityAcpReads {
  status(): AntigravityStatus
  quota(request: AntigravityQuotaRequest): Promise<AntigravityQuota>
}

interface ModelVisibility {
  visibleModels: readonly string[]
  hiddenModels: readonly string[]
}

export interface AntigravityModelCatalog {
  models: { id: string; name: string; enabled: boolean; locked: boolean }[]
}

type BridgeModelStatus = ModelVisibility & {
  availableModels: readonly Omit<AntigravityModelCatalog['models'][number], 'locked'>[]
}

interface AntigravityModelBridge {
  status(): BridgeModelStatus
  configure(patch: Partial<ModelVisibility>): Promise<BridgeModelStatus>
  options: { settingsNs: string }
  ctx: Context
}

export function getAntigravityBridge(ctx: Context): AntigravityAcpReads {
  // As with the optional attachment service, resolve per request; the bridge can
  // start after subscriptions and must not be a dependency of the other providers.
  const bridge = ctx.get('antigravityAcp') as AntigravityAcpReads | undefined
  if (!bridge) throw new Error('Official Antigravity ACP bridge (antigravityAcp) is unavailable on this host')
  return bridge
}

// Cordis traces services to their caller; unwrap to read the owning bridge context.
function modelBridge(ctx: Context): AntigravityModelBridge {
  const bridge = getAntigravityBridge(ctx) as unknown as AntigravityModelBridge & { [symbols.original]?: AntigravityModelBridge }
  return bridge[symbols.original] ?? bridge
}

function modelCatalog(status: BridgeModelStatus): AntigravityModelCatalog {
  return { models: status.availableModels.map(({ id, name, enabled }) => ({
    id, name, enabled,
    locked: status.hiddenModels.some(rule => {
      if (!rule.endsWith('*')) return false
      const prefix = rule.slice(0, -1)
      return id.startsWith(prefix) || name.startsWith(prefix)
    }),
  })) }
}

export function antigravityModels(ctx: Context): AntigravityModelCatalog {
  return modelCatalog(modelBridge(ctx).status())
}

const saving = new WeakSet<AntigravityModelBridge>()

export async function setAntigravityModels(ctx: Context, changes: readonly { id: string; enabled: boolean }[]): Promise<AntigravityModelCatalog> {
  const bridge = modelBridge(ctx)
  const before = bridge.status()
  const { models } = modelCatalog(before)
  const byId = new Map(models.map(model => [model.id, model]))
  const desired = new Map(models.map(model => [model.id, model.enabled]))
  for (const { id, enabled } of changes) {
    const model = byId.get(id)
    if (!model || model.locked) throw new Error(`Antigravity ACP model "${id}" cannot be changed; reload the model list`)
    desired.set(id, enabled)
  }
  const previous = { visibleModels: before.visibleModels, hiddenModels: before.hiddenModels }
  // Keep both native visibility rules. An empty allowlist means all; exact
  // hide rules can remove the final advertised model without enabling it again.
  const patch = {
    visibleModels: before.visibleModels.length === 0 ? [] : [
      ...before.visibleModels,
      ...changes.filter(change => change.enabled && !before.visibleModels.includes(change.id)).map(change => change.id),
    ],
    hiddenModels: [...new Set([
      ...before.hiddenModels.filter(rule => desired.get(rule) !== true),
      ...changes.filter(change => !change.enabled).map(change => change.id),
    ])],
  }
  if (patch.visibleModels.length > 500 || patch.hiddenModels.length > 500) throw new Error('Antigravity ACP visibility rules exceed the bridge limit')
  const settings = bridge.ctx.get('settings') as { writable?: boolean; update?: (ns: string, patch: ModelVisibility) => Promise<void> } | undefined
  // The pinned bridge derives this namespace from its own mounted fiber entry.
  const ns = bridge.options.settingsNs
  if (settings?.writable !== true || typeof settings.update !== 'function') throw new Error('Antigravity model management requires writable profile settings')
  if (saving.has(bridge)) throw new Error('Antigravity model settings are already being saved')
  saving.add(bridge)
  try {
    // The bridge persists hiddenModels before applying but can ignore errors
    // writing visibleModels. Require one successful profile write for both.
    await settings.update(ns, patch)
    try {
      const result = modelCatalog(await bridge.configure(patch))
      if (!changes.every(change => result.models.some(model => model.id === change.id && model.enabled === change.enabled))) {
        throw new Error('Antigravity ACP did not apply the requested model visibility')
      }
      return result
    } catch (error) {
      try {
        await settings.update(ns, previous)
        await bridge.configure(previous)
      } catch (rollbackError) {
        throw new Error(`${String(error)}; could not restore prior Antigravity model settings: ${String(rollbackError)}`)
      }
      throw error
    }
  } finally {
    saving.delete(bridge)
  }
}

export function antigravityStatus(bridge: AntigravityAcpReads): AntigravityStatus {
  const { displayName, state, error, accounts } = bridge.status()
  return {
    displayName, state, error,
    // Account profiles contain env, home paths and proxies; these are not quota data.
    accounts: accounts.map(({ id, label, enabled, state, error, subscriptionTier, subscriptionName }) => ({
      id, label, enabled, state, error,
      ...subscriptionTier === undefined ? {} : { subscriptionTier },
      ...subscriptionName === undefined ? {} : { subscriptionName },
    })),
  }
}
