// Démo en direct : un scénario d'une journée joué avec les VRAIES fonctions métier.
// Chaque étape appelle le serveur ; le journal, les chambres, le fil « À traiter »
// et les notifications réagissent comme en production.
import { supabase, rpc } from './supabase';
import { fcfa, qty } from './ui';

export type DemoTab = 'accueil' | 'stock' | 'operations' | 'creances';
export interface DemoStep { title: string; tab: DemoTab; run: () => Promise<string> }

const blocked = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); return 'Non bloquée (inattendu).'; } catch (e) { return (e as Error).message.replace(/^VENTE BLOQUÉE — /, ''); }
};

export const DEMO_STEPS: DemoStep[] = [
  {
    title: 'Installation des données de démo', tab: 'operations',
    run: async () => {
      await rpc('demo_seed', {});
      return '2 entrepôts (Almadies, Sodida), 6 chambres froides, 5 produits, 6 clients et la journée d’hier. Regardez « Hier » dans le journal.';
    },
  },
  {
    title: 'Arrivée d’un conteneur', tab: 'operations',
    run: async () => {
      await rpc('receive_lot', {
        p_product: 'DEMO-CUISSE', p_qty: 800, p_lot_number: 'CP-LIVE', p_depot: 'ALM-DEMO',
        p_expiry_date: new Date(Date.now() + 240 * 864e5).toISOString().slice(0, 10),
        p_cost_unit: 11200, p_cost_currency: 'XOF', p_supplier: 'Fournisseur Brésil (démo)', p_container_no: 'HLXU9902777',
        p_storage_unit: 'CF2',
      });
      return '800 cartons de cuisse de poulet rangés dans le Frigo volaille. Coût figé, date d’expiration suivie.';
    },
  },
  {
    title: 'Vente à un grossiste', tab: 'operations',
    run: async () => {
      const r = await rpc<{ invoice_number: string; total_xof: number; picks: { lot_number: string; qty: number }[] }>('dispatch_fefo', {
        p_product: 'DEMO-CUISSE', p_qty: 60, p_client: 'Moussa Traders (démo)', p_depot: 'ALM-DEMO', p_unit_price_xof: 15000,
      });
      return `Facture ${r.invoice_number} : ${fcfa(r.total_xof)}. Le lot ${r.picks[0].lot_number}, qui expire dans 10 jours, est sorti en premier (FEFO), pas le conteneur arrivé ce matin.`;
    },
  },
  {
    title: 'Vente à perte : bloquée', tab: 'operations',
    run: async () => {
      const m = await blocked(() => rpc('dispatch_fefo', {
        p_product: 'DEMO-FOIE', p_qty: 10, p_client: 'Restaurant Le Lagon (démo)', p_depot: 'ALM-DEMO', p_unit_price_xof: 15000,
      }));
      return `🛑 DEPOTEK refuse : ${m}`;
    },
  },
  {
    title: 'Client au-delà de son crédit : bloqué', tab: 'creances',
    run: async () => {
      const m = await blocked(() => rpc('dispatch_fefo', {
        p_product: 'DEMO-HACHE', p_qty: 300, p_client: 'Boucherie Ndiaye (démo)', p_depot: 'ALM-DEMO', p_unit_price_xof: 22000,
      }));
      return `🛑 ${m}. La Boucherie a déjà une facture en retard de 12 jours.`;
    },
  },
  {
    title: 'Encaissement Wave', tab: 'creances',
    run: async () => {
      const r = await rpc<{ amount_xof: number; remaining_balance_xof: number }>('record_client_payment', {
        p_client: 'Boucherie Ndiaye (démo)', p_amount_xof: 1500000, p_method: 'wave', p_reference: 'WAVE-DEMO',
      });
      return `${fcfa(r.amount_xof)} reçus, imputés sur la facture la plus ancienne. Reste dû : ${fcfa(r.remaining_balance_xof)}.`;
    },
  },
  {
    title: 'Perte déclarée à l’inventaire', tab: 'operations',
    run: async () => {
      const { data } = await supabase.from('v_stock_lots').select('quantity').eq('lot_number', 'TH-1101').maybeSingle();
      const cur = Number(data?.quantity ?? 5);
      const r = await rpc<{ value_impact_xof: number }>('adjust_stock', {
        p_product: 'DEMO-THIOF', p_lot_number: 'TH-1101', p_counted_qty: Math.max(cur - 3, 0),
        p_reason: 'Cartons abîmés (démo)', p_depot: 'SOD-DEMO', p_is_loss: true,
      });
      return `3 cartons de thiof perdus (${fcfa(Math.abs(Number(r.value_impact_xof)))}). Le moteur la signale aux managers.`;
    },
  },
  {
    title: 'Une chambre se remplit', tab: 'stock',
    run: async () => {
      await rpc('receive_lot', {
        p_product: 'DEMO-FOIE', p_qty: 400, p_lot_number: 'FB-LIVE', p_depot: 'ALM-DEMO',
        p_expiry_date: new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10),
        p_cost_unit: 32, p_cost_currency: 'USD', p_fx_rate_to_xof: 600, p_storage_unit: 'CF1',
      });
      const { data } = await supabase.from('v_storage_rooms').select('fill_pct').eq('depot_code', 'ALM-DEMO').eq('room_code', 'CF1').maybeSingle();
      return `400 cartons de foie entrent : le Grand frigo viande passe à ${qty(data?.fill_pct ?? 0)} %. Le moteur alerte avant la saturation.`;
    },
  },
  {
    title: 'Location d’une chambre entière', tab: 'stock',
    run: async () => {
      const r = await rpc<{ invoices?: { invoice_number: string; total_xof: number }[] }>('rent_room', {
        p_client: 'Poissonnerie Soumbédioune (démo)', p_room: 'S2', p_depot: 'SOD-DEMO', p_billing: 'mensuel',
        p_price_xof: 400000, p_electricity_by_tenant: true, p_deposit_xof: 400000,
      });
      const inv = r.invoices?.[0];
      return `Chambre 2 de Sodida louée 400 000 FCFA/mois, électricité payée par le locataire.${inv ? ` Facture ${inv.invoice_number} : ${fcfa(inv.total_xof)} (prorata du mois).` : ''}`;
    },
  },
  {
    title: 'Le moteur a tout analysé', tab: 'accueil',
    run: async () => {
      await new Promise((r) => setTimeout(r, 4000));
      const { count } = await supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('status', 'ouverte');
      return `${count ?? 0} action(s) préparées dans « À traiter » : réappro, lots à écouler, relance WhatsApp, perte, chambre pleine, fin de location… Un geste pour valider.`;
    },
  },
];
