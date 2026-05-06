/**
 * Feature flags — control progressive rollout of new data-layer reads.
 *
 * Set VITE_USE_STOCKVIEW_READS=true in .env.local to enable stockView reads
 * for Dashboard and Integrity Console while legacy reads remain in all other
 * screens. Full flip (Phase 3) removes this file and deletes legacy queries.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const viteEnv: Record<string, string> = (import.meta as any)?.env ?? {};

export const featureFlags = {
  /**
   * When true, Dashboard and IntegrityConsole read from /stockView instead of
   * /depots/{id}/stock. All mutation paths (applyMovement, applyTransfer,
   * Reception) already dual-write both schemas regardless of this flag.
   */
  USE_STOCKVIEW_READS: viteEnv['VITE_USE_STOCKVIEW_READS'] === 'true',
} as const;

export type FeatureFlag = keyof typeof featureFlags;
