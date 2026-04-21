
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Depot, StockItem, Mouvement, StockStatus, UserRole } from '../types';

interface AppStore {
  user: any | null;
  userRole: UserRole;
  depots: Depot[];
  selectedDepotId: string | null;
  stock: StockItem[];
  movements: Mouvement[];
  isGendarmerieMode: boolean;
  activeTab: 'stock' | 'track' | 'docs' | 'settings';
  isUploadModalOpen: boolean;
  isNewDepotModalOpen: boolean;
  isReceptionModalOpen: boolean;
  isEditModalOpen: boolean;
  isSplitModalOpen: boolean;
  isSortieModalOpen: boolean;
  selectedLot: StockItem | null;
  
  // Actions
  setUser: (user: any) => void;
  setUserRole: (role: UserRole) => void;
  setDepots: (depots: Depot[]) => void;
  setSelectedDepotId: (id: string | null) => void;
  setStock: (stock: StockItem[]) => void;
  setMovements: (movements: Mouvement[]) => void;
  toggleGendarmerieMode: () => void;
  setActiveTab: (tab: 'stock' | 'track' | 'docs' | 'settings') => void;
  setIsUploadModalOpen: (open: boolean) => void;
  setIsNewDepotModalOpen: (open: boolean) => void;
  setIsReceptionModalOpen: (open: boolean) => void;
  setIsEditModalOpen: (open: boolean) => void;
  setIsSplitModalOpen: (open: boolean) => void;
  setIsSortieModalOpen: (open: boolean) => void;
  setSelectedLot: (lot: StockItem | null) => void;
  
  // Computed (via logic in selectors or components)
  getSelectedDepot: () => Depot | undefined;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      user: null,
      userRole: 'magasinier',
      depots: [],
      selectedDepotId: null,
      stock: [],
      movements: [],
      isGendarmerieMode: false,
      activeTab: 'stock',
      isUploadModalOpen: false,
      isNewDepotModalOpen: false,
      isReceptionModalOpen: false,
      isEditModalOpen: false,
      isSplitModalOpen: false,
      isSortieModalOpen: false,
      selectedLot: null,

      setUser: (user) => set({ user }),
      setUserRole: (userRole) => set({ userRole }),
      setDepots: (depots) => set({ depots }),
      setSelectedDepotId: (id) => set({ selectedDepotId: id }),
      setStock: (stock) => set({ stock }),
      setMovements: (movements) => set({ movements }),
      toggleGendarmerieMode: () => set((state) => ({ isGendarmerieMode: !state.isGendarmerieMode })),
      setActiveTab: (activeTab) => set({ activeTab }),
      setIsUploadModalOpen: (isUploadModalOpen) => set({ isUploadModalOpen }),
      setIsNewDepotModalOpen: (isNewDepotModalOpen) => set({ isNewDepotModalOpen }),
      setIsReceptionModalOpen: (isReceptionModalOpen) => set({ isReceptionModalOpen }),
      setIsEditModalOpen: (isEditModalOpen) => set({ isEditModalOpen }),
      setIsSplitModalOpen: (isSplitModalOpen) => set({ isSplitModalOpen }),
      setIsSortieModalOpen: (isSortieModalOpen) => set({ isSortieModalOpen }),
      setSelectedLot: (selectedLot) => set({ selectedLot }),
      
      getSelectedDepot: () => {
        const { depots, selectedDepotId } = get();
        return depots.find(d => d.id === selectedDepotId);
      }
    }),
    {
      name: 'cl-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ 
        userRole: state.userRole,
        activeTab: state.activeTab,
        selectedDepotId: state.selectedDepotId 
      }), // On ne persiste que les settings, le stock vient de Firebase
    }
  )
);
