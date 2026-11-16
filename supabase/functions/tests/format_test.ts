// Assertions minimales (pas de dépendance réseau)
function assert(c: unknown, msg = "assertion"): asserts c { if (!c) throw new Error(msg); }
function assertEquals<T>(a: T, b: T) { if (a !== b) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function assertStringIncludes(s: string, sub: string) { if (!s.includes(sub)) throw new Error(`"${sub}" absent de :\n${s}`); }
import { briefingText, fcfa } from "../_shared/format.ts";
import { payMethod, summarizeWrite, describeResult, readTools, writeTools } from "../assistant/tools.ts";

Deno.test("fcfa", () => {
  assertEquals(fcfa(1250000), "1 250 000 FCFA");
  assertEquals(fcfa(null), "0 FCFA");
});

Deno.test("modes de paiement tolérants", () => {
  assertEquals(payMethod("Wave"), "wave");
  assertEquals(payMethod("OM"), "orange_money");
  assertEquals(payMethod("Orange Money"), "orange_money");
  assertEquals(payMethod("espèces"), "especes");
  assertEquals(payMethod("cash"), "especes");
  assertEquals(payMethod("banque"), "virement");
  assertEquals(payMethod("bitcoin"), "autre");
});

Deno.test("résumés et résultats", () => {
  assertStringIncludes(summarizeWrite("sortie_vente", { produit: "Foie", quantite: 10, client: "Moussa", prix_unitaire_fcfa: 32000 }),
    "total 320 000 FCFA");
  assertStringIncludes(describeResult("encaissement_client", { client: "Moussa", amount_xof: 500000, remaining_balance_xof: 150000 }),
    "Reste dû : 150 000 FCFA");
});

Deno.test("déclarations d'outils uniques et valides", () => {
  const names = [...readTools, ...writeTools].map((t) => t.name);
  assertEquals(new Set(names).size, names.length);
  for (const t of writeTools) for (const r of t.parameters.required) assert(r in t.parameters.properties, `${t.name}.${r}`);
});

Deno.test("briefing sur données réelles de test", async () => {
  const path = Deno.env.get("BRIEFING_JSON");
  if (!path) return;
  const text = briefingText(JSON.parse(await Deno.readTextFile(path)));
  console.log("\n" + text);
  assertStringIncludes(text, "Relancer Moussa Traders");
  assertStringIncludes(text, "Commander Cuisse de poulet 10kg");
});
