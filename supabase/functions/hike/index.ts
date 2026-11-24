// Аналитика «Зимнего похода».
// ?track — мини-апп присылает снимок прогресса и события участницы.
// ?admin — данные для админки; только для участниц с is_admin в таблице participants.
// Подпись Telegram (initData) проверяется токеном бота из секрета TELEGRAM_BOT_TOKEN. В коде токена нет.
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ORIGIN = "https://alinasolopovawork-sudo.github.io";
const cors = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });

const EVENTS = new Set(["open", "day", "link", "remind", "claim"]);
const LINKS = new Set(["channel", "l1", "l2", "live", "exp", "bot", "other"]);
const STATUSES = new Set(["new", "contacted", "thinking", "bought", "refused"]);

async function hmac(key: Uint8Array, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}
// Возвращает id пользователя Telegram, если подпись верна и ей не больше maxAgeH часов
async function userFrom(initData: string, maxAgeH: number): Promise<number | null> {
  if (!initData || initData.length > 4096) return null;
  const p = new URLSearchParams(initData), hash = p.get("hash") ?? "";
  p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), TOKEN);
  const sig = [...await hmac(secret, dcs)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!hash || sig !== hash) return null;
  const age = Date.now() / 1000 - Number(p.get("auth_date") ?? 0);
  if (!(age < maxAgeH * 3600)) return null;
  try { const id = Number(JSON.parse(p.get("user") ?? "{}").id); return Number.isSafeInteger(id) && id > 0 ? id : null; }
  catch { return null; }
}

const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
function cleanSnap(s: any) {
  if (!s || typeof s !== "object") return null;
  const day = Number(s.day);
  const tasks: Record<string, Record<string, boolean>> = {};
  for (let d = 0; d < 5; d++) {
    const t = s.tasks?.[d] ?? s.tasks?.[String(d)];
    if (t && typeof t === "object") {
      tasks[d] = {};
      for (let i = 0; i < 10; i++) if (t[i] === true || t[String(i)] === true) tasks[d][i] = true;
    }
  }
  const done: Record<string, boolean> = {};
  for (let d = 0; d < 5; d++) if (s.done?.[d] === true || s.done?.[String(d)] === true) done[d] = true;
  return {
    day: Number.isInteger(day) && day >= 0 && day <= 5 ? day : -1,
    tasks, done,
    idea: str(s.idea, 300), video: str(s.video, 300),
    questions: Array.isArray(s.questions) ? s.questions.slice(0, 10).map((q: unknown) => str(q, 300)).filter(Boolean) : [],
    letter: s.letter === true, pass: s.pass === true,
  };
}
function cleanEvents(list: unknown) {
  if (!Array.isArray(list)) return [];
  const now = Date.now();
  return list.slice(0, 50).flatMap((e: any) => {
    if (!e || !EVENTS.has(e.type)) return [];
    let at = Date.parse(e.at);
    if (!Number.isFinite(at) || at > now || at < now - 7 * 864e5) at = now;
    const data: Record<string, unknown> = {};
    if (e.type === "day") { const n = Number(e.data?.n); if (Number.isInteger(n) && n >= 0 && n <= 5) data.n = n; }
    if (e.type === "link") data.to = LINKS.has(e.data?.to) ? e.data.to : "other";
    if (e.type === "open") data.locked = e.data?.locked === true;
    return [{ type: e.type, data, at: new Date(at).toISOString() }];
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!TOKEN) return json({ ok: false, error: "no token" }, 500);
  if (req.method !== "POST") return json({ ok: false }, 404);
  const url = new URL(req.url);
  let b: any;
  try { const t = await req.text(); if (t.length > 60000) return json({ ok: false }, 413); b = JSON.parse(t); }
  catch { return json({ ok: false }, 400); }

  if (url.searchParams.has("track")) {
    const id = await userFrom(String(b.initData ?? ""), 72);
    if (!id) return json({ ok: false }, 401);
    const { error } = await db.rpc("hike_track", { p_tg: id, p_snap: cleanSnap(b.snap), p_events: cleanEvents(b.events) });
    if (error) { console.error(error); return json({ ok: false }, 500); }
    return json({ ok: true });
  }

  if (url.searchParams.has("admin")) {
    const id = await userFrom(String(b.initData ?? ""), 24);
    if (!id) return json({ ok: false, error: "auth" }, 401);
    const { data: me } = await db.from("participants").select("is_admin").eq("tg_id", id).maybeSingle();
    if (!me?.is_admin) return json({ ok: false, error: "not admin" }, 403);
    if (b.op === "data") {
      const { data, error } = await db.rpc("hike_admin_data");
      if (error) { console.error(error); return json({ ok: false }, 500); }
      return json({ ok: true, data });
    }
    if (b.op === "lead") {
      const tg = Number(b.tg_id);
      if (!Number.isSafeInteger(tg)) return json({ ok: false }, 400);
      const row = {
        tg_id: tg, status: STATUSES.has(b.status) ? b.status : "new",
        manager: str(b.manager, 60) || null, note: str(b.note, 2000) || null,
        updated_by: id, updated_at: new Date().toISOString(),
      };
      const { error } = await db.from("lead_status").upsert(row);
      if (error) { console.error(error); return json({ ok: false }, 500); }
      return json({ ok: true });
    }
    if (b.op === "crm") {
      // Отправка лидов в CRM: контакты берём из базы, этап и заметку присылает админка. Адрес вебхука — в app_secrets.
      const items: any[] = Array.isArray(b.leads) ? b.leads.slice(0, 40) : [];
      const { data: sec } = await db.from("app_secrets").select("value").eq("key", "crm_webhook").maybeSingle();
      if (!sec?.value) return json({ ok: false, error: "no webhook" }, 500);
      const ids = items.map((x) => Number(x.tg_id)).filter((x) => Number.isSafeInteger(x));
      const { data: people } = await db.from("participants").select("tg_id,first_name,last_name,username,phone,source").in("tg_id", ids);
      const byId = new Map((people ?? []).map((p: any) => [Number(p.tg_id), p]));
      const results: any[] = [];
      for (const it of items) {
        const p: any = byId.get(Number(it.tg_id));
        if (!p || (!p.phone && !p.username)) { results.push({ tg_id: it.tg_id, ok: false, error: "нет контакта" }); continue; }
        const payload: Record<string, string> = {
          name: [p.first_name, p.last_name].filter(Boolean).join(" ") || "без имени",
          comment: str(it.comment, 3000), tags: str(it.tags, 300),
          product: "Бесплатный мастер-класс «Путешествие к видеотворчеству», 2–6 декабря",
          page: "Telegram-бот @alinasolopova_fys_bot · мини-апп «Зимний поход»",
          utm_source: p.source || "", utm_medium: "telegram", utm_campaign: "zimniy-pohod",
        };
        if (p.phone) payload.phone = String(p.phone);
        if (p.username) payload.tg = "@" + p.username;
        try {
          const r = await fetch(sec.value, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
          const t = await r.text(); let j: any = {}; try { j = JSON.parse(t); } catch { /* не JSON */ }
          const deal = j?.deal_id != null ? String(j.deal_id) : null;
          if (!r.ok) { results.push({ tg_id: it.tg_id, ok: false, error: "CRM ответила " + r.status }); continue; }
          await db.from("lead_status").upsert({ tg_id: p.tg_id, crm_sent_at: new Date().toISOString(), crm_deal_id: deal, updated_by: id }, { onConflict: "tg_id" });
          results.push({ tg_id: it.tg_id, ok: true, deal });
        } catch (e) { console.error(e); results.push({ tg_id: it.tg_id, ok: false, error: "нет связи с CRM" }); }
      }
      return json({ ok: true, results });
    }
    return json({ ok: false }, 400);
  }
  return json({ ok: false }, 404);
});
