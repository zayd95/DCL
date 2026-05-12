import { db } from '../lib/firebase';
import {
  collection, collectionGroup, query, where, getDocs,
  orderBy, limit, doc, writeBatch, serverTimestamp,
} from 'firebase/firestore';
import { stockViewId } from '../lib/stockService';

// ─── Shared types ─────────────────────────────────────────────────────────────

export type CheckStatus = 'idle' | 'running' | 'pass' | 'warn' | 'fail';

export interface Issue {
  path: string;
  detail: string;
  severity: 'warn' | 'fail';
}

export interface CheckResult {
  id: string;
  name: string;
  description: string;
  status: CheckStatus;
  totalChecked: number;
  issueCount: number;
  issues: Issue[];
  durationMs?: number;
  repairFn?: () => Promise<void>;
  repairLabel?: string;
}

export type CheckRunResult = Omit<CheckResult, 'id' | 'name' | 'description'>;

export interface IntegrityCheckDef {
  id: string;
  name: string;
  description: string;
  run: () => Promise<CheckRunResult>;
}

export const SAMPLE_LIMIT = 250;

// ─── StockView consistency ────────────────────────────────────────────────────

type DriftedView = { depotId: string; sku: string; stored: number; computed: number };

async function _computeDriftedViews(sampleLimit = 50): Promise<{ drifted: DriftedView[]; issues: Issue[]; totalChecked: number }> {
  const viewsSnap = await getDocs(query(collection(db, 'stockView'), limit(sampleLimit)));
  const issues: Issue[] = [];
  const drifted: DriftedView[] = [];

  await Promise.all(viewsSnap.docs.map(async viewDoc => {
    const { sku, depotId, totalQuantity } = viewDoc.data() as { sku: string; depotId: string; totalQuantity: number };
    if (!sku || !depotId) return;
    const lotStockSnap = await getDocs(
      query(collection(db, 'depots', depotId, 'lotStock'), where('sku', '==', sku)),
    );
    const computed = lotStockSnap.docs.reduce((s, d) => s + (d.data().quantity ?? 0), 0);
    const drift = Math.abs((totalQuantity ?? 0) - computed);
    if (drift > 0) {
      issues.push({
        path: viewDoc.ref.path,
        detail: `totalQuantity stored=${totalQuantity ?? '?'} vs computed=${computed} (drift=${drift})`,
        severity: drift > 5 ? 'fail' : 'warn',
      });
      drifted.push({ depotId, sku, stored: totalQuantity ?? 0, computed });
    }
  }));

  return { drifted, issues, totalChecked: viewsSnap.size };
}

export async function checkStockViewConsistency(): Promise<CheckRunResult> {
  const t0 = Date.now();
  const { drifted, issues, totalChecked } = await _computeDriftedViews();
  const status: CheckStatus = issues.length === 0 ? 'pass'
    : issues.some(i => i.severity === 'fail') ? 'fail' : 'warn';

  return {
    status,
    totalChecked,
    issueCount: issues.length,
    issues,
    durationMs: Date.now() - t0,
    ...(drifted.length > 0 ? {
      repairLabel: 'Synchroniser compteurs',
      repairFn: () => repairStockView(drifted),
    } : {}),
  };
}

export async function repairStockView(driftedViews: DriftedView[]): Promise<void> {
  const batch = writeBatch(db);
  await Promise.all(driftedViews.map(async ({ depotId, sku }) => {
    const snap = await getDocs(
      query(collection(db, 'depots', depotId, 'lotStock'), where('sku', '==', sku)),
    );
    let totalQty = 0;
    let totalKg  = 0;
    let totalXof = 0;
    let lotsCount = 0;
    snap.docs.forEach(d => {
      const data = d.data();
      const qty = data.quantity ?? 0;
      totalQty  += qty;
      totalXof  += qty * (data.costPriceUnitXof ?? 0);
      totalKg   += qty * (data.unitWeight ?? 1);
      if (data.isActive) lotsCount++;
    });
    batch.set(doc(db, 'stockView', stockViewId(depotId, sku)), {
      sku, depotId,
      totalQuantity: totalQty,
      totalWeightKg: totalKg,
      totalValueXof: totalXof,
      lotsCount,
      lastUpdated: serverTimestamp(),
    }, { merge: true });
  }));
  await batch.commit();
}

// ─── Lot integrity ────────────────────────────────────────────────────────────

export async function checkLotIntegrity(): Promise<CheckRunResult> {
  const t0 = Date.now();
  const snap = await getDocs(query(collectionGroup(db, 'lotStock'), limit(SAMPLE_LIMIT)));
  const issues: Issue[] = [];
  await Promise.all(snap.docs.map(async d => {
    const { lotId } = d.data();
    if (!lotId) {
      issues.push({ path: d.ref.path, detail: 'Missing lotId field on lotStock doc', severity: 'fail' });
      return;
    }
    const lotSnap = await getDocs(query(collection(db, 'lots'), where('lotId', '==', lotId), limit(1)));
    if (lotSnap.empty) {
      issues.push({ path: d.ref.path, detail: `Parent /lots/${lotId} not found`, severity: 'fail' });
    }
  }));
  return {
    status: issues.length === 0 ? 'pass' : 'fail',
    totalChecked: snap.size,
    issueCount: issues.length,
    issues,
    durationMs: Date.now() - t0,
  };
}

// ─── Orphan movements ────────────────────────────────────────────────────────

export async function findOrphanMovements(): Promise<CheckRunResult> {
  const t0 = Date.now();
  const snap = await getDocs(
    query(collection(db, 'movements'), orderBy('createdAt', 'desc'), limit(SAMPLE_LIMIT)),
  );
  const issues: Issue[] = [];
  snap.docs.forEach(d => {
    const data = d.data();
    if (!data.lotId || data.lotId === '') {
      issues.push({ path: `movements/${d.id}`, detail: 'Missing lotId', severity: 'warn' });
    }
    if (!data.sku || data.sku === '') {
      issues.push({ path: `movements/${d.id}`, detail: 'Missing sku', severity: 'warn' });
    }
    if (data.quantity === undefined || data.quantity < 0) {
      issues.push({ path: `movements/${d.id}`, detail: `Invalid quantity: ${data.quantity}`, severity: 'fail' });
    }
  });
  return {
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'fail') ? 'fail' : 'warn',
    totalChecked: snap.size,
    issueCount: issues.length,
    issues,
    durationMs: Date.now() - t0,
  };
}

// ─── Additional checks ────────────────────────────────────────────────────────

async function checkLegacyMigration(): Promise<CheckRunResult> {
  const t0 = Date.now();
  const snap = await getDocs(query(collectionGroup(db, 'stock'), limit(SAMPLE_LIMIT)));
  const issues: Issue[] = [];
  snap.docs.forEach(d => {
    if (!d.data().lotId) {
      issues.push({ path: d.ref.path, detail: 'Missing lotId — pre-Phase-0 doc', severity: 'warn' });
    }
  });
  return {
    status: issues.length === 0 ? 'pass' : 'warn',
    totalChecked: snap.size,
    issueCount: issues.length,
    issues,
    durationMs: Date.now() - t0,
  };
}

async function checkNegativeQuantities(): Promise<CheckRunResult> {
  const t0 = Date.now();
  const issues: Issue[] = [];

  const lotStockSnap = await getDocs(query(collectionGroup(db, 'lotStock'), limit(SAMPLE_LIMIT)));
  lotStockSnap.docs.forEach(d => {
    if ((d.data().quantity ?? 0) < 0) {
      issues.push({ path: d.ref.path, detail: `quantity=${d.data().quantity}`, severity: 'fail' });
    }
  });

  const stockSnap = await getDocs(query(collectionGroup(db, 'stock'), limit(SAMPLE_LIMIT)));
  stockSnap.docs.forEach(d => {
    const qty = d.data().quantity ?? d.data().cartons ?? d.data().units ?? 0;
    if (qty < 0) {
      issues.push({ path: d.ref.path, detail: `quantity=${qty}`, severity: 'fail' });
    }
  });

  return {
    status: issues.length === 0 ? 'pass' : 'fail',
    totalChecked: lotStockSnap.size + stockSnap.size,
    issueCount: issues.length,
    issues,
    durationMs: Date.now() - t0,
  };
}

async function checkGuardOrphans(): Promise<CheckRunResult> {
  const t0 = Date.now();
  const snap = await getDocs(query(collection(db, 'lotGuards'), limit(SAMPLE_LIMIT)));
  const issues: Issue[] = [];
  await Promise.all(snap.docs.map(async d => {
    const { lotId } = d.data();
    if (!lotId) {
      issues.push({ path: `lotGuards/${d.id}`, detail: 'Missing lotId on guard', severity: 'fail' });
      return;
    }
    const lotSnap = await getDocs(query(collection(db, 'lots'), where('lotId', '==', lotId), limit(1)));
    if (lotSnap.empty) {
      issues.push({ path: `lotGuards/${d.id}`, detail: `Referenced /lots/${lotId} does not exist`, severity: 'fail' });
    }
  }));
  return {
    status: issues.length === 0 ? 'pass' : 'fail',
    totalChecked: snap.size,
    issueCount: issues.length,
    issues,
    durationMs: Date.now() - t0,
  };
}

async function checkExpiredActiveLots(): Promise<CheckRunResult> {
  const t0 = Date.now();
  const snap = await getDocs(
    query(collectionGroup(db, 'lotStock'), where('isActive', '==', true), limit(SAMPLE_LIMIT)),
  );
  const today = new Date().toISOString().split('T')[0];
  const issues: Issue[] = [];
  snap.docs.forEach(d => {
    const key = d.data().expirationSortKey as string | undefined;
    if (key && key !== '9999-12-31' && key < today) {
      issues.push({
        path: d.ref.path,
        detail: `Lot expired ${key} — still isActive=true (qty=${d.data().quantity}). FEFO violation.`,
        severity: 'fail',
      });
    }
  });
  return {
    status: issues.length === 0 ? 'pass' : 'fail',
    totalChecked: snap.size,
    issueCount: issues.length,
    issues,
    durationMs: Date.now() - t0,
  };
}

// ─── Migration validation checks ─────────────────────────────────────────────

export interface MigrationReport {
  generatedAt: string;
  schemaVersion: 'phase-0';
  readyToActivate: boolean;
  summary: {
    totalChecks: number;
    passed: number;
    warnings: number;
    failures: number;
  };
  checks: Array<{
    id: string;
    name: string;
    status: CheckStatus;
    issueCount: number;
    durationMs?: number;
  }>;
  activationBlockers: string[];
  recommendation: string;
}

async function checkStockViewCoverage(): Promise<CheckRunResult> {
  const t0 = Date.now();
  const snap = await getDocs(query(collectionGroup(db, 'stock'), limit(SAMPLE_LIMIT)));
  const issues: Issue[] = [];

  // Build unique (depotId, sku) pairs that have positive quantity
  const pairs = new Map<string, { depotId: string; sku: string; qty: number }>();
  let noSkuCount = 0;

  snap.docs.forEach(d => {
    const data = d.data();
    const depotId: string = data.depotId || data.depot_id || '';
    const sku: string = data.sku || '';
    const qty: number = data.quantity ?? data.cartons ?? data.units ?? 0;

    if (!sku) { noSkuCount++; return; }
    if (!depotId) return;

    const key = stockViewId(depotId, sku);
    const prev = pairs.get(key);
    pairs.set(key, { depotId, sku, qty: (prev?.qty ?? 0) + qty });
  });

  // For each active pair, verify a /stockView document exists
  await Promise.all([...pairs.entries()].map(async ([svId, { depotId, sku, qty }]) => {
    if (qty <= 0) return;
    const svSnap = await getDocs(
      query(collection(db, 'stockView'), where('depotId', '==', depotId), where('sku', '==', sku), limit(1)),
    );
    if (svSnap.empty) {
      issues.push({
        path: `stockView/${svId}`,
        detail: `No /stockView doc for depot=${depotId} sku=${sku} (legacy qty=${qty})`,
        severity: 'fail',
      });
    }
  }));

  if (noSkuCount > 0) {
    issues.push({
      path: 'legacy/stock',
      detail: `${noSkuCount} stock docs have no sku — cannot be projected to stockView`,
      severity: 'warn',
    });
  }

  return {
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'fail') ? 'fail' : 'warn',
    totalChecked: pairs.size,
    issueCount: issues.length,
    issues,
    durationMs: Date.now() - t0,
  };
}

async function compareSchemas(): Promise<CheckRunResult> {
  const t0 = Date.now();
  const viewsSnap = await getDocs(query(collection(db, 'stockView'), limit(50)));
  const issues: Issue[] = [];

  await Promise.all(viewsSnap.docs.map(async viewDoc => {
    const sv = viewDoc.data() as { sku: string; depotId: string; totalQuantity: number; totalValueXof: number };
    const { sku, depotId, totalQuantity: svQty, totalValueXof: svValue } = sv;
    if (!sku || !depotId) return;

    // Sum legacy stock for same (depot, sku)
    const legacySnap = await getDocs(
      query(collectionGroup(db, 'stock'), where('depotId', '==', depotId), where('sku', '==', sku)),
    );
    const legacyQty   = legacySnap.docs.reduce((s, d) => s + (d.data().quantity ?? d.data().cartons ?? 0), 0);
    const legacyValue = legacySnap.docs.reduce((s, d) => s + (d.data().costBasis ?? d.data().cost_basis ?? 0), 0);

    const qtyDrift   = Math.abs((svQty ?? 0) - legacyQty);
    const valueDrift = Math.abs((svValue ?? 0) - legacyValue);

    if (qtyDrift > 0) {
      issues.push({
        path: viewDoc.ref.path,
        detail: `Qty parity: stockView=${svQty} legacy=${legacyQty} drift=${qtyDrift}`,
        severity: qtyDrift > 5 ? 'fail' : 'warn',
      });
    }
    if (valueDrift > 500) {
      issues.push({
        path: viewDoc.ref.path,
        detail: `Value XOF parity: stockView=${svValue} legacy=${legacyValue} drift=${valueDrift}`,
        severity: 'warn',
      });
    }
  }));

  return {
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'fail') ? 'fail' : 'warn',
    totalChecked: viewsSnap.size,
    issueCount: issues.length,
    issues,
    durationMs: Date.now() - t0,
  };
}

async function checkMovementCompleteness(): Promise<CheckRunResult> {
  const t0 = Date.now();
  const snap = await getDocs(
    query(collection(db, 'movements'), orderBy('createdAt', 'desc'), limit(SAMPLE_LIMIT)),
  );
  const issues: Issue[] = [];
  snap.docs.forEach(d => {
    const data = d.data();
    const missing: string[] = [];
    if (!data.type)                 missing.push('type');
    if (!data.sku)                  missing.push('sku');
    if (!data.lotId)                missing.push('lotId');
    if (data.quantity === undefined) missing.push('quantity');
    if (!data.depotId)              missing.push('depotId');
    if (missing.length > 0) {
      issues.push({
        path: `movements/${d.id}`,
        detail: `Missing required fields: ${missing.join(', ')}`,
        severity: missing.includes('quantity') || missing.includes('type') ? 'fail' : 'warn',
      });
    }
  });
  return {
    status: issues.length === 0 ? 'pass' : issues.some(i => i.severity === 'fail') ? 'fail' : 'warn',
    totalChecked: snap.size,
    issueCount: issues.length,
    issues,
    durationMs: Date.now() - t0,
  };
}

// ─── Migration report orchestrator ───────────────────────────────────────────

const MIGRATION_ONLY_CHECKS: IntegrityCheckDef[] = [
  {
    id: 'stockview_coverage',
    name: 'Couverture StockView',
    description: 'Vérifie que chaque (dépôt, SKU) actif a un document /stockView correspondant',
    run: checkStockViewCoverage,
  },
  {
    id: 'schema_parity',
    name: 'Parité schémas',
    description: 'Quantités et valeurs identiques entre legacy /stock et /stockView par (dépôt, SKU)',
    run: compareSchemas,
  },
  {
    id: 'movement_completeness',
    name: 'Complétude mouvements',
    description: `Derniers ${SAMPLE_LIMIT} mouvements — tous les champs obligatoires présents`,
    run: checkMovementCompleteness,
  },
];

export async function generateMigrationReport(): Promise<MigrationReport> {
  const allChecks = [...MIGRATION_ONLY_CHECKS, ...INTEGRITY_CHECKS];
  const results: CheckResult[] = [];

  for (const check of allChecks) {
    try {
      const raw = await check.run();
      results.push({ id: check.id, name: check.name, description: check.description, ...raw });
    } catch (err: any) {
      results.push({
        id: check.id, name: check.name, description: check.description,
        status: 'fail', totalChecked: 0, issueCount: 1,
        issues: [{ path: 'runner', detail: err?.message ?? 'Erreur interne', severity: 'fail' }],
      });
    }
  }

  const passed   = results.filter(r => r.status === 'pass').length;
  const warnings = results.filter(r => r.status === 'warn').length;
  const failures = results.filter(r => r.status === 'fail').length;
  const blockers = results
    .filter(r => r.status === 'fail')
    .map(r => `${r.name}: ${r.issueCount} problème(s)`);
  const readyToActivate = failures === 0;

  return {
    generatedAt: new Date().toISOString(),
    schemaVersion: 'phase-0',
    readyToActivate,
    summary: { totalChecks: results.length, passed, warnings, failures },
    checks: results.map(r => ({
      id: r.id, name: r.name, status: r.status,
      issueCount: r.issueCount, durationMs: r.durationMs,
    })),
    activationBlockers: blockers,
    recommendation: readyToActivate
      ? 'Toutes les vérifications passées. Vous pouvez définir VITE_USE_STOCKVIEW_READS=true dans .env.local.'
      : `${failures} échec(s) à corriger avant activation. Utilisez les actions de réparation dans la console.`,
  };
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const INTEGRITY_CHECKS: IntegrityCheckDef[] = [
  {
    id: 'legacy_migration',
    name: 'Migration Phase 0',
    description: 'Legacy /stock docs without lotId forward-reference (pre-Phase-0)',
    run: checkLegacyMigration,
  },
  {
    id: 'lotstock_orphans',
    name: 'LotStock sans parent',
    description: 'Entrées /lotStock dont le document /lots parent est introuvable',
    run: checkLotIntegrity,
  },
  {
    id: 'counter_drift',
    name: 'Dérive compteurs StockView',
    description: 'Écart entre /stockView.totalQuantity et SUM(/lotStock.quantity)',
    run: checkStockViewConsistency,
  },
  {
    id: 'movement_integrity',
    name: 'Intégrité mouvements',
    description: `Derniers ${SAMPLE_LIMIT} mouvements sans lotId ou sku (trail incomplet)`,
    run: findOrphanMovements,
  },
  {
    id: 'negative_quantities',
    name: 'Quantités négatives',
    description: 'Docs lotStock ou stock avec quantity < 0 (corruption transactionnelle)',
    run: checkNegativeQuantities,
  },
  {
    id: 'guard_orphans',
    name: 'Guards orphelins',
    description: '/lotGuards pointant vers un /lots inexistant (référence cassée)',
    run: checkGuardOrphans,
  },
  {
    id: 'fefo_expired_active',
    name: 'Lots expirés actifs',
    description: 'Lots passé leur DLC mais toujours isActive=true (violation FEFO)',
    run: checkExpiredActiveLots,
  },
  // ─── Phase 1 activation gate ───────────────────────────────────────────────
  {
    id: 'stockview_coverage',
    name: 'Couverture StockView',
    description: 'Chaque (dépôt, SKU) actif a un document /stockView — requis pour Phase 1',
    run: checkStockViewCoverage,
  },
  {
    id: 'schema_parity',
    name: 'Parité schémas',
    description: 'Quantités et valeurs identiques entre legacy /stock et /stockView',
    run: compareSchemas,
  },
  {
    id: 'movement_completeness',
    name: 'Complétude mouvements',
    description: `Derniers ${SAMPLE_LIMIT} mouvements avec tous les champs obligatoires`,
    run: checkMovementCompleteness,
  },
];
