// Бот «Зимний поход»: регистрация по контакту, кнопка мини-аппа после регистрации.
// Секрет TELEGRAM_BOT_TOKEN задаётся в Supabase → Edge Functions → Secrets. В коде токена нет.
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const API = `https://api.telegram.org/bot${TOKEN}/`;

async function tg(method: string, body: unknown) {
  const r = await fetch(API + method, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
async function hookSecret() {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hook:" + TOKEN));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
async function texts() {
  const { data } = await db.from("messages").select("key,text,photo_url");
  const m: Record<string, { text: string; photo_url: string | null }> = {};
  for (const r of data ?? []) m[r.key] = r;
  return m;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function openApp(chat: number, m: Awaited<ReturnType<typeof texts>>) {
  const label = m.app_button?.text || "платформа", url = m.app_url?.text;
  if (url) await tg("setChatMenuButton", { chat_id: chat, menu_button: { type: "web_app", text: label, web_app: { url } } });
  // 3) Билет + кнопка канала
  const reg = m.registered?.text ?? "";
  const chBtn = m.channel_button?.text && m.channel_url?.text ? { inline_keyboard: [[{ text: m.channel_button.text, url: m.channel_url.text }]] } : undefined;
  if (reg) {
    let ok = false;
    if (m.registered?.photo_url && reg.length <= 1024) ok = (await tg("sendPhoto", { chat_id: chat, photo: m.registered.photo_url, caption: reg, parse_mode: "HTML", reply_markup: chBtn })).ok;
    if (!ok) await tg("sendMessage", { chat_id: chat, text: reg, parse_mode: "HTML", reply_markup: chBtn, link_preview_options: { is_disabled: true } });
  }
  // 4) Платформа + кнопка мини-аппа
  const plat = m.platform?.text ?? "";
  if (plat && url) {
    const kb = { inline_keyboard: [[{ text: label, web_app: { url } }]] };
    let ok2 = false;
    if (m.platform?.photo_url && plat.length <= 1024) ok2 = (await tg("sendPhoto", { chat_id: chat, photo: m.platform.photo_url, caption: plat, parse_mode: "HTML", reply_markup: kb })).ok;
    if (!ok2) await tg("sendMessage", { chat_id: chat, text: plat, parse_mode: "HTML", reply_markup: kb });
  }
}

// Рассылки от рассыльщика (participants.broadcaster): любое сообщение — черновик,
// к нему можно добавить кнопки (ссылка / платформа / канал / аккаунт / скопировать текст),
// «Разослать всем» — копия сообщения (или альбома) с кнопками уходит всем зарегистрированным через очередь broadcasts.
const SEND = "✅ Разослать всем", CANCEL = "✖️ Отмена", ADDBTN = "➕ Добавить кнопку", CLEARBTN = "🗑 Убрать кнопки";
const BTN_HELP = [
  "Пришли кнопку одной строкой: <b>Текст — куда ведёт</b>",
  "",
  "Куда может вести:",
  "• ссылка — <code>Смотреть урок — https://youtu.be/…</code>",
  "• платформа (мини-апп) — <code>Открыть платформу — платформа</code>",
  "• канал похода — <code>Зайти в канал — канал</code>",
  "• Telegram-аккаунт — <code>Написать Алине — @username</code>",
  "• скопировать текст — <code>Промокод — копировать: WINTER10</code>",
  "",
  "В текст кнопки можно добавить эмодзи: <code>🏔 Открыть платформу — платформа</code>",
  "Две кнопки в одном ряду — через «|»:",
  "<code>🎞 Урок — https://… | 🔥 Канал — канал</code>",
].join("\n");
function parseButton(part: string, m: Record<string, { text: string }>) {
  const t = part.trim();
  const mm = t.match(/^(.+?)\s+[—–-]\s+(.+)$/s);
  if (!mm) return null;
  const text = mm[1].trim().slice(0, 64), target = mm[2].trim();
  if (!text) return null;
  const b: Record<string, unknown> = { text };
  const low = target.toLowerCase();
  const app = m.app_url?.text, ch = m.channel_url?.text;
  if (/^(платформа|мини-?апп|мини апп|приложение)$/.test(low) && app) b.web_app = { url: app };
  else if (/^канал$/.test(low) && ch) b.url = ch;
  else if (/^копировать\s*:/.test(low)) { const v = target.replace(/^копировать\s*:\s*/i, "").slice(0, 256); if (!v) return null; b.copy_text = { text: v }; }
  else if (/^@[A-Za-z0-9_]{4,32}$/.test(target)) b.url = "https://t.me/" + target.slice(1);
  else if (/^https?:\/\/\S+$/i.test(target)) b.url = target;
  else if (/^t\.me\/\S+$/i.test(target)) b.url = "https://" + target;
  else return null;
  return b;
}
async function onBroadcaster(msg: any, chat: number, m: Record<string, { text: string }>) {
  const from = msg.from;
  const reply = (text: string, keyboard?: unknown, html = false) =>
    tg("sendMessage", { chat_id: chat, text, ...(html ? { parse_mode: "HTML" } : {}), reply_markup: keyboard ?? { remove_keyboard: true } });
  const regCount = async () => (await db.from("participants").select("tg_id", { count: "exact", head: true }).eq("blocked", false).not("registered_at", "is", null)).count ?? 0;
  const menu = (hasButtons: boolean) => ({
    keyboard: [[{ text: SEND }], [{ text: ADDBTN }], hasButtons ? [{ text: CLEARBTN }, { text: CANCEL }] : [{ text: CANCEL }]],
    resize_keyboard: true,
  });
  const { data: d } = await db.from("broadcast_drafts").select("chat_id,message_id,message_ids,buttons,awaiting_button").eq("tg_id", from.id).maybeSingle();
  const isAlbum = (d?.message_ids?.length ?? 0) > 1;
  const preview = async (buttons: unknown[]) => {
    if (!d) return;
    await reply("Вот так это увидят участницы 👇");
    const body: any = { chat_id: chat, from_chat_id: d.chat_id, message_id: d.message_id, ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}) };
    let r = await tg("copyMessage", body);
    if (!r.ok && buttons.length) {
      console.error("preview", r);
      r = await tg("copyMessage", { ...body, reply_markup: { inline_keyboard: (buttons as any[]).map((row) => row.map(({ style: _s, ...b }: any) => b)) } });
    }
  };

  if (msg.text === CANCEL) {
    await db.from("broadcast_drafts").delete().eq("tg_id", from.id);
    await reply("Отменено, ничего не отправлено.");
    return;
  }
  if (msg.text === SEND) {
    if (!d) { await reply("Черновика нет. Пришли сообщение, которое нужно разослать."); return; }
    const count = await regCount();
    const { error } = await db.from("broadcasts").insert({
      send_at: new Date().toISOString(), text: "", audience: "registered",
      copy_chat_id: d.chat_id, copy_message_id: d.message_id,
      copy_message_ids: isAlbum ? d.message_ids : null,
      buttons: !isAlbum && (d.buttons?.length ?? 0) > 0 ? d.buttons : null,
      note: "из бота от " + (from.username ? "@" + from.username : from.id),
    });
    if (error) { console.error(error); await reply("Не получилось поставить рассылку. Попробуй ещё раз через минуту."); return; }
    await db.from("broadcast_drafts").delete().eq("tg_id", from.id);
    await reply(`Рассылка запущена: получат ${count} зарегистрированных. Отправка начнётся в течение минуты.`);
    return;
  }
  if (msg.text === ADDBTN) {
    if (!d) { await reply("Сначала пришли сообщение для рассылки, потом добавим к нему кнопки."); return; }
    if (isAlbum) { await reply("К альбому Telegram не даёт прикрепить кнопки. Можно разослать альбом, а следом — отдельное сообщение с текстом и кнопками.", menu(false)); return; }
    if ((d.buttons?.length ?? 0) >= 8) { await reply("Больше 8 рядов кнопок не получится.", menu(true)); return; }
    await db.from("broadcast_drafts").update({ awaiting_button: true }).eq("tg_id", from.id);
    await reply(BTN_HELP, { keyboard: [[{ text: CANCEL }]], resize_keyboard: true }, true);
    return;
  }
  if (msg.text === CLEARBTN && d) {
    await db.from("broadcast_drafts").update({ buttons: [], awaiting_button: false }).eq("tg_id", from.id);
    await preview([]);
    await reply("Кнопки убраны. Отправить?", menu(false));
    return;
  }
  if (d?.awaiting_button && typeof msg.text === "string") {
    const row = msg.text.split("|").map((x: string) => parseButton(x, m));
    if (!row.length || row.some((b: unknown) => !b) || row.length > 4) {
      await reply("Не поняла кнопку 🙈 Проверь формат — текст, пробел, тире, пробел, куда ведёт.\n\n" + BTN_HELP, { keyboard: [[{ text: CANCEL }]], resize_keyboard: true }, true);
      return;
    }
    const buttons = [...(d.buttons ?? []), row];
    await db.from("broadcast_drafts").update({ buttons, awaiting_button: false }).eq("tg_id", from.id);
    await preview(buttons);
    const r = await reply(`Кнопка добавлена. Отправить ${await regCount()} зарегистрированным? Можно добавить ещё кнопку.`, menu(true));
    if (!r.ok) console.error(r);
    return;
  }
  // Новое сообщение — новый черновик. Альбом приходит несколькими сообщениями с одним media_group_id — собираем их вместе
  const { data: first, error: de } = await db.rpc("draft_add", { p_tg: from.id, p_chat: chat, p_msg: msg.message_id, p_group: msg.media_group_id ?? null });
  if (de) { console.error(de); await reply("Не получилось сохранить черновик. Пришли ещё раз."); return; }
  if (!first) return;
  await tg("sendMessage", {
    chat_id: chat, reply_to_message_id: msg.message_id,
    text: `${msg.media_group_id ? "Этот альбом" : "Это сообщение"} получат ${await regCount()} зарегистрированных участниц — ровно в таком виде. Отправить?\n\nМожно добавить кнопки. Если нужно поправить текст — просто пришли новый вариант.`,
    reply_markup: menu(false),
  });
}

// Канал похода: бот — админ канала. Узнаём id канала, когда бота добавляют или меняют ему права,
// и отмечаем у участниц, кто вступил в канал и кто вышел (participants.in_channel).
const IN = new Set(["member", "administrator", "creator", "restricted"]);
async function channelId(): Promise<number | null> {
  const { data } = await db.from("messages").select("text").eq("key", "channel_id").maybeSingle();
  const id = Number(data?.text); return Number.isSafeInteger(id) && id < 0 ? id : null;
}
async function checkMember(ch: number, userId: number) {
  const r = await tg("getChatMember", { chat_id: ch, user_id: userId });
  if (!r.ok) return;
  const inside = IN.has(r.result?.status) && r.result?.is_member !== false;
  await db.from("participants").update({ in_channel: inside }).eq("tg_id", userId);
}
async function syncChannel(ch: number) {
  // Разом проверяем всех зарегистрированных, у кого ещё нет отметки
  const { data: rows } = await db.from("participants").select("tg_id").not("registered_at", "is", null).is("in_channel", null).limit(3000);
  for (const r of rows ?? []) { await checkMember(ch, r.tg_id); await new Promise((ok) => setTimeout(ok, 40)); }
}

async function onUpdate(u: any) {
  const msg = u.message;
  if (u.my_chat_member && u.my_chat_member.chat?.type === "channel") {
    const st = u.my_chat_member.new_chat_member?.status;
    if (st === "administrator") {
      await db.from("messages").upsert({ key: "channel_id", text: String(u.my_chat_member.chat.id), note: "id канала похода; бот записывает сам" });
      await syncChannel(u.my_chat_member.chat.id);
    }
    return;
  }
  if (u.chat_member && u.chat_member.chat?.type === "channel") {
    const ch = await channelId();
    if (ch && u.chat_member.chat.id !== ch) return;
    const userId = u.chat_member.new_chat_member?.user?.id, st = u.chat_member.new_chat_member?.status;
    if (!userId) return;
    const inside = IN.has(st) && u.chat_member.new_chat_member?.is_member !== false;
    const now = new Date().toISOString();
    await db.from("participants").update(inside ? { in_channel: true, channel_joined_at: now } : { in_channel: false, channel_left_at: now }).eq("tg_id", userId);
    return;
  }
  if (u.my_chat_member) {
    const st = u.my_chat_member.new_chat_member?.status;
    await db.from("participants").update({ blocked: st === "kicked" }).eq("tg_id", u.my_chat_member.chat.id);
    return;
  }
  if (!msg || msg.chat?.type !== "private") return;
  const from = msg.from, chat = msg.chat.id;
  const m = await texts();

  if (msg.contact) {
    if (msg.contact.user_id !== from.id) return;
    const { data: p } = await db.from("participants").select("registered_at").eq("tg_id", from.id).maybeSingle();
    await db.from("participants").upsert({
      tg_id: from.id, first_name: from.first_name ?? null, last_name: from.last_name ?? null,
      username: from.username ?? null, phone: msg.contact.phone_number, blocked: false,
      registered_at: p?.registered_at ?? new Date().toISOString(),
    });
    await openApp(chat, m);
    const ch = await channelId();
    if (ch) await checkMember(ch, from.id);
    return;
  }

  if (!(typeof msg.text === "string" && msg.text.startsWith("/start"))) {
    const { data: me } = await db.from("participants").select("broadcaster").eq("tg_id", from.id).maybeSingle();
    if (me?.broadcaster) { await onBroadcaster(msg, chat, m); return; }
  }

  if (typeof msg.text === "string" && msg.text.startsWith("/start")) {
    await db.from("participants").upsert(
      { tg_id: from.id, first_name: from.first_name ?? null, last_name: from.last_name ?? null, username: from.username ?? null, blocked: false },
      { onConflict: "tg_id", ignoreDuplicates: true },
    );
    // Источник для аналитики: метка из ссылки t.me/бот?start=метка. Запоминается первая.
    const payload = msg.text.split(/\s+/)[1] ?? "";
    if (/^[A-Za-z0-9_-]{1,64}$/.test(payload)) await db.from("participants").update({ source: payload }).eq("tg_id", from.id).is("source", null);
    // Режим команды: пока не наступило время admin_until, все, кто нажал /start, отмечаются как админы
    const until = Date.parse(m.admin_until?.text ?? "");
    if (until && Date.now() < until) await db.from("participants").update({ is_admin: true }).eq("tg_id", from.id);
    const { data: p } = await db.from("participants").select("registered_at,is_admin").eq("tg_id", from.id).maybeSingle();
    if (p?.registered_at && !p?.is_admin) { await openApp(chat, m); return; }
    const keyboard = { keyboard: [[{ text: m.contact_button?.text || "поделиться контактом", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
    // 1) Приветствие с картинкой
    const w = m.welcome?.text ?? "";
    let sent = false;
    if (m.welcome?.photo_url && w.length <= 1024) sent = (await tg("sendPhoto", { chat_id: chat, photo: m.welcome.photo_url, caption: w, parse_mode: "HTML" })).ok;
    if (!sent && w) await tg("sendMessage", { chat_id: chat, text: w, parse_mode: "HTML" });
    // 2) «Что нас ожидает на пути» — две картинки альбомом
    const photos = (m.path_photos?.text ?? "").split(/\s*,\s*/).filter(Boolean);
    if (photos.length > 1) await tg("sendMediaGroup", { chat_id: chat, media: photos.map((u) => ({ type: "photo", media: u })) });
    else if (photos.length === 1) await tg("sendPhoto", { chat_id: chat, photo: photos[0] });
    // 3) Текст с согласием (ссылка на политику) и кнопкой «поделиться контактом»
    const anchor = m.privacy?.text || "политикой конфиденциальности";
    let t = m.path?.text ?? "";
    if (m.privacy_url?.text && !t.includes("<a ")) t = t.replace(esc(anchor), `<a href="${esc(m.privacy_url.text)}">${esc(anchor)}</a>`);
    await tg("sendMessage", { chat_id: chat, text: t || "👇🏻", parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } });
  }
}

// Проверка регистрации из мини-аппа: подпись initData от Telegram + наличие регистрации в таблице
const ORIGIN = "https://alinasolopovawork-sudo.github.io";
const cors = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
async function hmac(key: Uint8Array, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}
async function checkInit(initData: string) {
  const p = new URLSearchParams(initData), hash = p.get("hash") ?? "";
  p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), TOKEN);
  const sig = [...await hmac(secret, dcs)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!hash || sig !== hash) return { ok: false, registered: false };
  const user = JSON.parse(p.get("user") ?? "{}");
  const { data } = await db.from("participants").select("registered_at,is_admin").eq("tg_id", user.id).maybeSingle();
  return { ok: true, registered: !!data?.registered_at, admin: !!data?.is_admin };
}

Deno.serve(async (req) => {
  if (!TOKEN) return new Response("TELEGRAM_BOT_TOKEN is not set", { status: 500 });
  const url = new URL(req.url);
  const secret = await hookSecret();
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method === "POST" && url.searchParams.has("check")) {
    try { const b = await req.json(); return Response.json(await checkInit(String(b.initData ?? "")), { headers: cors }); }
    catch { return Response.json({ ok: false, registered: false }, { headers: cors }); }
  }
  if (req.method === "GET" && url.searchParams.has("diag")) {
    const names = Object.keys(Deno.env.toObject()).filter((k) => k.startsWith("SUPABASE"));
    const r = await db.from("messages").select("key").limit(3);
    return Response.json({ env: names, rows: r.data?.length ?? null, error: r.error?.message ?? null });
  }
  if (req.method === "GET" && url.searchParams.has("syncchannel")) {
    const ch = await channelId();
    if (!ch) return Response.json({ ok: false, error: "канал ещё не известен" });
    await syncChannel(ch);
    return Response.json({ ok: true });
  }
  if (req.method === "GET" && url.searchParams.has("setup")) {
    const self = `${Deno.env.get("SUPABASE_URL")}/functions/v1/bot`;
    const a = await tg("setWebhook", { url: self, secret_token: secret, allowed_updates: ["message", "my_chat_member", "chat_member"], drop_pending_updates: true });
    const b = await tg("setChatMenuButton", { menu_button: { type: "commands" } });
    const me = await tg("getMe", {});
    return Response.json({ webhook: a.ok, menu_default_commands: b.ok, bot: me.result?.username ?? null });
  }
  if (req.method === "POST" && req.headers.get("x-telegram-bot-api-secret-token") === secret) {
    try { await onUpdate(await req.json()); } catch (e) { console.error(e); }
    return new Response("ok");
  }
  return new Response("not found", { status: 404 });
});
