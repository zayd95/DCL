
import React from 'react';
import { Box, PieChart as PieIcon, Ship, Building2 } from 'lucide-react';
import { cn } from '../lib/utils';

interface BottomNavProps {
  currentScreen: string;
  onNavigate: (screen: string) => void;
}

export const BottomNav: React.FC<BottomNavProps> = ({ currentScreen, onNavigate }) => {
  const tabs = [
    { id: 'inventaire', label: 'INVENTAIRE', icon: <Box size={24} /> },
    { id: 'centre',     label: 'CENTRE',     icon: <PieIcon size={24} /> },
    { id: 'entrees',    label: 'ENTRÉES',    icon: <Ship size={24} /> },
    { id: 'depots',     label: 'DÉPÔTS',     icon: <Building2 size={24} /> },
  ];

  return (
    <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] h-20 bg-surface-card/80 backdrop-blur-xl border-t border-border-default flex justify-around items-center px-4 pt-2 pb-6 z-[180] shadow-[0_-8px_30px_rgb(0,0,0,0.04)]">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onNavigate(tab.id)}
          className={cn(
            "flex flex-col items-center gap-1 transition-all relative group",
            currentScreen === tab.id ? "text-brand" : "text-text-muted hover:text-text-secondary"
          )}
        >
          {currentScreen === tab.id && (
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 w-8 h-1 bg-brand rounded-full" />
          )}
          <div className={cn(
            "p-1 transition-all duration-300",
            currentScreen === tab.id ? "scale-110 translate-y-[-2px]" : "group-active:scale-90"
          )}>
            {tab.icon}
          </div>
          <span className={cn(
            "text-micro font-black uppercase tracking-widest pt-0.5 transition-all",
            currentScreen === tab.id ? "opacity-100" : "opacity-60"
          )}>
            {tab.label}
          </span>
        </button>
      ))}
    </nav>
  );
};
