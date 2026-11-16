import React from 'react';
import { cx as cn } from './cx';

export const fcfa = (n: number | string | null | undefined) =>
  Math.round(Number(n ?? 0)).toLocaleString('fr-FR').replace(/[\u202f\u00a0]/g, ' ') + ' FCFA';

export const qty = (n: number | string | null | undefined) =>
  Number(n ?? 0).toLocaleString('fr-FR', { maximumFractionDigits: 2 }).replace(/[\u202f\u00a0]/g, ' ');

export const shortDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) : '—';

export function Screen({ title, subtitle, right, children }: {
  title: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto pb-28">
      <header className="sticky top-0 z-10 bg-surface-page/90 backdrop-blur px-5 pt-6 pb-3 flex items-end justify-between">
        <div>
          <h1 className="text-title font-black text-brand-ink uppercase tracking-tight">{title}</h1>
          {subtitle && <p className="text-caption text-text-secondary mt-0.5">{subtitle}</p>}
        </div>
        {right}
      </header>
      <div className="px-4 space-y-3">{children}</div>
    </div>
  );
}

export function Card({ className, children, onClick }: { className?: string; children: React.ReactNode; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick}
      className={cn('w-full text-left bg-surface-card border border-border-default rounded-2xl p-4', onClick && 'active:scale-[0.99] transition', className)}>
      {children}
    </Tag>
  );
}

export function Button({ variant = 'primary', className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
}) {
  return (
    <button {...p}
      className={cn('rounded-xl px-4 py-3 text-body font-bold transition active:scale-95 disabled:opacity-50',
        variant === 'primary' && 'bg-brand text-white',
        variant === 'ghost' && 'bg-surface-subtle text-text-primary',
        variant === 'danger' && 'bg-status-danger-bg text-status-danger',
        className)} />
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-label font-bold uppercase tracking-widest text-text-secondary">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

const inputCls = 'w-full rounded-xl border border-border-strong bg-surface-card px-3 py-3 text-body text-text-primary focus:outline-none focus:border-border-focus';

export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cn(inputCls, p.className)} />;

export function Select({ options, ...p }: React.SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[] }) {
  return (
    <select {...p} className={cn(inputCls, p.className)}>
      <option value="">—</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'danger' | 'info' | 'muted'; children: React.ReactNode }) {
  return (
    <span className={cn('inline-block rounded-full px-2 py-0.5 text-micro font-black uppercase tracking-wider',
      tone === 'ok' && 'bg-status-success-bg text-status-success',
      tone === 'warn' && 'bg-status-warning-bg text-status-warning',
      tone === 'danger' && 'bg-status-danger-bg text-status-danger',
      tone === 'info' && 'bg-status-info-bg text-status-info',
      tone === 'muted' && 'bg-surface-subtle text-text-secondary')}>
      {children}
    </span>
  );
}

export const fefoTone = (s?: string | null) =>
  s === 'EXPIRE' || s === 'CRITIQUE' ? 'danger' : s === 'ATTENTION' ? 'warn' : s === 'OK' ? 'ok' : 'muted';

export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[600] bg-black/40 flex items-end justify-center" onClick={onClose}>
      <div className="w-full max-w-[480px] max-h-[88vh] overflow-y-auto bg-surface-card rounded-t-3xl p-5 pb-10 space-y-4"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-title font-black text-brand-ink">{title}</h2>
          <button onClick={onClose} className="text-text-muted text-body font-bold px-2">Fermer</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-center text-body text-text-muted py-10">{children}</p>;
}

export function ErrorNote({ error }: { error?: string | null }) {
  if (!error) return null;
  return <p className="rounded-xl bg-status-danger-bg text-status-danger text-body p-3">{error}</p>;
}
