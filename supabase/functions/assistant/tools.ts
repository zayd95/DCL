// Outils de l'assistant DEPOTEK.
//   • Lecture : exécutés immédiatement, avec les droits de l'utilisateur (RLS).
//   • Écriture : jamais exécutés directement — une action "en attente" est créée
//     et l'utilisateur doit confirmer dans l'app.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { fcfa, qty } from "../_shared/format.ts";

// deno-lint-ignore no-explicit-any
type Args = Record<string, any>;

const S = { type: "STRING" } as const;
const N = { type: "NUMBER" } as const;
const I = { type: "INTEGER" } as const;
const B = { type: "BOOLEAN" } as const;
const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "OBJECT", properties, required });

// ─── Déclarations envoyées à Gemini ──────────────────────────────────────────

export const readTools = [
  {
    name: "stock_produits",
    description: "Stock d'ODS par produit : quantité, valeur FCFA, prochaine péremption, couverture en jours, besoin de réappro.",
    parameters: obj({ recherche: { ...S, description: "Nom ou SKU partiel (optionnel)" } }),
  },
  {
    name: "stock_lots",
    description: "Détail par lot (FEFO) : entrepôt, chambre froide, quantité, date d'expiration, statut FEFO, conteneur, fournisseur, propriétaire (stock tiers).",
    parameters: obj({
      produit: { ...S, description: "Nom ou SKU partiel (optionnel)" },
      depot: { ...S, description: "Code entrepôt (optionnel)" },
      statut_fefo: { ...S, description: "EXPIRE | CRITIQUE | ATTENTION | OK (optionnel)" },
    }),
  },
  {
    name: "creances",
    description: "Encours clients : solde, montant en retard, jours de retard. Avec un client : liste de ses factures ouvertes.",
    parameters: obj({ client: { ...S, description: "Nom du client (optionnel)" } }),
  },
  {
    name: "ventes",
    description: "Chiffre d'affaires, coût, marge, ventes par produit, meilleurs clients, encaissements sur une période.",
    parameters: obj({
      date_debut: { ...S, description: "AAAA-MM-JJ" },
      date_fin: { ...S, description: "AAAA-MM-JJ" },
    }, ["date_debut", "date_fin"]),
  },
  {
    name: "briefing",
    description: "Synthèse complète du jour : stock, ventes d'hier, créances, lots à écouler, réappro, chambres chargées et louées.",
    parameters: obj({}),
  },
  {
    name: "alertes",
    description: "Alertes non lues (FEFO, réappro, impayés).",
    parameters: obj({}),
  },
  {
    name: "clients",
    description: "Liste des clients (nom, téléphone, type, limite de crédit, délai de paiement).",
    parameters: obj({ recherche: { ...S, description: "Nom partiel (optionnel)" } }),
  },
  {
    name: "chambres",
    description: "Chambres froides par entrepôt (Almadies, Sodida…) : capacité, remplissage, produits stockés, statut libre / stock ODS / louée, locataire, loyer, fin de location.",
    parameters: obj({ entrepot: { ...S, description: "Code ou nom d'entrepôt (optionnel)" } }),
  },
];

export const writeTools = [
  {
    name: "sortie_vente",
    description: "Sortie de stock pour un client selon FEFO + facture automatique. Refuse les lots expirés, les prix sous le coût de revient et le dépassement de crédit.",
    parameters: obj({
      produit: S, quantite: N, client: S,
      prix_unitaire_fcfa: { ...I, description: "Si absent : prix par défaut du produit" },
      depot: { ...S, description: "Optionnel" },
      delai_paiement_jours: { ...I, description: "Optionnel, sinon conditions du client" },
      forcer_credit: { ...B, description: "Dérogation manager (crédit ou prix sous le coût)" },
      note: S,
    }, ["produit", "quantite", "client"]),
  },
  {
    name: "encaissement_client",
    description: "Enregistre un paiement global d'un client, imputé sur ses factures les plus anciennes.",
    parameters: obj({
      client: S, montant_fcfa: I,
      mode: { ...S, description: "especes | wave | orange_money | virement | cheque | autre" },
      reference: S,
    }, ["client", "montant_fcfa"]),
  },
  {
    name: "encaissement_facture",
    description: "Enregistre un paiement sur une facture précise (ex. FAC-2026-00012).",
    parameters: obj({ numero_facture: S, montant_fcfa: I, mode: S, reference: S }, ["numero_facture", "montant_fcfa"]),
  },
  {
    name: "reception_lot",
    description: "Réception d'un lot dans un entrepôt et une chambre froide (entrée de stock).",
    parameters: obj({
      produit: S, quantite: N, numero_lot: S, depot: S,
      date_expiration: { ...S, description: "AAAA-MM-JJ" },
      cout_unitaire: N, devise: { ...S, description: "XOF | EUR | USD" },
      taux_change_xof: { ...N, description: "Obligatoire si USD" },
      fournisseur: S, conteneur: S, chambre: { ...S, description: "Chambre froide où ranger le lot (code ou nom)" },
      client_proprietaire: { ...S, description: "Si la marchandise appartient à un client (chambre louée)" },
    }, ["produit", "quantite", "numero_lot"]),
  },
  {
    name: "transfert",
    description: "Transfert de stock entre deux entrepôts (FEFO).",
    parameters: obj({ produit: S, quantite: N, depot_depart: S, depot_arrivee: S, chambre_arrivee: { ...S, description: "Chambre froide d'arrivée (optionnel)" } },
      ["produit", "quantite", "depot_depart", "depot_arrivee"]),
  },
  {
    name: "inventaire",
    description: "Corrige le stock d'un lot après comptage, ou déclare une perte. Manager uniquement.",
    parameters: obj({
      produit: S, numero_lot: S, quantite_comptee: N, motif: S, depot: S,
      perte: { ...B, description: "true si casse / avarie / vol" },
    }, ["produit", "numero_lot", "quantite_comptee", "motif"]),
  },
  {
    name: "creer_client",
    description: "Crée un client.",
    parameters: obj({
      nom: S, telephone: S,
      type: { ...S, description: "grossiste | detaillant | restaurant | supermarche | locataire_froid | autre" },
      limite_credit_fcfa: I, delai_paiement_jours: I,
    }, ["nom"]),
  },
  {
    name: "louer_chambre",
    description: "Loue une chambre froide ENTIÈRE et vide à un client, au mois (loyer mensuel) ou au forfait (prix total, date de fin obligatoire). Électricité à la charge du locataire par défaut.",
    parameters: obj({
      client: S, chambre: { ...S, description: "Code ou nom de la chambre" }, entrepot: S,
      facturation: { ...S, description: "mensuel | forfait" }, prix_fcfa: I,
      debut: { ...S, description: "AAAA-MM-JJ" }, fin: { ...S, description: "AAAA-MM-JJ" },
      electricite_locataire: B, caution_fcfa: I,
    }, ["client", "chambre", "facturation", "prix_fcfa"]),
  },
  {
    name: "deplacer_lot",
    description: "Range un lot dans une autre chambre froide du même entrepôt.",
    parameters: obj({ produit: S, numero_lot: S, chambre: S, entrepot: S }, ["produit", "numero_lot", "chambre"]),
  },
];

export const WRITE_TOOL_NAMES = new Set(writeTools.map((t) => t.name));

// ─── Exécution des lectures ──────────────────────────────────────────────────

export async function runReadTool(db: SupabaseClient, name: string, a: Args): Promise<unknown> {
  // Nettoie la recherche (les virgules/parenthèses casseraient le filtre .or de PostgREST)
  const clean = (s?: string) => (s ?? "").replace(/[,()*%]/g, " ").trim();
  const like = (s?: string) => `%${clean(s)}%`;
  const orLike = (s?: string) => `*${clean(s)}*`;
  switch (name) {
    case "stock_produits": {
      let q = db.from("v_stock_products").select("*").order("value_xof", { ascending: false });
      if (a.recherche) q = q.or(`product_name.ilike.${orLike(a.recherche)},sku.ilike.${orLike(a.recherche)}`);
      return unwrap(await q.limit(50));
    }
    case "stock_lots": {
      let q = db.from("v_stock_lots").select(
        "sku,product_name,depot_code,room_name,lot_number,quantity,unit_type,weight_kg,value_xof,cost_unit_xof,expiry_date,days_to_expiry,fefo_status,container_no,supplier,owner_client",
      ).order("expiry_date", { ascending: true, nullsFirst: false });
      if (a.produit) q = q.or(`product_name.ilike.${orLike(a.produit)},sku.ilike.${orLike(a.produit)}`);
      if (a.depot) q = q.ilike("depot_code", a.depot);
      if (a.statut_fefo) q = q.eq("fefo_status", String(a.statut_fefo).toUpperCase());
      return unwrap(await q.limit(100));
    }
    case "creances": {
      if (a.client) {
        return unwrap(await db.from("v_receivables").select("*").ilike("client_name", like(a.client))
          .order("due_date"));
      }
      return unwrap(await db.from("v_client_balances").select("*").gt("balance_xof", 0)
        .order("overdue_xof", { ascending: false }));
    }
    case "ventes":
      return unwrap(await db.rpc("sales_summary", { p_from: a.date_debut, p_to: a.date_fin }));
    case "briefing":
      return unwrap(await db.rpc("daily_briefing"));
    case "alertes":
      return unwrap(await db.from("alerts").select("level,kind,title,body,created_at").is("read_at", null)
        .order("created_at", { ascending: false }).limit(30));
    case "chambres": {
      let q = db.from("v_storage_rooms").select(
        "depot_name,depot_code,room_code,room_name,kind,categories,capacity_tonnes,capacity_cartons,used_tonnes,used_cartons,fill_pct,products,status,tenant,billing,price_xof,start_date,end_date,electricity_by_tenant",
      ).order("depot_code").order("room_code");
      if (a.entrepot) q = q.or(`depot_code.ilike.${orLike(a.entrepot)},depot_name.ilike.${orLike(a.entrepot)}`);
      return unwrap(await q);
    }
    case "clients": {
      let q = db.from("clients").select("name,phone,type,credit_limit_xof,payment_terms_days").eq("active", true);
      if (a.recherche) q = q.ilike("name", like(a.recherche));
      return unwrap(await q.order("name").limit(100));
    }
  }
  throw new Error(`Outil inconnu : ${name}`);
}

// ─── Écritures : résumé humain + appel RPC ───────────────────────────────────

export function summarizeWrite(name: string, a: Args): string {
  switch (name) {
    case "sortie_vente":
      return `Sortie FEFO de ${qty(a.quantite)} × ${a.produit} pour ${a.client}` +
        (a.prix_unitaire_fcfa ? ` à ${fcfa(a.prix_unitaire_fcfa)}/unité (total ${fcfa(a.quantite * a.prix_unitaire_fcfa)})` : " au prix par défaut") +
        (a.depot ? ` depuis ${a.depot}` : "") + ", avec facture" + (a.forcer_credit ? " — dérogation manager" : "");
    case "encaissement_client":
      return `Encaissement de ${fcfa(a.montant_fcfa)} de ${a.client}${a.mode ? ` (${a.mode})` : ""}, imputé sur ses plus anciennes factures`;
    case "encaissement_facture":
      return `Encaissement de ${fcfa(a.montant_fcfa)} sur la facture ${a.numero_facture}`;
    case "reception_lot":
      return `Réception de ${qty(a.quantite)} × ${a.produit}, lot ${a.numero_lot}` +
        (a.date_expiration ? `, expire le ${a.date_expiration}` : "") + (a.depot ? ` à ${a.depot}` : "") +
        (a.chambre ? `, chambre ${a.chambre}` : "") + (a.client_proprietaire ? ` (marchandise de ${a.client_proprietaire})` : "");
    case "transfert":
      return `Transfert de ${qty(a.quantite)} × ${a.produit} de ${a.depot_depart} vers ${a.depot_arrivee}${a.chambre_arrivee ? `, chambre ${a.chambre_arrivee}` : ""}`;
    case "inventaire":
      return `${a.perte ? "Perte déclarée" : "Correction d'inventaire"} : ${a.produit} lot ${a.numero_lot} → ${qty(a.quantite_comptee)} (motif : ${a.motif})`;
    case "creer_client":
      return `Création du client ${a.nom}` + (a.limite_credit_fcfa ? `, limite de crédit ${fcfa(a.limite_credit_fcfa)}` : "") +
        (a.delai_paiement_jours ? `, paiement à ${a.delai_paiement_jours} j` : "");
    case "louer_chambre":
      return `Location de la chambre ${a.chambre}${a.entrepot ? ` (${a.entrepot})` : ""} à ${a.client} : ` +
        (a.facturation === "forfait" ? `forfait ${fcfa(a.prix_fcfa)} jusqu'au ${a.fin}` : `${fcfa(a.prix_fcfa)} par mois`) +
        `${a.debut ? `, à partir du ${a.debut}` : ""}, électricité ${a.electricite_locataire === false ? "incluse" : "à la charge du locataire"}`;
    case "deplacer_lot":
      return `Déplacer le lot ${a.numero_lot} (${a.produit}) vers la chambre ${a.chambre}`;
  }
  return name;
}

export function runWriteTool(db: SupabaseClient, name: string, a: Args): Promise<unknown> {
  const call = async (fn: string, params: Args) => unwrap(await db.rpc(fn, stripUndefined(params)));
  switch (name) {
    case "sortie_vente":
      return call("dispatch_fefo", {
        p_product: a.produit, p_qty: a.quantite, p_client: a.client, p_depot: a.depot,
        p_unit_price_xof: a.prix_unitaire_fcfa, p_due_days: a.delai_paiement_jours,
        p_force: a.forcer_credit ?? false, p_notes: a.note,
      });
    case "encaissement_client":
      return call("record_client_payment", {
        p_client: a.client, p_amount_xof: a.montant_fcfa, p_method: payMethod(a.mode), p_reference: a.reference,
      });
    case "encaissement_facture":
      return call("record_payment", {
        p_invoice_number: a.numero_facture, p_amount_xof: a.montant_fcfa, p_method: payMethod(a.mode), p_reference: a.reference,
      });
    case "reception_lot":
      return call("receive_lot", {
        p_product: a.produit, p_qty: a.quantite, p_lot_number: a.numero_lot, p_depot: a.depot,
        p_expiry_date: a.date_expiration, p_cost_unit: a.cout_unitaire, p_cost_currency: a.devise ? String(a.devise).toUpperCase() : undefined,
        p_fx_rate_to_xof: a.taux_change_xof, p_supplier: a.fournisseur, p_container_no: a.conteneur,
        p_storage_unit: a.chambre, p_owner_client: a.client_proprietaire,
      });
    case "transfert":
      return call("transfer_stock", {
        p_product: a.produit, p_qty: a.quantite, p_from_depot: a.depot_depart, p_to_depot: a.depot_arrivee, p_to_room: a.chambre_arrivee,
      });
    case "inventaire":
      return call("adjust_stock", {
        p_product: a.produit, p_lot_number: a.numero_lot, p_counted_qty: a.quantite_comptee,
        p_reason: a.motif, p_depot: a.depot, p_is_loss: a.perte ?? false,
      });
    case "creer_client":
      return call("create_client", {
        p_name: a.nom, p_phone: a.telephone, p_type: a.type,
        p_credit_limit_xof: a.limite_credit_fcfa, p_payment_terms_days: a.delai_paiement_jours,
      });
    case "louer_chambre":
      return call("rent_room", {
        p_client: a.client, p_room: a.chambre, p_depot: a.entrepot, p_billing: a.facturation, p_price_xof: a.prix_fcfa,
        p_start: a.debut, p_end: a.fin, p_electricity_by_tenant: a.electricite_locataire ?? true, p_deposit_xof: a.caution_fcfa,
      });
    case "deplacer_lot":
      return call("move_lot", { p_product: a.produit, p_lot_number: a.numero_lot, p_room: a.chambre, p_depot: a.entrepot });
  }
  throw new Error(`Outil inconnu : ${name}`);
}

export function describeResult(name: string, r: Args): string {
  switch (name) {
    case "sortie_vente":
      return `✅ Sortie enregistrée. Facture ${r.invoice_number} : ${fcfa(r.total_xof)} pour ${r.client}.\n` +
        `Lots prélevés : ${(r.picks ?? []).map((p: Args) => `${p.lot_number} (${qty(p.qty)})`).join(", ")}`;
    case "encaissement_client":
      return `✅ ${fcfa(r.amount_xof)} encaissés pour ${r.client}. Reste dû : ${fcfa(r.remaining_balance_xof)}.`;
    case "encaissement_facture":
      return `✅ Facture ${r.invoice_number} : payé ${fcfa(r.paid_xof)}, reste ${fcfa(r.balance_xof)} (${r.status}).`;
    case "reception_lot":
      return `✅ Lot ${r.lot_number} reçu : ${qty(r.quantity)} × ${r.product} à ${r.depot}${r.room ? `, chambre ${r.room}` : ""}.`;
    case "transfert":
      return `✅ Transfert ${r.from} → ${r.to} : ${qty(r.quantity)} × ${r.product}.`;
    case "inventaire":
      return r.delta == 0 ? "✅ Aucun écart." :
        `✅ ${r.product} lot ${r.lot_number} : ${qty(r.previous)} → ${qty(r.counted)} (impact ${fcfa(r.value_impact_xof)}).`;
    case "creer_client":
      return `✅ Client ${r.name} créé.`;
    case "louer_chambre":
      return `✅ Chambre ${r.room} louée à ${r.client}.` +
        ((r.invoices ?? [])[0] ? ` Facture ${r.invoices[0].invoice_number} : ${fcfa(r.invoices[0].total_xof)}.` : "");
    case "deplacer_lot":
      return `✅ Lot ${r.lot_number} rangé dans ${r.room}.`;
  }
  return "✅ Fait.";
}

const PAY_METHODS = ["especes", "wave", "orange_money", "virement", "cheque", "autre"];
export function payMethod(m?: string): string | undefined {
  if (!m) return undefined;
  const v = m.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\s-]+/g, "_");
  if (v.startsWith("om") || v.includes("orange")) return "orange_money";
  if (v.includes("cash")) return "especes";
  if (v.includes("banque") || v.includes("bank")) return "virement";
  return PAY_METHODS.includes(v) ? v : "autre";
}

// deno-lint-ignore no-explicit-any
function unwrap<T>(res: { data: T; error: any }): T {
  if (res.error) throw new Error(res.error.message ?? String(res.error));
  return res.data;
}

function stripUndefined(o: Args): Args {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}
