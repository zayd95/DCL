// ═════════════════════════════════════════════════════════════════════════════
// Edge Function : moteur DEPOTEK (fichier autonome, déployable tel quel)
//
// Réveillé (en-tête x-cron-secret vérifié en base) :
//   • dans la seconde après chaque mouvement de stock, paiement ou document (triggers) ;
//   • toutes les 15 minutes par pg_cron (ronde).
// À chaque passage :
//   1. lit les documents en attente (Gemini) et prépare l'action correspondante ;
//   2. lance les règles de surveillance (engine_scan) ;
//   3. notifie les nouvelles tâches : Telegram (boutons Valider / Ignorer) et iPhone (Web Push).
// ═════════════════════════════════════════════════════════════════════════════
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { buildDocumentTask, telegramMessage } from "./logic.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

// Modèles essayés dans l'ordre (offre gratuite) : on passe au suivant si un modèle est retiré, saturé ou trop lent.
const GEMINI_MODELS = [
  ...(Deno.env.get("GEMINI_MODEL") ? [Deno.env.get("GEMINI_MODEL")!] : []),
  "gemini-3.8-flash", "gemini-flash-lite-latest", "gemini-flash-latest",
];
const GEMINI_TIMEOUT_MS = 45000;
async function geminiCall(key: string, body: Record<string, unknown>): Promise<Response> {
  let last: Response | null = null;
  let lastErr = "";
  for (const m of GEMINI_MODELS) {
    // Réflexion minimale : réponses rapides (les modèles 3.x acceptent thinkingLevel)
    const gen = { ...(body.generationConfig as Record<string, unknown> ?? {}) };
    if (m.startsWith("gemini-3")) gen.thinkingConfig = { thinkingLevel: "low" };
    const t0 = Date.now();
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ ...body, generationConfig: gen }),
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      });
      console.log(`gemini ${m} ${res.status} ${Date.now() - t0}ms`);
      if (res.ok || ![400, 404, 429, 500, 503].includes(res.status)) return res;
      last = res;
    } catch (e) {
      lastErr = (e as Error).name === "TimeoutError" ? `délai dépassé (${m})` : (e as Error).message;
      console.log(`gemini ${m} échec ${Date.now() - t0}ms : ${lastErr}`);
    }
  }
  if (last) return last;
  throw new Error(`Gemini indisponible : ${lastErr}`);
}
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://depotek.vercel.app";

// deno-lint-ignore no-explicit-any
type Any = Record<string, any>;
type Role = "magasinier" | "manager" | "cfo" | "admin";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });


// ─── 1. Lecture des documents ────────────────────────────────────────────────

const DOC_SCHEMA = {
  type: "OBJECT",
  properties: {
    type: { type: "STRING", enum: ["facture_fournisseur", "recu_paiement", "bon_commande", "autre"] },
    fournisseur: { type: "STRING", nullable: true },
    reference: { type: "STRING", nullable: true, description: "N° de facture, de reçu ou de transaction" },
    conteneur: { type: "STRING", nullable: true },
    devise: { type: "STRING", nullable: true, enum: ["XOF", "EUR", "USD"] },
    date: { type: "STRING", nullable: true, description: "AAAA-MM-JJ" },
    lignes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          description: { type: "STRING" },
          sku: { type: "STRING", nullable: true, description: "SKU du catalogue correspondant, ou null si incertain" },
          quantite: { type: "NUMBER" },
          lot: { type: "STRING", nullable: true },
          expiration: { type: "STRING", nullable: true, description: "AAAA-MM-JJ" },
          cout_unitaire: { type: "NUMBER", nullable: true },
        },
        required: ["description", "quantite"],
      },
    },
    client: { type: "STRING", nullable: true, description: "Nom exact du client du répertoire (reçus, bons de commande)" },
    montant: { type: "NUMBER", nullable: true },
    mode: { type: "STRING", nullable: true, enum: ["especes", "wave", "orange_money", "virement", "cheque", "autre"] },
    confiance: { type: "NUMBER", description: "0 à 1 : certitude globale de la lecture" },
    remarques: { type: "STRING", nullable: true },
  },
  required: ["type", "confiance"],
};

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function readDocument(admin: SupabaseClient, doc: Any): Promise<void> {
  const fail = (error: string) => admin.from("documents").update({ status: "erreur", error }).eq("id", doc.id);

  const file = await admin.storage.from("documents").download(doc.storage_path);
  if (file.error || !file.data) return void await fail(file.error?.message ?? "Fichier introuvable");
  const bytes = new Uint8Array(await file.data.arrayBuffer());

  const [{ data: products }, { data: clients }] = await Promise.all([
    admin.from("products").select("sku,name,unit_type").eq("active", true),
    admin.from("clients").select("name").eq("active", true),
  ]);
  const prompt = `Tu lis un document pour ODS, importateur de produits congelés à Dakar (viande, abats, volaille, poisson, fromage).
Identifie son type : facture fournisseur (marchandise reçue), reçu de paiement d'un client (Wave, Orange Money, virement…),
bon de commande d'un client, ou autre. Extrais les données. N'invente rien : mets null si une valeur est illisible ou absente.
Pour chaque ligne de produit, choisis le SKU du catalogue qui correspond (même si le libellé est en anglais),
ou null si tu n'es pas sûr. Pour un reçu, choisis le client exact dans le répertoire.
Catalogue : ${JSON.stringify(products ?? [])}
Clients : ${JSON.stringify((clients ?? []).map((c) => c.name))}`;

  const res = await geminiCall(GEMINI_API_KEY, {
      contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: doc.mime, data: toBase64(bytes) } }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: DOC_SCHEMA },
    });
  if (!res.ok) return void await fail(`Gemini ${res.status} : ${(await res.text()).slice(0, 200)}`);
  const out = await res.json();
  let x: Any;
  try {
    x = JSON.parse(out?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}");
  } catch {
    return void await fail("Réponse illisible");
  }

  const task = buildDocumentTask(doc, x, new Set((products ?? []).map((p) => p.sku)));
  const { data: t, error } = await admin.from("tasks").insert(task).select("id").single();
  if (error) return void await fail(error.message);
  await admin.from("documents").update({ status: "lu", doc_type: x.type, extracted: x, task_id: t.id }).eq("id", doc.id);
}

// ─── 3. Notifications ────────────────────────────────────────────────────────

async function telegram(method: string, payload: Any): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN) return false;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error("Telegram", method, res.status, await res.text());
  return res.ok;
}

async function ensureVapid(admin: SupabaseClient): Promise<{ public: string; private: string } | null> {
  const { data } = await admin.rpc("vapid_keys");
  if (data?.public && data?.private) return data;
  const keys = webpush.generateVAPIDKeys();
  const { error } = await admin.rpc("vapid_store", { p_public: keys.publicKey, p_private: keys.privateKey });
  if (error) { console.error("VAPID", error.message); return null; }
  const again = await admin.rpc("vapid_keys");
  return again.data?.public ? again.data : null;
}

async function notify(admin: SupabaseClient): Promise<number> {
  // Réservation atomique : deux passages simultanés ne notifient jamais deux fois
  const { data: tasks } = await admin.from("tasks").update({ notified_at: new Date().toISOString() })
    .is("notified_at", null).eq("status", "ouverte").select("*");
  if (!tasks?.length) return 0;

  const { data: people } = await admin.from("profiles").select("id, role, telegram_chat_id");
  const { data: subs } = await admin.from("push_subscriptions").select("*");
  const vapid = subs?.length ? await ensureVapid(admin) : null;
  if (vapid) webpush.setVapidDetails("mailto:depotek@ods.sn", vapid.public, vapid.private);

  for (const t of tasks) {
    const who = (people ?? []).filter((p) => p.role === "admin" || (t.audience as Role[]).includes(p.role));
    const ids = new Set(who.map((p) => p.id));
    for (const p of who) if (p.telegram_chat_id) await telegram("sendMessage", { chat_id: p.telegram_chat_id, ...telegramMessage(t, APP_URL) });
    if (vapid) {
      for (const s of (subs ?? []).filter((s) => ids.has(s.user_id))) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify({ title: t.title, body: String(t.body).slice(0, 180), url: `${APP_URL}/?tache=${t.id}`, tag: t.id }),
            { TTL: 86400 },
          );
        } catch (e) {
          // Abonnement expiré (iPhone réinitialisé, app désinstallée) : on le retire
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("id", s.id);
          else console.error("Push", code, (e as Error).message);
        }
      }
    }
  }
  return tasks.length;
}

// ─── Point d'entrée ──────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const secret = req.headers.get("x-cron-secret") ?? "";
  const { data: valid } = secret ? await admin.rpc("verify_cron_secret", { p: secret }) : { data: false };
  if (!valid) return json({ error: "Non autorisé" }, 401);

  const report: Any = { documents: 0, tasks_created: 0, notified: 0 };

  // Les clés de notification iPhone doivent exister avant que l'app puisse s'abonner
  report.push_ready = !!(await ensureVapid(admin));

  // 1. Documents en attente
  const { data: docs } = await admin.from("documents").select("*").eq("status", "a_lire").order("created_at").limit(3);
  if (docs?.length && !GEMINI_API_KEY) {
    await admin.from("tasks").upsert({
      kind: "anomalie", severity: "warning", dedupe_key: "config:gemini",
      title: "Lecture des documents en attente",
      body: `${docs.length} document(s) reçu(s), mais la clé Gemini n'est pas configurée (Supabase → Edge Functions → Secrets → GEMINI_API_KEY).`,
    }, { onConflict: "dedupe_key", ignoreDuplicates: true });
  } else {
    for (const d of docs ?? []) {
      // Réservation : un seul passage lit chaque document
      const { data: claimed } = await admin.from("documents").update({ status: "lu" })
        .eq("id", d.id).eq("status", "a_lire").select("id");
      if (!claimed?.length) continue;
      try { await readDocument(admin, d); report.documents++; } catch (e) {
        await admin.from("documents").update({ status: "erreur", error: (e as Error).message }).eq("id", d.id);
      }
    }
  }

  // 2. Règles de surveillance
  const scan = await admin.rpc("engine_scan");
  if (scan.error) report.scan_error = scan.error.message; else report.tasks_created = scan.data;

  // 3. Notifications
  report.notified = await notify(admin);
  return json(report);
});
