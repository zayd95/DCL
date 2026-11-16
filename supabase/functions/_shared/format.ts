// Formatage partagé (FCFA, dates, briefing) — français, lisible sur téléphone.

export const fcfa = (n: number | string | null | undefined): string => {
  const v = Math.round(Number(n ?? 0));
  return v.toLocaleString("fr-FR").replace(/[\u202f\u00a0]/g, " ") + " FCFA";
};

export const qty = (n: number | string | null | undefined): string =>
  Number(n ?? 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 }).replace(/[\u202f\u00a0]/g, " ");

const UNIT_LABELS: Record<string, [string, string]> = {
  carton: ["carton", "cartons"], palette: ["palette", "palettes"], sac: ["sac", "sacs"],
  piece: ["pièce", "pièces"], kg: ["kg", "kg"], tonne: ["t", "t"], litre: ["L", "L"],
};
export const unitLabel = (unit: string, n: number | string): string => {
  const l = UNIT_LABELS[unit] ?? [unit, unit];
  return Number(n) > 1 ? l[1] : l[0];
};

export const frDate = (d: string | Date): string =>
  new Date(d).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "Africa/Dakar" });

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type Briefing = Record<string, any>;

/** Transforme le JSON de daily_briefing() en message court + actions du jour. */
export function briefingText(b: Briefing): string {
  const y = b.yesterday ?? {};
  const lines: string[] = [];
  lines.push(`☀️ DEPOTEK — ${frDate(b.date)}`);
  lines.push("");
  lines.push(`📦 Stock : ${fcfa(b.stock_value_xof)}`);
  for (const p of (b.stock_by_product ?? []).slice(0, 5)) {
    const cover = p.days_of_cover != null ? ` · ${p.days_of_cover} j de couverture` : "";
    lines.push(`  • ${p.product} : ${qty(p.quantity)} ${unitLabel(p.unit, p.quantity)}${cover}`);
  }
  lines.push("");
  lines.push(`💰 Hier : ventes ${fcfa(y.revenue_xof)}, marge ${fcfa(y.margin_xof)}` +
    (y.margin_pct != null ? ` (${y.margin_pct} %)` : "") + `, encaissé ${fcfa(y.payments_received_xof)}`);
  lines.push(`🧾 Créances : ${fcfa(b.receivables_xof)} dont ${fcfa(b.overdue_xof)} en retard`);

  const actions: string[] = [];
  for (const d of (b.top_debtors ?? []).filter((d: Briefing) => d.overdue_xof > 0).slice(0, 3)) {
    actions.push(`Relancer ${d.client} : ${fcfa(d.overdue_xof)} en retard (${d.max_days_overdue} j)` +
      (d.phone ? ` — ${d.phone}` : ""));
  }
  for (const f of (b.fefo ?? []).filter((f: Briefing) => f.status !== "ATTENTION").slice(0, 3)) {
    actions.push(f.status === "EXPIRE"
      ? `Retirer ${f.product} lot ${f.lot} : EXPIRÉ (${qty(f.quantity)}, ${fcfa(f.value_xof)})`
      : `Écouler ${f.product} lot ${f.lot} : expire dans ${f.days_to_expiry} j (${qty(f.quantity)})`);
  }
  for (const r of (b.reorder ?? []).slice(0, 3)) {
    actions.push(`Commander ${r.product} : ` +
      (r.days_of_cover != null ? `${r.days_of_cover} j de stock` : `stock ${qty(r.quantity)}`) +
      ` pour ${r.lead_time_days} j de délai fournisseur`);
  }
  lines.push("");
  if (actions.length) {
    lines.push("✅ À faire aujourd'hui :");
    actions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  } else {
    lines.push("✅ Rien d'urgent aujourd'hui.");
  }
  const full = (b.rooms ?? []).filter((r: Briefing) => r.fill_pct != null && r.fill_pct >= 80 && r.status !== "louee");
  if (full.length) {
    lines.push("");
    lines.push("🧊 Chambres chargées : " + full.map((r: Briefing) => `${r.room} (${r.depot}) ${r.fill_pct} %`).join(", "));
  }
  if ((b.rented_rooms ?? []).length) {
    lines.push("🔑 Chambres louées : " + b.rented_rooms.map((r: Briefing) =>
      `${r.room} → ${r.client}${r.end_date ? ` (fin ${new Date(r.end_date).toLocaleDateString("fr-FR")})` : ""}`).join(", "));
  }
  return lines.join("\n");
}
