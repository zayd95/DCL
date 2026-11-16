// ═════════════════════════════════════════════════════════════════════════════
// Edge Function : bot Telegram DEPOTEK (fichier autonome, déployable tel quel)
//
//   • ?setup=1 (avec x-cron-secret) : enregistre le webhook auprès de Telegram et
//     mémorise le nom du bot pour l'app.
//   • Webhook (en-tête secret Telegram vérifié en base) :
//       /start CODE   → lie le compte Telegram au profil DEPOTEK (code généré dans l'app)
//       photo / PDF   → déposé comme document : le moteur le lit et prépare l'action
//       boutons       → Valider / Refuser une tâche, avec les droits de l'utilisateur lié
// ═════════════════════════════════════════════════════════════════════════════
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const API = `https://api.telegram.org/bot${TOKEN}`;
const FILES = `https://api.telegram.org/file/bot${TOKEN}`;

// deno-lint-ignore no-explicit-any
type Any = Record<string, any>;

const ok = () => new Response("ok");
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function tg(method: string, payload: Any): Promise<Any> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

const say = (chat_id: number | string, text: string) => tg("sendMessage", { chat_id, text });

async function profileByChat(admin: SupabaseClient, chatId: number) {
  const { data } = await admin.from("profiles").select("id, full_name, role").eq("telegram_chat_id", String(chatId)).maybeSingle();
  return data;
}

async function setup(admin: SupabaseClient, secret: string): Promise<Response> {
  if (!TOKEN) return json({ error: "TELEGRAM_BOT_TOKEN non configuré" }, 400);
  const me = await tg("getMe", {});
  if (!me.ok) return json({ error: "Token Telegram invalide", detail: me }, 400);
  const hook = await tg("setWebhook", {
    url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram`,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  await admin.from("app_settings").upsert({ key: "telegram_bot", value: me.result.username, updated_at: new Date().toISOString() });
  await tg("setMyCommands", { commands: [{ command: "start", description: "Lier mon compte DEPOTEK" }] });
  return json({ bot: me.result.username, webhook: hook.ok });
}

async function linkAccount(admin: SupabaseClient, chatId: number, code: string) {
  const { data: link } = await admin.from("telegram_links").select("*").eq("code", code.trim().toUpperCase()).maybeSingle();
  if (!link || new Date(link.expires_at) < new Date()) {
    return say(chatId, "Code invalide ou expiré. Générez-en un nouveau dans DEPOTEK → Réglages → Notifications.");
  }
  await admin.from("profiles").update({ telegram_chat_id: String(chatId) }).eq("id", link.user_id);
  await admin.from("telegram_links").delete().eq("user_id", link.user_id);
  const { data: p } = await admin.from("profiles").select("full_name").eq("id", link.user_id).single();
  return say(chatId,
    `✅ Compte lié${p?.full_name ? ` : ${p.full_name}` : ""}.\n\n` +
    "Vous recevrez ici les alertes du moteur DEPOTEK, avec des boutons pour valider.\n" +
    "Envoyez-moi aussi vos factures fournisseurs ou reçus Wave / OM en photo : je les lis et je prépare la saisie.");
}

async function receiveFile(admin: SupabaseClient, chatId: number, msg: Any) {
  const user = await profileByChat(admin, chatId);
  if (!user) return say(chatId, "Ce compte Telegram n'est pas lié. Ouvrez DEPOTEK → Réglages → Notifications.");

  const photo = msg.photo?.[msg.photo.length - 1];
  const file = photo ?? msg.document;
  const mime: string = photo ? "image/jpeg" : (msg.document?.mime_type ?? "application/octet-stream");
  if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(mime)) {
    return say(chatId, "Format non pris en charge. Envoyez une photo ou un PDF.");
  }
  const info = await tg("getFile", { file_id: file.file_id });
  if (!info.ok) return say(chatId, "Impossible de récupérer le fichier, réessayez.");
  const bytes = new Uint8Array(await (await fetch(`${FILES}/${info.result.file_path}`)).arrayBuffer());

  const ext = mime === "application/pdf" ? "pdf" : mime.split("/")[1];
  const path = `${user.id}/telegram-${Date.now()}.${ext}`;
  const up = await admin.storage.from("documents").upload(path, bytes, { contentType: mime });
  if (up.error) return say(chatId, `Échec de l'enregistrement : ${up.error.message}`);
  await admin.from("documents").insert({ storage_path: path, mime, source: "telegram", uploaded_by: user.id });
  return say(chatId, "📄 Document reçu. Je le lis et je vous envoie ce que je propose d'enregistrer.");
}

async function decide(admin: SupabaseClient, cb: Any) {
  const chatId = cb.message?.chat?.id;
  const user = chatId ? await profileByChat(admin, chatId) : null;
  if (!user) return tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Compte non lié", show_alert: true });

  const [kind, taskId] = String(cb.data ?? "").split(":");
  const { data, error } = await admin.rpc("decide_task", {
    p_task: taskId, p_decision: kind === "v" ? "valider" : "refuser", p_as_user: user.id,
  });
  const r = (data ?? {}) as Any;
  const line = error ? `⚠️ ${error.message}`
    : r.message === "Déjà traitée" ? `ℹ️ Déjà traitée (${r.status})`
    : r.status === "validee" ? `✅ Validé par ${user.full_name || "vous"}${summary(r.result)}`
    : r.status === "echec" ? `⚠️ Échec : ${r.error}`
    : `✖ Refusé par ${user.full_name || "vous"}`;

  await tg("answerCallbackQuery", { callback_query_id: cb.id, text: line.slice(0, 190) });
  // On retire les boutons Valider/Refuser mais on garde les liens (WhatsApp, app)
  const kept = (cb.message?.reply_markup?.inline_keyboard ?? [])
    .map((row: Any[]) => row.filter((b) => b.url)).filter((row: Any[]) => row.length);
  return tg("editMessageText", {
    chat_id: chatId, message_id: cb.message.message_id,
    text: `${cb.message.text}\n\n${line}`.slice(0, 4000),
    reply_markup: { inline_keyboard: kept }, disable_web_page_preview: true,
  });
}

function summary(res: Any): string {
  if (!res) return "";
  if (res.number) return ` — bon de commande ${res.number} créé`;
  if (Array.isArray(res)) return ` — ${res.length} lot(s) réceptionné(s)`;
  if (res.remaining_balance_xof != null) return ` — reste dû ${Math.round(res.remaining_balance_xof).toLocaleString("fr-FR")} FCFA`;
  return "";
}

Deno.serve(async (req) => {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const url = new URL(req.url);

  if (url.searchParams.get("setup") === "1") {
    const secret = req.headers.get("x-cron-secret") ?? "";
    const { data: valid } = secret ? await admin.rpc("verify_cron_secret", { p: secret }) : { data: false };
    if (!valid) return json({ error: "Non autorisé" }, 401);
    return setup(admin, secret);
  }

  // Webhook : Telegram renvoie le secret fixé au setup
  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  const { data: valid } = secret ? await admin.rpc("verify_cron_secret", { p: secret }) : { data: false };
  if (!valid) return new Response("Non autorisé", { status: 401 });

  const update = await req.json().catch(() => ({})) as Any;
  try {
    if (update.callback_query) await decide(admin, update.callback_query);
    const msg = update.message;
    if (msg?.chat?.id) {
      const text: string = msg.text ?? "";
      if (text.startsWith("/start")) {
        const code = text.split(" ")[1];
        if (code) await linkAccount(admin, msg.chat.id, code);
        else await say(msg.chat.id, "Bienvenue sur DEPOTEK. Pour lier votre compte : DEPOTEK → Réglages → Notifications → Telegram.");
      } else if (msg.photo || msg.document) {
        await receiveFile(admin, msg.chat.id, msg);
      } else {
        await say(msg.chat.id, "Envoyez-moi une photo de facture fournisseur ou de reçu de paiement. Pour poser une question, utilisez l'Assistant dans l'app.");
      }
    }
  } catch (e) {
    console.error(e);
  }
  return ok();  // Toujours 200 : sinon Telegram renvoie le même message en boucle
});
