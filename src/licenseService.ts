import * as vscode from 'vscode';
import {
    type Feature,
    type FeatureTierMap,
    type License,
    type Tier,
    type Gate,
    DEFAULT_FEATURE_TIER,
    gate,
    resolveTier,
} from './entitlements.js';

/**
 * Host wrapper around the pure entitlements module. Reads the license from
 * <workspace>/.flow-debugger/license.json (absent = free) and answers gate
 * checks. The feature→tier map is injected from the license (absent = every
 * feature free). Cached; call refresh() after a license change.
 *
 * FLOW_UNLOCK_ALL=1 unlocks everything (self-host / dev / OSS build).
 */
export class LicenseService {
    private tier: Tier = 'free';
    private licensee: string | undefined;
    private featureTiers: FeatureTierMap = DEFAULT_FEATURE_TIER;
    private readonly unlockAll = process.env.FLOW_UNLOCK_ALL === '1';

    constructor(private workspaceRoot: string) {}

    async refresh(): Promise<void> {
        try {
            const uri = vscode.Uri.file(`${this.workspaceRoot}/.flow-debugger/license.json`);
            const bytes = await vscode.workspace.fs.readFile(uri);
            const lic = JSON.parse(Buffer.from(bytes).toString('utf8')) as License;
            this.tier = resolveTier(lic);
            this.licensee = lic.licensee;
            this.featureTiers = lic.featureTiers ?? DEFAULT_FEATURE_TIER;
        } catch {
            this.tier = 'free'; // no license file = free tier
            this.licensee = undefined;
            this.featureTiers = DEFAULT_FEATURE_TIER;
        }
    }

    currentTier(): Tier {
        return this.unlockAll ? 'enterprise' : this.tier;
    }

    check(feature: Feature): Gate {
        return gate(feature, this.tier, this.unlockAll, this.featureTiers);
    }

    /** Throwing helper for host paths that must hard-stop on a gated feature. */
    require(feature: Feature): Gate {
        const g = this.check(feature);
        return g;
    }

    info(): { tier: Tier; licensee?: string; unlockAll: boolean } {
        return { tier: this.currentTier(), licensee: this.licensee, unlockAll: this.unlockAll };
    }
}
