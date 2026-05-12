
import React, { useState, useCallback } from 'react';
import {
  ChevronLeft, Shield, Play, CheckCircle2, AlertTriangle, XCircle,
  RefreshCw, Download, Clock, Database, RotateCcw, ChevronDown,
  ChevronRight, Zap, Activity,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/utils';
import {
  INTEGRITY_CHECKS, SAMPLE_LIMIT, generateMigrationReport,
  type CheckStatus, type CheckResult, type MigrationReport,
} from '../services/integrityService';
import { FileCheck } from 'lucide-react';

// ─── Status display config ────────────────────────────────────────────────────

const STATUS_CONFIG: Record<CheckStatus, {
  icon: React.ReactNode;
  label: string;
  color: string;
  bg: string;
  border: string;
}> = {
  idle:    { icon: <Clock size={14} />,        label: 'En attente', color: 'text-zinc-400',    bg: 'bg-zinc-800',       border: 'border-zinc-700'   },
  running: { icon: <RefreshCw size={14} className="animate-spin" />, label: 'En cours...', color: 'text-blue-400',  bg: 'bg-blue-900/30',    border: 'border-blue-700'   },
  pass:    { icon: <CheckCircle2 size={14} />, label: 'OK',         color: 'text-emerald-400', bg: 'bg-emerald-900/30', border: 'border-emerald-700' },
  warn:    { icon: <AlertTriangle size={14} />, label: 'Attention', color: 'text-amber-400',   bg: 'bg-amber-900/30',   border: 'border-amber-700'  },
  fail:    { icon: <XCircle size={14} />,      label: 'Échec',     color: 'text-red-400',     bg: 'bg-red-900/30',     border: 'border-red-700'    },
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  onBack: () => void;
}

export const SystemIntegrityConsole = ({ onBack }: Props) => {
  const [results, setResults]         = useState<CheckResult[]>([]);
  const [running, setRunning]         = useState(false);
  const [expanded, setExpanded]       = useState<Set<string>>(new Set());
  const [repairing, setRepairing]     = useState<string | null>(null);
  const [lastRun, setLastRun]         = useState<Date | null>(null);
  const [migReport, setMigReport]     = useState<MigrationReport | null>(null);
  const [migRunning, setMigRunning]   = useState(false);

  const runChecks = useCallback(async (ids?: string[]) => {
    setRunning(true);
    const toRun = ids
      ? INTEGRITY_CHECKS.filter(c => ids.includes(c.id))
      : INTEGRITY_CHECKS;

    setResults(prev => {
      const map = new Map(prev.map(r => [r.id, r]));
      toRun.forEach(c => map.set(c.id, {
        ...(map.get(c.id) ?? { issues: [], totalChecked: 0, issueCount: 0 }),
        id: c.id, name: c.name, description: c.description,
        status: 'running' as CheckStatus,
      }));
      INTEGRITY_CHECKS.forEach(c => {
        if (!map.has(c.id)) map.set(c.id, {
          id: c.id, name: c.name, description: c.description,
          status: 'idle', totalChecked: 0, issueCount: 0, issues: [],
        });
      });
      return INTEGRITY_CHECKS.map(c => map.get(c.id)!);
    });

    for (const check of toRun) {
      try {
        const raw = await check.run();
        setResults(prev => prev.map(r => r.id === check.id
          ? { id: check.id, name: check.name, description: check.description, ...raw }
          : r,
        ));
      } catch (err: any) {
        setResults(prev => prev.map(r => r.id === check.id ? {
          ...r, status: 'fail' as CheckStatus,
          issues: [{ path: 'runner', detail: err?.message ?? 'Erreur interne', severity: 'fail' as const }],
          issueCount: 1,
        } : r));
      }
    }

    setRunning(false);
    setLastRun(new Date());
  }, []);

  const handleRepair = async (check: CheckResult) => {
    if (!check.repairFn) return;
    setRepairing(check.id);
    try {
      await check.repairFn();
      await runChecks([check.id]);
    } finally {
      setRepairing(null);
    }
  };

  const exportReport = () => {
    const report = {
      generatedAt: new Date().toISOString(),
      lastRun: lastRun?.toISOString() ?? null,
      summary: {
        total:    results.length,
        passed:   results.filter(r => r.status === 'pass').length,
        warnings: results.filter(r => r.status === 'warn').length,
        failures: results.filter(r => r.status === 'fail').length,
      },
      checks: results.map(r => ({ ...r, repairFn: undefined })),
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `depotek-integrity-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runMigrationValidation = async () => {
    setMigRunning(true);
    setMigReport(null);
    try {
      const report = await generateMigrationReport();
      setMigReport(report);
      // Also export automatically
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `depotek-migration-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setMigRunning(false);
    }
  };

  const toggleExpand = (id: string) =>
    setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const passed   = results.filter(r => r.status === 'pass').length;
  const warnings = results.filter(r => r.status === 'warn').length;
  const failures = results.filter(r => r.status === 'fail').length;
  const hasRun   = results.length > 0;

  const overallStatus: CheckStatus = !hasRun ? 'idle'
    : failures > 0 ? 'fail'
    : warnings > 0 ? 'warn'
    : 'pass';

  const displayList: CheckResult[] = hasRun || running
    ? (results.length > 0 ? results : INTEGRITY_CHECKS.map(c => ({
        id: c.id, name: c.name, description: c.description,
        status: 'running' as CheckStatus, totalChecked: 0, issueCount: 0, issues: [],
      })))
    : [];

  return (
    <div className="h-screen bg-zinc-950 flex flex-col font-mono overflow-hidden max-w-[480px] mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="bg-zinc-900 border-b border-zinc-800 p-5 flex-shrink-0">
        <div className="flex items-center justify-between mb-4">
          <button onClick={onBack} className="p-2 bg-zinc-800 rounded-xl text-zinc-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <div className="flex items-center gap-2">
            <div className={cn(
              "w-2 h-2 rounded-full",
              overallStatus === 'pass' ? "bg-emerald-400 animate-pulse" :
              overallStatus === 'fail' ? "bg-red-400 animate-pulse" :
              overallStatus === 'warn' ? "bg-amber-400 animate-pulse" :
              "bg-zinc-600"
            )} />
            <span className="text-zinc-500 text-[10px] tracking-widest uppercase">DEPOTEK</span>
            <span className="text-zinc-700 text-[10px]">/</span>
            <span className="text-zinc-300 text-[10px] tracking-widest uppercase">Integrity Console</span>
          </div>
          <button
            onClick={exportReport}
            disabled={!hasRun}
            className="p-2 bg-zinc-800 rounded-xl text-zinc-400 hover:text-white transition-colors disabled:opacity-30"
          >
            <Download size={18} />
          </button>
        </div>

        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-zinc-800 rounded-2xl flex items-center justify-center">
            <Shield size={20} className={cn(
              overallStatus === 'pass' ? "text-emerald-400" :
              overallStatus === 'fail' ? "text-red-400" :
              overallStatus === 'warn' ? "text-amber-400" : "text-zinc-500"
            )} />
          </div>
          <div className="flex-1">
            <h1 className="text-white text-sm font-bold tracking-widest uppercase">System Integrity</h1>
            <p className="text-zinc-500 text-[10px] tracking-widest mt-0.5">
              {lastRun
                ? `Dernière vérification: ${lastRun.toLocaleTimeString('fr-SN')}`
                : 'Aucune vérification effectuée'}
            </p>
          </div>
          <button
            onClick={() => runChecks()}
            disabled={running}
            className={cn(
              "px-4 py-2 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all flex items-center gap-2",
              running
                ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                : "bg-emerald-600 text-white hover:bg-emerald-500 active:scale-95"
            )}
          >
            {running
              ? <><RefreshCw size={12} className="animate-spin" /> Analyse...</>
              : <><Play size={12} /> Lancer</>
            }
          </button>
        </div>
      </header>

      {/* ── Summary bar ────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {hasRun && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="flex-shrink-0 border-b border-zinc-800 overflow-hidden"
          >
            <div className="grid grid-cols-3 divide-x divide-zinc-800">
              <div className="px-4 py-3 text-center">
                <p className="text-emerald-400 text-lg font-bold">{passed}</p>
                <p className="text-zinc-500 text-[9px] tracking-widest uppercase mt-0.5">Passés</p>
              </div>
              <div className="px-4 py-3 text-center">
                <p className="text-amber-400 text-lg font-bold">{warnings}</p>
                <p className="text-zinc-500 text-[9px] tracking-widest uppercase mt-0.5">Alertes</p>
              </div>
              <div className="px-4 py-3 text-center">
                <p className="text-red-400 text-lg font-bold">{failures}</p>
                <p className="text-zinc-500 text-[9px] tracking-widest uppercase mt-0.5">Échecs</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Check list ─────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2 pb-8">

        {!hasRun && !running && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
            <div className="w-16 h-16 bg-zinc-900 rounded-3xl flex items-center justify-center">
              <Activity size={28} className="text-zinc-600" />
            </div>
            <div>
              <p className="text-zinc-400 text-sm font-bold tracking-wide">Console prête</p>
              <p className="text-zinc-600 text-xs mt-1">
                Appuyez sur Lancer pour vérifier l'intégrité<br />du schéma de données DEPOTEK
              </p>
            </div>
            <div className="text-zinc-700 text-[10px] font-mono leading-relaxed text-left bg-zinc-900 rounded-xl p-4 w-full">
              <p className="text-zinc-500 mb-2"># {INTEGRITY_CHECKS.length} vérifications programmées</p>
              {INTEGRITY_CHECKS.map(c => (
                <p key={c.id} className="text-zinc-600">→ {c.name}</p>
              ))}
            </div>
          </div>
        )}

        {displayList.map((check, idx) => {
          const cfg      = STATUS_CONFIG[check.status];
          const isOpen   = expanded.has(check.id);
          const hasIssues = check.issueCount > 0;

          return (
            <motion.div
              key={check.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.04 }}
              className={cn("rounded-2xl border overflow-hidden", cfg.bg, cfg.border)}
            >
              {/* Row header */}
              <div
                className={cn("flex items-center gap-3 p-4 cursor-pointer select-none", hasIssues && "hover:bg-white/5")}
                onClick={() => hasIssues && toggleExpand(check.id)}
              >
                <div className={cn("flex-shrink-0", cfg.color)}>{cfg.icon}</div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-200 text-xs font-bold tracking-wide truncate">{check.name}</span>
                    {check.durationMs !== undefined && (
                      <span className="text-zinc-600 text-[9px] font-mono flex-shrink-0">{check.durationMs}ms</span>
                    )}
                  </div>
                  <p className="text-zinc-500 text-[10px] mt-0.5 leading-tight truncate">{check.description}</p>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {check.totalChecked > 0 && (
                    <span className="text-zinc-600 text-[9px] font-mono">{check.totalChecked} docs</span>
                  )}
                  {hasIssues && (
                    <span className={cn(
                      "text-[10px] font-bold px-2 py-0.5 rounded-full",
                      check.status === 'fail' ? "bg-red-900 text-red-300" : "bg-amber-900 text-amber-300",
                    )}>
                      {check.issueCount}
                    </span>
                  )}
                  {hasIssues
                    ? (isOpen ? <ChevronDown size={14} className="text-zinc-500" /> : <ChevronRight size={14} className="text-zinc-500" />)
                    : <span className="w-[14px]" />
                  }
                </div>
              </div>

              {/* Expanded issues */}
              <AnimatePresence>
                {isOpen && hasIssues && (
                  <motion.div
                    initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="border-t border-zinc-800 px-4 pb-4 pt-3 space-y-1.5 max-h-48 overflow-y-auto">
                      {check.issues.slice(0, 20).map((issue, i) => (
                        <div key={i} className="flex gap-2 items-start">
                          <span className={cn(
                            "text-[9px] mt-0.5 flex-shrink-0",
                            issue.severity === 'fail' ? "text-red-500" : "text-amber-500",
                          )}>
                            {issue.severity === 'fail' ? '✗' : '⚠'}
                          </span>
                          <div className="min-w-0">
                            <p className="text-zinc-400 text-[10px] font-mono break-all leading-tight">{issue.path}</p>
                            <p className="text-zinc-600 text-[10px] leading-tight mt-0.5">{issue.detail}</p>
                          </div>
                        </div>
                      ))}
                      {check.issues.length > 20 && (
                        <p className="text-zinc-600 text-[10px] text-center pt-1">
                          + {check.issues.length - 20} autres problèmes
                        </p>
                      )}
                    </div>

                    {/* Repair action */}
                    {(check.repairFn || check.repairLabel) && (
                      <div className="border-t border-zinc-800 px-4 py-3 flex items-center justify-between gap-3">
                        <p className="text-zinc-500 text-[10px]">Réparation automatique disponible</p>
                        <button
                          onClick={() => handleRepair(check)}
                          disabled={repairing === check.id}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-colors disabled:opacity-50"
                        >
                          {repairing === check.id
                            ? <><RefreshCw size={10} className="animate-spin" /> Réparation...</>
                            : <><Zap size={10} /> {check.repairLabel ?? 'Réparer'}</>
                          }
                        </button>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Re-run single check */}
              {check.status !== 'running' && check.status !== 'idle' && (
                <div className="px-4 pb-3 flex justify-end">
                  <button
                    onClick={e => { e.stopPropagation(); runChecks([check.id]); }}
                    disabled={running}
                    className="text-zinc-600 hover:text-zinc-400 text-[9px] font-mono flex items-center gap-1 transition-colors disabled:opacity-30"
                  >
                    <RotateCcw size={9} /> re-run
                  </button>
                </div>
              )}
            </motion.div>
          );
        })}
      </div>

      {/* ── Migration Validation Panel ─────────────────────────────────────── */}
      <AnimatePresence>
        {migReport && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="flex-shrink-0 border-t border-zinc-800 overflow-hidden"
          >
            <div className={cn(
              "px-5 py-4 space-y-2",
              migReport.readyToActivate ? "bg-emerald-950/40" : "bg-red-950/40",
            )}>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
                  Rapport de Migration Phase 1
                </span>
                <span className={cn(
                  "text-[10px] font-black px-2 py-0.5 rounded-full",
                  migReport.readyToActivate ? "bg-emerald-800 text-emerald-300" : "bg-red-900 text-red-300",
                )}>
                  {migReport.readyToActivate ? '✓ ACTIVABLE' : '✗ BLOQUÉ'}
                </span>
              </div>
              <p className="text-zinc-400 text-[10px] leading-relaxed">{migReport.recommendation}</p>
              {migReport.activationBlockers.length > 0 && (
                <ul className="space-y-0.5">
                  {migReport.activationBlockers.map((b, i) => (
                    <li key={i} className="text-red-400 text-[10px] font-mono">✗ {b}</li>
                  ))}
                </ul>
              )}
              <div className="grid grid-cols-3 gap-2 pt-1">
                {[
                  { label: 'Passés',  val: migReport.summary.passed,   color: 'text-emerald-400' },
                  { label: 'Alertes', val: migReport.summary.warnings,  color: 'text-amber-400'   },
                  { label: 'Échecs',  val: migReport.summary.failures,  color: 'text-red-400'     },
                ].map(s => (
                  <div key={s.label} className="text-center">
                    <p className={cn("text-sm font-bold", s.color)}>{s.val}</p>
                    <p className="text-zinc-600 text-[9px] uppercase tracking-widest">{s.label}</p>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-t border-zinc-800 px-5 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-zinc-600 min-w-0">
          <Database size={12} className="flex-shrink-0" />
          <span className="text-[10px] font-mono truncate">
            Firestore · max {SAMPLE_LIMIT} docs / collection
          </span>
        </div>
        <button
          onClick={runMigrationValidation}
          disabled={migRunning}
          className={cn(
            "flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors",
            migRunning
              ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
              : "bg-zinc-700 hover:bg-zinc-600 text-zinc-200"
          )}
        >
          {migRunning
            ? <><RefreshCw size={10} className="animate-spin" /> Validation...</>
            : <><FileCheck size={10} /> Valider Migration</>
          }
        </button>
      </div>
    </div>
  );
};
