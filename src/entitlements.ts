/*
 * Entitlements — the feature-flag / tiering MECHANISM.
 *
 * This module is the public, open-source *switch*: it answers "is this feature
 * enabled for the active tier?" It deliberately does NOT contain the mapping of
 * which feature belongs to which tier. That mapping is configuration-as-data and
 * is injected at runtime (from the license, or an org config). With no injected
 * map, every feature resolves to the `free` tier, so the open-source build is
 * fully functional with zero payment infrastructure.
 *
 * Design rule: public code asks `isEnabled(feature, tier, map?)`; it never ships
 * the answer sheet. Pure + vscode-free so it stays unit-testable.
 */

export type Tier = 'free' | 'pro' | 'team' | 'enterprise';

export const TIER_RANK: Record<Tier, number> = {
    free: 0,
    pro: 1,
    team: 2,
    enterprise: 3,
};

/**
 * Every capability that may be gated. Add the capability here (so call sites can
 * reference a typed name), but DO NOT assign it a tier here — the tier is injected
 * at runtime via a FeatureTierMap. An unmapped feature defaults to `free`.
 */
export type Feature =
    | 'core.debug'            // breakpoints, pause, step, inspect
    | 'core.callMap'          // the Call Map view
    | 'auto.debug'            // auto_debug one-call investigation
    | 'mock.injection'        // dbMode mocked boundary injection
    | 'report.markdown'       // single-run report as markdown
    | 'report.html'           // styled HTML / PDF report
    | 'trace.persist'         // save/reopen a portable trace artifact
    | 'trace.compare'         // baseline vs candidate behavioral diff
    | 'contracts'             // runtime behavior contracts
    | 'experiments'           // causal runtime experiments
    | 'impact.select'         // change-impact scenario selection
    | 'ci.runner'             // headless CI verification runner
    | 'org.registry';         // org baselines / history / policy

/**
 * The tier a feature requires. Injected at runtime — NOT defined in public source.
 * Any feature absent from the active map resolves to `free`.
 */
export type FeatureTierMap = Partial<Record<Feature, Tier>>;

/**
 * Default map for the open-source / self-host build: empty, so everything is free.
 * A licensed build injects a real map (see LicenseService).
 */
export const DEFAULT_FEATURE_TIER: FeatureTierMap = {};

/** The tier a feature requires under the given map (absent = free). */
export function requiredTier(feature: Feature, map: FeatureTierMap = DEFAULT_FEATURE_TIER): Tier {
    return map[feature] ?? 'free';
}

export interface License {
    tier: Tier;
    /** who it's issued to (display only for now). */
    licensee?: string;
    /** ISO expiry; past = falls back to free. */
    expires?: string;
    /** optional injected feature→tier map; absent = everything free. */
    featureTiers?: FeatureTierMap;
    /** future: signature to verify the license wasn't hand-edited. */
    signature?: string;
}

/**
 * Resolve the active tier from a license object. Today: trust the file (dev/
 * self-host). LATER: verify `signature`, and/or call a licensing API — this is
 * the ONE function billing changes.
 */
export function resolveTier(license?: License | null, now: Date = new Date()): Tier {
    if (!license || !license.tier) return 'free';
    if (license.expires && Date.parse(license.expires) < now.getTime()) return 'free';
    return license.tier in TIER_RANK ? license.tier : 'free';
}

/** Is a feature available at the given tier under the given (injected) map? */
export function isEnabled(
    feature: Feature,
    tier: Tier,
    map: FeatureTierMap = DEFAULT_FEATURE_TIER,
): boolean {
    return TIER_RANK[tier] >= TIER_RANK[requiredTier(feature, map)];
}

/** A structured "you need to upgrade" result an agent or UI can act on. */
export interface Gate {
    allowed: boolean;
    feature: Feature;
    requiredTier: Tier;
    currentTier: Tier;
    /** override with FLOW_UNLOCK_ALL=1 (dev / self-host). */
    unlockedByEnv?: boolean;
    message?: string;
}

export function gate(
    feature: Feature,
    tier: Tier,
    envUnlockAll = false,
    map: FeatureTierMap = DEFAULT_FEATURE_TIER,
): Gate {
    const needed = requiredTier(feature, map);
    const allowed = envUnlockAll || TIER_RANK[tier] >= TIER_RANK[needed];
    return {
        allowed,
        feature,
        requiredTier: needed,
        currentTier: tier,
        unlockedByEnv: envUnlockAll || undefined,
        message: allowed
            ? undefined
            : `"${feature}" requires the ${needed} plan (current: ${tier}).`,
    };
}
