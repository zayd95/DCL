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
  describeResult, readTools, runReadTool, runWriteTool, summarizeWrite, WRITE_TOOL_NAMES, writeTools,
} from "./tools.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
const MAX_STEPS = 6;

type Msg = { role: "user" | "model"; text: string };
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
- Pour toute écriture (vente, encaissement, réception, transfert, inventaire, client, location de chambre, déplacement de lot), appelle l'outil
  d'écriture correspondant : le système demandera lui-même la confirmation à l'utilisateur. Ne demande pas "voulez-vous confirmer".
- S'il manque une information indispensable (client, quantité, prix si aucun prix par défaut…), pose UNE question courte.
- Après une lecture, donne la réponse puis, si c'est utile, UNE recommandation concrète
  (ex. relancer un client en retard, écouler un lot qui expire, lancer une commande, libérer une chambre).
- Si un outil renvoie une erreur de droits, explique simplement que ce rôle n'y a pas accès.
- Dates au format AAAA-MM-JJ dans les appels d'outils. "Hier", "cette semaine", "ce mois" : calcule à partir de la date du jour.`;
}

async function gemini(system: string, contents: Content[], withTools = true): Promise<Part[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: withTools ? [{ functionDeclarations: [...readTools, ...writeTools] }] : undefined,
        generationConfig: { temperature: 0.2 },
      }),
    },
  );
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
  const contents: Content[] = messages.map((m) => ({ role: m.role, parts: [{ text: String(m.text ?? "") }] }));

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const parts = await gemini(system, contents);
      const calls = parts.filter((p) => p.functionCall);
      if (!calls.length) {
        const text = parts.map((p) => p.text ?? "").join("").trim();
        return json({ reply: text || "Je n'ai pas compris, pouvez-vous reformuler ?" });
      }
      contents.push({ role: "model", parts });

      // Une écriture demandée → on s'arrête et on demande confirmation
      const write = calls.find((c) => WRITE_TOOL_NAMES.has(c.functionCall.name));
      if (write) {
        const { name, args } = write.functionCall;
        const summary = summarizeWrite(name, args ?? {});
        const { data: action, error } = await db.from("assistant_actions")
          .insert({ user_id: user.id, tool: name, args: args ?? {}, summary })
          .select("id").single();
        if (error) throw new Error(error.message);
        return json({ reply: `Je m'apprête à faire :\n${summary}\n\nConfirmer ?`, pending_action: { id: action.id, summary } });
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
    const parts = await gemini(system, contents, false);
    return json({ reply: parts.map((p) => p.text ?? "").join("").trim() });
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
