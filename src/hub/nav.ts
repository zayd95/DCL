import { createContext, useContext } from 'react';

/** Navigation entre écrans : ouvre une opération pré-remplie (ex. « Réception ici » depuis une chambre). */
export type OpForm = 'vente' | 'reception' | 'encaissement' | 'transfert' | 'deplacer' | 'inventaire' | 'client' | 'location' | 'fin_location' | 'completer';
export interface PendingOp { form: OpForm; preset: Record<string, string>; n: number }
export type SettingsPanel = 'profile' | 'team' | 'depots' | 'rooms' | 'products' | 'clients' | 'notifications' | 'demo';
export const NavContext = createContext<{
  openOp: (form: OpForm, preset?: Record<string, string>) => void;
  openSettings: (panel?: SettingsPanel) => void;
}>({ openOp: () => undefined, openSettings: () => undefined });
export const useNav = () => useContext(NavContext);
