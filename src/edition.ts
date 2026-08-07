/**
 * Build-time edition marker.
 *
 * The default committed value is `'dev'` so local development sees the full
 * tool surface (community + pro + dev-tier tools). `scripts/build-ce.ts`
 * and `scripts/build-pro.ts` rewrite the exported constant to `'community'`
 * or `'pro'` respectively before transpiling so the produced bundle is
 * locked to a single edition with no runtime branching cost and never
 * exposes `'dev'`-tier (in-progress) tools to end-users.
 *
 * Runtime code (notably `src/core/server.ts`) gates Pro-only behavior on
 * `EDITION === 'pro'`; the tier filter in `src/core/tool-tiers.ts`
 * `isToolAllowedInEdition` reads this value to apply per-tier inclusion
 * rules; tests read this value to assert the expected build variant.
 *
 * Tier-vs-edition mapping for the registration gate:
 *   - dev edition       → every classified tool registers
 *   - community edition → only 'community'-tier tools register
 *   - pro edition       → 'community' + 'pro'-tier tools register
 *   - 'none'-tier tools never register in any edition (excluded everywhere)
 *
 * New tools default to 'dev' and promote to 'community' / 'pro' after
 * live verification.
 */
export const EDITION: 'dev' | 'community' | 'pro' = 'dev';
