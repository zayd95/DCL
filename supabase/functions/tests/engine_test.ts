import { buildDocumentTask, telegramMessage } from "../engine/logic.ts";

function assert(c: unknown, msg = "assertion"): asserts c { if (!c) throw new Error(msg); }
const skus = new Set(["BOE-FOI-20", "POU-CUI-10"]);
const doc = { id: "d1" };

Deno.test("facture sûre → réception prête à valider", () => {
  const t = buildDocumentTask(doc, {
    type: "facture_fournisseur", fournisseur: "Allana", reference: "INV-77", conteneur: "MSCU1", devise: "EUR", confiance: 0.95,
    lignes: [{ description: "Beef Liver 20kg IQF", sku: "BOE-FOI-20", quantite: 500, lot: "L1", expiration: "2027-06-01", cout_unitaire: 30 },
             { description: "Chicken legs", sku: "POU-CUI-10", quantite: 300, lot: null, expiration: null, cout_unitaire: 11 }],
  }, skus);
  assert(t.action?.tool === "reception", JSON.stringify(t));
  assert(t.action.args.lignes[1].lot === "INV-77-2", "lot généré si absent");
  assert(t.audience.includes("magasinier"), "magasinier concerné");
  assert(t.dedupe_key === "document:d1");
});

Deno.test("produit inconnu, USD ou photo floue → rien d'exécutable, explication", () => {
  const t = buildDocumentTask(doc, {
    type: "facture_fournisseur", devise: "USD", confiance: 0.5,
    lignes: [{ description: "Mystery meat", sku: "XXX", quantite: 10 }],
  }, skus);
  assert(t.action === null, "pas d'action");
  assert(t.body.includes("non reconnu") && t.body.includes("USD") && t.body.includes("incertaine"), t.body);
});

Deno.test("reçu Wave → encaissement pour la finance", () => {
  const t = buildDocumentTask(doc, { type: "recu_paiement", client: "Moussa Traders", montant: 500000.4, mode: "wave", reference: "W1", confiance: 0.9 }, skus);
  assert(t.action?.tool === "encaissement" && t.action.args.montant === 500000, JSON.stringify(t.action));
  assert(!t.audience.includes("magasinier"), "finance seulement");
  assert(t.title.includes("500 000 FCFA"), t.title);
});

Deno.test("message Telegram : boutons selon la tâche", () => {
  const withAction = telegramMessage({ id: "t1", severity: "critical", title: "Rupture", body: "x", action: { tool: "bon_commande" } });
  const kb = withAction.reply_markup.inline_keyboard;
  assert(kb[0][0].callback_data === "v:t1" && kb[0][1].callback_data === "r:t1", JSON.stringify(kb));
  assert(withAction.text.startsWith("🔴"));
  const withLink = telegramMessage({ id: "t2", severity: "warning", title: "Relancer", body: "y", action: null, link: "https://wa.me/221770000001" });
  assert(withLink.reply_markup.inline_keyboard[0][0].url.startsWith("https://wa.me/"), "lien WhatsApp en premier");
});
