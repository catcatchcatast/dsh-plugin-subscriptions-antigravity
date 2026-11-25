// 变更追溯：CHG-20261124-145318-quota-models-47c9e254；记录：.codex/doc/change-history/CHG-20261124-145318-quota-models-47c9e254.md
// 变更追溯：CHG-20261124-113809-agy-shell-c58464c9；记录：.codex/doc/change-history/CHG-20261124-113809-agy-shell-c58464c9.md
import type { AntigravityQuota } from '../antigravity-bridge.js'
import type { SubscriptionsKey } from './locales.js'
import { quotaPercent, quotaText } from './quota-display.js'
import { usageBarColor } from './SubscriptionsSection.js'
import type { QuotaDisplayMode } from './usage-badge-preferences.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string
type Group = AntigravityQuota['groups'][number]

function weekly(bucket: Group['buckets'][number]): boolean {
  return /week|7d/i.test(`${bucket.window} ${bucket.id}`)
}

export function antigravityWindowLabel(bucket: Group['buckets'][number], t: Translate): string {
  return weekly(bucket) ? t('usageWeeklyLimit') : /5h|five.hour/i.test(`${bucket.window} ${bucket.id}`)
    ? t('usageFiveHourLimit') : bucket.window || bucket.name || t('usageWindow')
}

export function antigravityUsedPercent(bucket: Group['buckets'][number]): number {
  return Number.isFinite(bucket.remainingFraction) ? (1 - bucket.remainingFraction) * 100 : NaN
}

/** Only the bridge's model focus determines which quota can be spent. */
export function antigravityCompactQuota(quota: AntigravityQuota | undefined, model: string, t: Translate, mode: QuotaDisplayMode): string {
  if (!quota || quota.model !== model || !quota.accountId || quota.status !== 'ok' || !quota.focus?.entitled) {
    return t('usageBadgeModelUnavailable')
  }
  const buckets = quota.focus.group?.buckets.filter(bucket => !bucket.disabled)
    .sort((a, b) => Number(weekly(b)) - Number(weekly(a))) ?? []
  if (!buckets.length) return t('usageBadgeModelUnavailable')
  return [...buckets.slice(0, 2).map(bucket => quotaText(antigravityUsedPercent(bucket), mode, t)), quota.accountLabel || quota.accountId].join(' · ')
}

/** Keep the bridge's grouping and do not infer entitlement from display names. */
export function AntigravityQuotaSummary({ groups, t, mode }: {
  groups: readonly Group[]; t: Translate; mode: QuotaDisplayMode
}) {
  return <div style={{ display: 'grid', gap: 18, paddingTop: 8 }}>
    {groups.map((group, index) => (
      <section key={index} aria-label={group.name}>
        <h4 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600 }}>{group.name}</h4>
        <div style={{ display: 'grid', gap: 10 }}>
          {[...group.buckets].sort((a, b) => Number(weekly(b)) - Number(weekly(a))).map(bucket => {
            const label = antigravityWindowLabel(bucket, t)
            const used = antigravityUsedPercent(bucket)
            const percent = quotaPercent(used, mode)
            const reset = Date.parse(bucket.resetTime)
            const color = usageBarColor(used)
            return <div key={bucket.id} style={{ display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
                <span>{label}</span>
                <span style={{ textAlign: 'right', color: bucket.disabled ? undefined : color }}>
                  {bucket.disabled ? t('antigravityQuotaInactive') : quotaText(used, mode, t)}
                  {!bucket.disabled && Number.isFinite(reset) && ` · ${reset <= Date.now() ? t('quotaExpiredWindow') : t('usageResets', { date: new Date(reset).toLocaleString() })}`}
                </span>
              </div>
              {!bucket.disabled && percent !== undefined && <div role="progressbar" aria-label={`${group.name} · ${label}`}
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
                style={{ height: 4, borderRadius: 2, overflow: 'hidden', background: 'var(--dsw-alias-border-l2)' }}>
                <div style={{ width: `${percent}%`, height: '100%', borderRadius: 2, background: color }} />
              </div>}
            </div>
          })}
        </div>
      </section>
    ))}
  </div>
}
