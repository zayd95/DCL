// Logique pure du moteur (sans réseau) : testable et partagée par index.ts.

// deno-lint-ignore no-explicit-any
type Any = Record<string, any>;

export const fcfa = (n: unknown) =>
  Math.round(Number(n ?? 0)).toLocaleString("fr-FR").replace(/[\u202f\u00a0]/g, " ") + " FCFA";

const ICON: Record<string, string> = { critical: "🔴", warning: "🟠", info: "🔵" };

/** Transforme une lecture en tâche : action prête si tout est sûr, sinon ce qu'il faut corriger. */
export function buildDocumentTask(doc: Any, x: Any, skus: Set<string>): Any {
  const base = { kind: "document", dedupe_key: `document:${doc.id}`, severity: "info" };
  const lowConfidence = Number(x.confiance ?? 0) < 0.7;
  const warn = (issues: string[]) =>
    issues.length ? `\n\n⚠️ À vérifier avant validation :\n• ${issues.join("\n• ")}` : "";

  if (x.type === "facture_fournisseur") {
    const lignes = (x.lignes ?? []) as Any[];
    const issues: string[] = [];
    if (lowConfidence) issues.push("lecture incertaine (photo floue ?)");
    lignes.forEach((l, i) => {
      if (!l.sku || !skus.has(l.sku)) issues.push(`ligne ${i + 1} « ${l.description} » : produit non reconnu dans le catalogue`);
    });
    if (x.devise === "USD") issues.push("facture en USD : taux de change à saisir dans l'app");
    const detail = lignes.map((l) =>
      `• ${l.description} : ${l.quantite}${l.lot ? ` — lot ${l.lot}` : ""}${l.expiration ? ` — exp. ${l.expiration}` : ""}` +
      `${l.cout_unitaire != null ? ` — ${l.cout_unitaire} ${x.devise ?? ""}` : ""}`).join("\n");
    const ready = issues.length === 0 && lignes.length > 0;
    return {
      ...base,
      title: `Facture ${x.fournisseur ?? "fournisseur"} lue : ${lignes.length} ligne(s) à réceptionner`,
      body: `${x.reference ? `Réf. ${x.reference}. ` : ""}${x.conteneur ? `Conteneur ${x.conteneur}.` : ""}\n${detail}${warn(issues)}`,
      audience: ["magasinier", "manager", "admin"],
      action: ready ? {
        tool: "reception",
        args: {
          fournisseur: x.fournisseur, conteneur: x.conteneur, devise: x.devise ?? "XOF", reference: x.reference,
          lignes: lignes.map((l, i) => ({
            produit: l.sku, quantite: l.quantite, lot: l.lot || `${x.reference ?? "REC"}-${i + 1}`,
            expiration: l.expiration, cout_unitaire: l.cout_unitaire,
          })),
        },
      } : null,
    };
  }

  if (x.type === "recu_paiement") {
    const issues: string[] = [];
    if (lowConfidence) issues.push("lecture incertaine");
    if (!x.client) issues.push("client non identifié dans le répertoire");
    if (!x.montant) issues.push("montant illisible");
    const ready = issues.length === 0;
    return {
      ...base,
      title: `Paiement reçu : ${x.montant ? fcfa(x.montant) : "montant ?"}${x.client ? ` de ${x.client}` : ""}`,
      body: `${x.mode ?? "Mode inconnu"}${x.reference ? `, réf. ${x.reference}` : ""}${x.date ? `, le ${x.date}` : ""}.` +
        (ready ? " À valider pour l'imputer sur ses factures les plus anciennes." : "") + warn(issues),
      audience: ["manager", "cfo", "admin"],
      action: ready ? {
        tool: "encaissement",
        args: { client: x.client, montant: Math.round(x.montant), mode: x.mode ?? "autre", reference: x.reference },
      } : null,
    };
  }

  if (x.type === "bon_commande") {
    const lignes = (x.lignes ?? []) as Any[];
    return {
      ...base,
      title: `Commande client${x.client ? ` : ${x.client}` : ""}`,
      body: lignes.map((l) => `• ${l.description} : ${l.quantite}`).join("\n") +
        "\n\nPréparez la vente depuis l'onglet Opérations ou l'Assistant.",
      audience: ["magasinier", "manager", "admin"],
      action: null,
    };
  }

  return {
    ...base,
    title: "Document lu (type non reconnu)",
    body: x.remarques ?? "Ce document n'est ni une facture fournisseur, ni un reçu, ni un bon de commande.",
    audience: ["manager", "cfo", "admin"],
    action: null,
  };
}

export function telegramMessage(t: Any, appUrl = "https://depotek.vercel.app"): Any {
  const buttons: Any[][] = [];
  if (t.link) buttons.push([{ text: "💬 Relancer sur WhatsApp", url: t.link }]);
  buttons.push(t.action
    ? [{ text: "✅ Valider", callback_data: `v:${t.id}` }, { text: "✖ Refuser", callback_data: `r:${t.id}` }]
    : [{ text: "✔ C'est noté", callback_data: `v:${t.id}` }, { text: "✖ Ignorer", callback_data: `r:${t.id}` }]);
  buttons.push([{ text: "Ouvrir DEPOTEK", url: appUrl }]);
  return {
    text: `${ICON[t.severity] ?? "🔵"} ${t.title}\n\n${t.body}`.slice(0, 4000),
    reply_markup: { inline_keyboard: buttons },
    disable_web_page_preview: true,
  };
}

