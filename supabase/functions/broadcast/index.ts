// Рассылки по расписанию: вызывается каждую минуту из pg_cron. Отправляет то, чему пора, по 25 сообщений в секунду.
// Если у рассылки заполнены copy_chat_id и copy_message_id — участницам уходит копия этого сообщения (так рассылает Максим из бота).
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const API = `https://api.telegram.org/bot${TOKEN}/`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PER_RUN = 2500, PAGE = 200;

async function send(chat: number, b: any, appUrl: string) {
  let method: string, body: any;
  if (b.copy_chat_id && b.copy_message_id) {
    method = "copyMessage";
    body = { chat_id: chat, from_chat_id: b.copy_chat_id, message_id: b.copy_message_id };
  } else {
    let markup: unknown = undefined;
    if (b.button_text && b.button_url) {
      const btn = b.button_url.startsWith(appUrl) ? { text: b.button_text, web_app: { url: b.button_url } } : { text: b.button_text, url: b.button_url };
      markup = { inline_keyboard: [[btn]] };
    }
    const usePhoto = b.photo_url && b.text.length <= 1024;
    method = usePhoto ? "sendPhoto" : "sendMessage";
    body = usePhoto ? { chat_id: chat, photo: b.photo_url, caption: b.text } : { chat_id: chat, text: b.text };
    if (markup) body.reply_markup = markup;
    if (b.photo_url && !usePhoto) await fetch(API + "sendPhoto", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, photo: b.photo_url }) });
  }
  for (let i = 0; i < 3; i++) {
    const r = await (await fetch(API + method, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    if (r.ok) return "ok";
    if (r.error_code === 429) { await sleep(((r.parameters?.retry_after ?? 1) + 1) * 1000); continue; }
    if (r.error_code === 403) return "blocked";
    return "fail";
  }
  return "fail";
}

Deno.serve(async () => {
  if (!TOKEN) return new Response("TELEGRAM_BOT_TOKEN is not set", { status: 500 });
  const { data: claimed } = await db.rpc("claim_broadcast");
  const b = claimed?.[0];
  if (!b) return Response.json({ sent: 0 });
  const { data: app } = await db.from("messages").select("text").eq("key", "app_url").maybeSingle();
  const appUrl = app?.text || "https://alinasolopovawork-sudo.github.io/zimniy-pohod/";
  let cursor = b.cursor_tg_id, count = b.sent_count, done = 0, finished = false;
  while (done < PER_RUN) {
    let q = db.from("participants").select("tg_id").eq("blocked", false).gt("tg_id", cursor).order("tg_id").limit(PAGE);
    if (b.audience === "registered") q = q.not("registered_at", "is", null);
    const { data: rows } = await q;
    if (!rows?.length) { finished = true; break; }
    for (const r of rows) {
      const res = await send(r.tg_id, b, appUrl);
      if (res === "ok") count++;
      if (res === "blocked") await db.from("participants").update({ blocked: true }).eq("tg_id", r.tg_id);
      cursor = r.tg_id; done++;
      await sleep(40);
    }
    await db.from("broadcasts").update({ cursor_tg_id: cursor, sent_count: count, locked_until: new Date(Date.now() + 180000).toISOString() }).eq("id", b.id);
    if (rows.length < PAGE) { finished = true; break; }
  }
  await db.from("broadcasts").update({ cursor_tg_id: cursor, sent_count: count, status: finished ? "done" : "sending", locked_until: null }).eq("id", b.id);
  return Response.json({ id: b.id, sent: count, finished });
});
