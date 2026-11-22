// ═════════════════════════════════════════════════════════════════════════════
// Edge Function : assistant DEPOTEK
//
// POST /functions/v1/assistant   (Authorization: Bearer <JWT utilisateur>)
//   { "messages": [{ "role": "user" | "model", "text": "..." }, ...] }
//     → { reply, pending_action?: { id, summary } }
//   { "action_id": "<uuid>", "decision": "confirm" | "cancel" }
//     → { reply, result? }
//
// La clé Gemini reste côté serveur. Toutes les requêtes à la base utilisent le
// JWT de l'utilisateur : ses droits (RLS + rôles) s'appliquent à l'assistant.
// ═════════════════════════════════════════════════════════════════════════════
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/format.ts";
import {
  checkOps, describeResult, readTools, runReadTool, runWriteTool, summarizeWrite, WRITE_TOOL_NAMES, writeTools,
} from "./tools.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

// Modèles essayés dans l'ordre (offre gratuite) : on passe au suivant si un modèle est retiré, saturé ou trop lent.
const GEMINI_MODELS = [
  ...(Deno.env.get("GEMINI_MODEL") ? [Deno.env.get("GEMINI_MODEL")!] : []),
  "gemini-3.8-flash", "gemini-flash-lite-latest", "gemini-flash-latest",
];
const GEMINI_TIMEOUT_MS = 12000;
// Un modèle saturé ou lent est mis de côté 5 minutes : les étapes suivantes partent directement sur le suivant
const cooldown = new Map<string, number>();
async function geminiCall(key: string, body: Record<string, unknown>, timeoutMs = GEMINI_TIMEOUT_MS): Promise<Response> {
  let last: Response | null = null;
  let lastErr = "";
  const ready = GEMINI_MODELS.filter((m) => (cooldown.get(m) ?? 0) < Date.now());
  for (const m of ready.length ? ready : GEMINI_MODELS) {
    // Réflexion minimale : réponses rapides (les modèles 3.x acceptent thinkingLevel)
    const gen = { ...(body.generationConfig as Record<string, unknown> ?? {}) };
    if (m.startsWith("gemini-3")) gen.thinkingConfig = { thinkingLevel: "low" };
    const t0 = Date.now();
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ ...body, generationConfig: gen }),
        // gemini-3.8 est souvent saturé : on ne l'attend jamais plus de 10 s
        signal: AbortSignal.timeout(m.startsWith("gemini-3") ? Math.min(timeoutMs, 10000) : timeoutMs),
      });
      console.log(`gemini ${m} ${res.status} ${Date.now() - t0}ms`);
      if (res.ok || ![400, 404, 429, 500, 503].includes(res.status)) return res;
      cooldown.set(m, Date.now() + 5 * 60_000);
      last = res;
    } catch (e) {
      lastErr = (e as Error).name === "TimeoutError" ? `délai dépassé (${m})` : (e as Error).message;
      cooldown.set(m, Date.now() + 5 * 60_000);
      console.log(`gemini ${m} échec ${Date.now() - t0}ms : ${lastErr}`);
    }
  }
  if (last) return last;
  throw new Error(`Gemini indisponible : ${lastErr}`);
}
const MAX_STEPS = 10;

type FileIn = { name: string; mime: string; data: string };
type Msg = { role: "user" | "model"; text: string; files?: FileIn[] };
// deno-lint-ignore no-explicit-any
type Part = Record<string, any>;
type Content = { role: "user" | "model"; parts: Part[] };

function systemPrompt(role: string, name: string): string {
  const today = new Date().toLocaleDateString("fr-CA", { timeZone: "Africa/Dakar" });
  return `Tu es DEPOTEK, l'assistant de gestion du hub froid d'ODS (Oury Diallo SARL) à Dakar :
viande, abats, volaille, poisson et fromage congelés ; ventes aux grossistes ; location de chambres froides entières à des tiers.
Plusieurs entrepôts (Almadies, Sodida…), chacun avec plusieurs chambres froides de capacités différentes (en tonnes ou en cartons).
Date du jour : ${today} (Africa/Dakar). Utilisateur : ${name || "inconnu"}, rôle : ${role}.

Règles :
- Ne JAMAIS inventer un chiffre : utilise toujours un outil pour lire les données réelles.
- Réponds en français, court et clair (lu sur téléphone). Montants en FCFA avec séparateurs (ex. 1 250 000 FCFA).
- Mise en forme : commence par la réponse directe en une phrase. Ensuite, si besoin, une liste à puces "- " (5 lignes max),
  chiffres clés en **gras**. Pas de tableau, pas de titre "#", pas de jargon technique (SKU, FEFO, RPC…) sauf si on te le demande.
- Comprends le langage courant et le wolof-français ("bayal", "jaay", "xaalis"…), les fautes et les abréviations (ctn = cartons, kg, t).
- Si la question reprend un message précédent ("et pour Sodida ?", "le même pour Moussa"), utilise le contexte de la conversation.
- Pour toute écriture (vente, encaissement, réception, transfert, inventaire, client, location de chambre, déplacement de lot), appelle l'outil
  d'écriture correspondant : le système demandera lui-même la confirmation à l'utilisateur. Ne demande pas "voulez-vous confirmer".
- S'il manque une information indispensable (client, quantité, prix si aucun prix par défaut…), pose UNE question courte.
- Après une lecture, donne la réponse puis, si c'est utile, UNE recommandation concrète
  (ex. relancer un client en retard, écouler un lot qui expire, lancer une commande, libérer une chambre).
- Si un outil renvoie une erreur de droits, explique simplement que ce rôle n'y a pas accès.
- Chambres : n'invente JAMAIS un nom de chambre. Avant une réception, un transfert ou une location, appelle l'outil chambres et choisis
  une chambre existante (code, ex. CB1) de l'entrepôt voulu, adaptée au produit (catégories) et avec de la place ; dis pourquoi en quelques mots.
  Si plusieurs choix se valent ou si rien ne convient, demande à l'utilisateur. Même règle pour les produits : utilise le SKU exact du catalogue.
- Documents joints (photos, PDF, Excel, CSV) : tu sais les lire (OCR, tableaux, écriture manuscrite), même plusieurs à la fois.
  1. Dis en une phrase ce que c'est (facture fournisseur, bon de livraison, reçu Wave/OM, relevé, liste de prix, contrat…) et résume l'essentiel.
  2. Rapproche chaque ligne du catalogue (outil catalogue) ; compare avec le stock, les factures ou les créances si c'est utile
     (ex. relevé client vs factures ouvertes, bon de livraison vs lots reçus) et signale les écarts.
  3. Si le document appelle une saisie, appelle directement TOUS les outils d'écriture nécessaires dans la même réponse
     (ex. une reception_lot par ligne, creer_produit avant si le produit n'existe pas, completer_lot pour un coût arrivé après,
     encaissement_client pour un reçu) : l'utilisateur validera l'ensemble en un geste.
  4. N'invente jamais une valeur illisible : demande-la. Numéro de lot absent : utilise "<n° facture ou conteneur>-<n° de ligne>".
- Dates au format AAAA-MM-JJ dans les appels d'outils. "Hier", "cette semaine", "ce mois" : calcule à partir de la date du jour.`;
}

async function gemini(system: string, contents: Content[], withTools = true, timeoutMs = GEMINI_TIMEOUT_MS): Promise<Part[]> {
  const res = await geminiCall(GEMINI_API_KEY, {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    tools: withTools ? [{ functionDeclarations: [...readTools, ...writeTools] }] : undefined,
    generationConfig: { temperature: 0.2 },
  }, timeoutMs);
  if (!res.ok) throw new Error(`Gemini ${res.status} : ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts ?? [];
}

async function handleDecision(db: SupabaseClient, actionId: string, decision: string): Promise<Response> {
  const { data: action, error } = await db.from("assistant_actions").select("*").eq("id", actionId).maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!action) return json({ error: "Action introuvable" }, 404);
  if (action.status !== "en_attente") return json({ reply: `Cette action est déjà ${action.status}.` });

  if (decision !== "confirm") {
    await db.from("assistant_actions").update({ status: "annulee", decided_at: new Date().toISOString() })
      .eq("id", actionId);
    return json({ reply: "❌ Action annulée." });
  }
  if (action.tool === "lot_operations") {
    // Exécution dans l'ordre (ex. créer le produit puis le réceptionner) ; on s'arrête à la première erreur
    const lines: string[] = [];
    const results: unknown[] = [];
    let failed = false;
    for (const [i, op] of ((action.args?.ops ?? []) as { tool: string; args: Record<string, unknown> }[]).entries()) {
      try {
        const r = await runWriteTool(db, op.tool, op.args);
        results.push(r);
        lines.push(describeResult(op.tool, r as Record<string, unknown>));
      } catch (e) {
        failed = true;
        lines.push(`⚠️ Opération ${i + 1} impossible : ${e instanceof Error ? e.message : String(e)}`);
        const rest = (action.args.ops.length as number) - i - 1;
        if (rest > 0) lines.push(`${rest} opération(s) suivante(s) non faite(s). Corrigez puis redemandez-les.`);
        break;
      }
    }
    await db.from("assistant_actions").update({
      status: failed ? (results.length ? "executee" : "echec") : "executee",
      result: { results, partial: failed }, decided_at: new Date().toISOString(),
    }).eq("id", actionId);
    return json({ reply: lines.join("\n"), result: results });
  }
  try {
    const result = await runWriteTool(db, action.tool, action.args);
    await db.from("assistant_actions").update({ status: "executee", result, decided_at: new Date().toISOString() })
      .eq("id", actionId);
    return json({ reply: describeResult(action.tool, result as Record<string, unknown>), result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("assistant_actions").update({ status: "echec", result: { error: msg }, decided_at: new Date().toISOString() })
      .eq("id", actionId);
    return json({ reply: `⚠️ Impossible : ${msg}` });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST uniquement" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: userData } = await db.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  const user = userData?.user;
  if (!user) return json({ error: "Non authentifié" }, 401);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, 400); }

  if (body.action_id) return handleDecision(db, body.action_id, body.decision);

  if (!GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY non configurée" }, 500);
  const messages: Msg[] = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return json({ error: "Le dernier message doit venir de l'utilisateur" }, 400);
  }

  const { data: profile } = await db.from("profiles").select("full_name, role").eq("id", user.id).maybeSingle();
  const system = systemPrompt(profile?.role ?? "magasinier", profile?.full_name ?? "");
  // Pièces jointes : lues directement par Gemini (images, PDF, texte/CSV)
  const OK_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf|text\/(plain|csv))$/;
  let hasFiles = false;
  const contents: Content[] = messages.map((m) => {
    const parts: Part[] = [];
    for (const f of (m.role === "user" && Array.isArray(m.files) ? m.files : []).slice(0, 10)) {
      if (!f?.data || !OK_MIME.test(f.mime)) continue;
      hasFiles = true;
      parts.push({ text: `[Pièce jointe : ${String(f.name).slice(0, 120)}]` });
      parts.push({ inline_data: { mime_type: f.mime, data: f.data } });
    }
    parts.push({ text: String(m.text ?? "") });
    return { role: m.role, parts };
  });
  const stepTimeout = hasFiles ? 40000 : GEMINI_TIMEOUT_MS; // un PDF de plusieurs pages demande plus de temps
  const deadline = hasFiles ? 85000 : 45000;

  const started = Date.now();
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // Passé le délai, on répond avec ce qu'on a déjà lu plutôt que de laisser le téléphone attendre
      if (step > 0 && Date.now() - started > deadline) break;
      const parts = await gemini(system, contents, true, stepTimeout);
      const calls = parts.filter((p) => p.functionCall);
      if (!calls.length) {
        const text = parts.map((p) => p.text ?? "").join("").trim();
        return json({ reply: text || "Je n'ai pas compris, pouvez-vous reformuler ?" });
      }
      contents.push({ role: "model", parts });

      // Écritures demandées → on s'arrête et on demande UNE confirmation pour l'ensemble
      const writes = calls.filter((c) => WRITE_TOOL_NAMES.has(c.functionCall.name));
      if (writes.length) {
        const ops = writes.map((c) => ({ tool: c.functionCall.name as string, args: c.functionCall.args ?? {} }));
        const problems = await checkOps(db, ops);
        if (problems.length && step < MAX_STEPS - 2) {
          // On renvoie les erreurs au modèle : il corrige (bonne chambre, bon produit) ou pose la question
          const fix: Part[] = [];
          for (const c of calls) {
            const { name, args } = c.functionCall;
            let response: unknown;
            if (WRITE_TOOL_NAMES.has(name)) {
              response = { erreur: "Non enregistré. À corriger avant de proposer : " + problems.join(" | ") };
            } else {
              try { response = { resultat: await runReadTool(db, name, args ?? {}) }; } catch (e) { response = { erreur: String(e) }; }
            }
            fix.push({ functionResponse: { name, response } });
          }
          contents.push({ role: "user", parts: fix });
          continue;
        }
        const intro = parts.map((p) => p.text ?? "").join("").trim();
        const summary = ops.length === 1
          ? summarizeWrite(ops[0].tool, ops[0].args)
          : ops.map((o, i) => `${i + 1}. ${summarizeWrite(o.tool, o.args)}`).join("\n");
        const { data: action, error } = await db.from("assistant_actions")
          .insert(ops.length === 1
            ? { user_id: user.id, tool: ops[0].tool, args: ops[0].args, summary }
            : { user_id: user.id, tool: "lot_operations", args: { ops }, summary })
          .select("id").single();
        if (error) throw new Error(error.message);
        const head = ops.length === 1 ? "Je m'apprête à faire :" : `Je m'apprête à faire ${ops.length} opérations :`;
        return json({
          reply: `${intro ? intro + "\n\n" : ""}${head}\n${summary}\n\nConfirmer ?`,
          pending_action: { id: action.id, summary },
        });
      }

      const responses: Part[] = [];
      for (const c of calls) {
        const { name, args } = c.functionCall;
        let response: unknown;
        try {
          response = { resultat: await runReadTool(db, name, args ?? {}) };
        } catch (e) {
          response = { erreur: e instanceof Error ? e.message : String(e) };
        }
        responses.push({ functionResponse: { name, response } });
      }
      contents.push({ role: "user", parts: responses });
    }
    // Trop d'étapes : on force une réponse sans outils
    const parts = await gemini(system, contents, false, stepTimeout);
    return json({ reply: parts.map((p) => p.text ?? "").join("").trim() });
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
