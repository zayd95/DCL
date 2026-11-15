// ═════════════════════════════════════════════════════════════════════════════
// Edge Function : briefing du matin
//
// Appelée chaque jour à 7 h par pg_cron (voir supabase/cron.sql), avec
// l'en-tête  x-cron-secret: <CRON_SECRET>.
//   1. génère les alertes du jour (FEFO, réappro, impayés)
//   2. construit le briefing et l'envoie sur Telegram aux managers / CFO / admin
//      qui ont renseigné leur telegram_chat_id
//   3. l'enregistre comme alerte "info" (visible dans l'app)
// Avec ?dry=1 : renvoie le texte sans rien envoyer.
// ═════════════════════════════════════════════════════════════════════════════
import { createClient } from "npm:@supabase/supabase-js@2";
import { briefingText, json } from "../_shared/format.ts";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

async function sendTelegram(chatId: string, text: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN) return false;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) console.error("Telegram", chatId, res.status, await res.text());
  return res.ok;
}

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return json({ error: "Non autorisé" }, 401);
  }
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const alerts = await admin.rpc("generate_alerts");
  if (alerts.error) return json({ error: alerts.error.message }, 500);

  const { data: briefing, error } = await admin.rpc("daily_briefing");
  if (error) return json({ error: error.message }, 500);
  const text = briefingText(briefing);
  if (dry) return json({ text, alerts_created: alerts.data });

  const { data: recipients } = await admin.from("profiles").select("full_name, telegram_chat_id")
    .in("role", ["manager", "cfo", "admin"]).not("telegram_chat_id", "is", null);
  let sent = 0;
  for (const r of recipients ?? []) if (await sendTelegram(r.telegram_chat_id, text)) sent++;

  await admin.from("alerts").insert({
    level: "info", kind: "briefing", title: "Briefing du matin", body: text,
    dedupe_key: `briefing:${briefing.date}`,
  });
  return json({ ok: true, sent, alerts_created: alerts.data });
});
