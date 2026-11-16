import React, { useState } from 'react';
import type { Profile } from '../supabase';
import { Inbox } from './Inbox';
import { Assistant } from './Assistant';
import { cx } from '../cx';
import { Settings as SettingsIcon } from 'lucide-react';

/** Accueil : le fil « À traiter » du moteur et l'Assistant, côte à côte. */
export function Home({ profile, initial, onCount, count, onOpenSettings }: {
  profile: Profile; initial: 'inbox' | 'chat'; onCount: (n: number) => void; count: number; onOpenSettings: () => void;
}) {
  const [view, setView] = useState<'inbox' | 'chat'>(initial);
  const seg = (v: 'inbox' | 'chat', label: React.ReactNode) => (
    <button onClick={() => setView(v)}
      className={cx('flex-1 rounded-xl py-2 text-body font-bold transition', view === v ? 'bg-surface-card text-brand shadow-sm' : 'text-text-secondary')}>
      {label}
    </button>
  );
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 pt-5 flex items-center gap-2">
        <div className="flex-1 flex gap-1 bg-surface-subtle rounded-2xl p-1">
          {seg('inbox', <>À traiter{count > 0 && <span className="ml-1 inline-block min-w-5 px-1.5 rounded-full bg-status-danger text-white text-caption">{count}</span>}</>)}
          {seg('chat', 'Assistant')}
        </div>
        <button onClick={onOpenSettings} aria-label="Réglages"
          className="w-11 h-11 rounded-2xl bg-surface-subtle text-text-secondary flex items-center justify-center shrink-0">
          <SettingsIcon size={20} />
        </button>
      </div>
      {/* Le fil reste monté pour garder le compteur à jour en temps réel */}
      <div className={cx('flex-1 overflow-y-auto px-4 pt-4 pb-28', view !== 'inbox' && 'hidden')}>
        <Inbox profile={profile} onCount={onCount} />
      </div>
      {view === 'chat' && <div className="flex-1 min-h-0"><Assistant profile={profile} openTasks={count} /></div>}
    </div>
  );
}
