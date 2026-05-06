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
];
