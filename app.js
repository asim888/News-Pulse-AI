import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import multer from "multer";
import Parser from "rss-parser";
import fetch from "node-fetch";
import OpenAI from "openai";

const app = express();
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

app.use(helmet());
app.use(cors({ origin: "*", methods: ["GET","POST","PUT","DELETE","OPTIONS"] }));
app.use(express.json({ limit: "2mb" }));
app.use(compression());
app.use(morgan("tiny"));

const PORT = process.env.PORT || 8080;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const parser = new Parser();
const OZ_TO_G = 31.1034768;

// ----------------- helpers
function cache(res, seconds = 60, swr = 60) {
  res.set("Cache-Control", `public, s-maxage=${seconds}, stale-while-revalidate=${swr}`);
  res.set("CDN-Cache-Control", `max-age=${seconds}, stale-while-revalidate=${swr}`);
  res.set("Vary", "Accept-Encoding");
}
function safeDomain(u = "") { try { return new URL(u).hostname; } catch { return ""; } }
function stripHtml(html = "") {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function parseJsonLoose(s = "") {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/{[\s\S]*}$/m);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
async function fetchWithTimeout(url, ms = 12000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}
function toRomanHindi(str = "") {
  const map = [
    [/क्ष/g,"ksh"],[/ज्ञ/g,"gya"],[/त्र/g,"tra"],
    [/अ/g,"a"],[/आ/g,"aa"],[/इ/g,"i"],[/ई/g,"ee"],[/उ/g,"u"],[/ऊ/g,"oo"],
    [/ए/g,"e"],[/ऐ/g,"ai"],[/ओ/g,"o"],[/औ/g,"au"],
    [/क/g,"k"],[/ख/g,"kh"],[/ग/g,"g"],[/घ/g,"gh"],[/च/g,"ch"],[/छ/g,"chh"],
    [/ज/g,"j"],[/झ/g,"jh"],[/ट/g,"t"],[/ठ/g,"th"],[/ड/g,"d"],[/ढ/g,"dh"],[/ण/g,"n"],
    [/त/g,"t"],[/थ/g,"th"],[/द/g,"d"],[/ध/g,"dh"],[/न/g,"n"],
    [/प/g,"p"],[/फ/g,"ph"],[/ब/g,"b"],[/भ/g,"bh"],[/म/g,"m"],
    [/य/g,"y"],[/र/g,"r"],[/ल/g,"l"],[/व/g,"v"],[/श|ष/g,"sh"],[/स/g,"s"],[/ह/g,"h"],
    [/ं/g,"n"],[/ँ/g,"n"],[/ः/g,"h"],[/़/g,""]
  ];
  let out = str; for (const [re,rep] of map) out = out.replace(re,rep);
  return out.replace(/है/g,"hai").replace(/नहीं/g,"nahi");
}
function dedupeByLink(items) {
  const s = new Set(); return items.filter(i => s.has(i.link) ? false : (s.add(i.link), true));
}

// ----------------- sources
const sources = {
  Hyderabad: ["https://telanganatoday.com/hyderabad/feed"],
  Telangana: ["https://telanganatoday.com/telangana/feed","https://www.thehindu.com/news/national/feeder/default.rss"],
  India: ["https://feeds.feedburner.com/ndtvnews-top-stories","https://www.thehindu.com/news/national/feeder/default.rss"],
  International: ["https://www.thehindu.com/news/international/feeder/default.rss"],
  Sports: ["https://feeds.feedburner.com/ndtvsports-latest","https://www.thehindu.com/sport/feeder/default.rss"],
  Gadgets: ["https://feeds.feedburner.com/gadgets360-latest","https://www.thehindu.com/sci-tech/technology/feeder/default.rss"],
  Health: ["https://www.thehindu.com/sci-tech/health/feeder/default.rss"]
};

// ----------------- LLM helpers
async function summarize(url, source) {
  try {
    const r = await fetchWithTimeout(url);
    const html = await r.text();
    const text = stripHtml(html).slice(0, 8000);
    const sys = "You summarize news accurately and concisely. No speculation.";
    const prompt = `Summarize into JSON with keys: {"short_story":"80–140 words","bullets":["...","...","..."]}. Use neutral tone.`;
    const out = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{ role: "system", content: sys }, { role: "user", content: prompt + "\n\n" + text }]
    });
    const content = out.choices?.[0]?.message?.content || "{}";
    return parseJsonLoose(content) || { short_story: "", bullets: [] };
  } catch {
    return { short_story: "", bullets: [] };
  }
}
async function translateText(text, target) {
  const sys = `Translate news text. Keep names and numbers. Urdu in Nastaliq; Telugu proper script. Target: ${target}.`;
  const out = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [{ role: "system", content: sys }, { role: "user", content: text }]
  });
  return (out.choices?.[0]?.message?.content || "").trim();
}

// ----------------- in-memory buffer (Azad Studio via Telegram webhook)
const studioBuffer = []; const MAX_STUDIO = 50;

// ----------------- routes
app.get("/api/health", (req, res) => res.json({ ok: true, node: process.version, time: Date.now() }));

app.get("/api/feed", async (req, res) => {
  try {
    const { category = "India" } = req.query;
    const urls = sources[category] || sources.India;
    const items = [];
    await Promise.all(urls.map(async (url) => {
      try {
        const feed = await parser.parseURL(url);
        const list = (feed.items || []).slice(0, 10);
        await Promise.all(list.map(async (i) => {
          const src = safeDomain(url) || safeDomain(i.link);
          const sum = await summarize(i.link, src);
          items.push({
            title: i.title,
            link: i.link,
            summary: sum.short_story || i.contentSnippet || "",
            bullets: sum.bullets || [],
            pubDate: i.pubDate,
            source: src,
            image: i.enclosure?.url || null
          });
        }));
      } catch {}
    }));
    cache(res, 120, 60);
    res.json({ category, items: dedupeByLink(items) });
  } catch (e) { res.status(500).json({ error: "feed_failed" }); }
});

app.get("/api/breaking", async (req, res) => {
  const urls = [...sources.India, ...sources.International];
  const items = [];
  await Promise.all(urls.map(async (url) => {
    try {
      const feed = await parser.parseURL(url);
      (feed.items || []).slice(0, 10).forEach((i) => {
        const pub = new Date(i.pubDate || 0);
        const ageMin = isNaN(pub.getTime()) ? 99999 : (Date.now() - pub.getTime()) / 60000;
        const score = (/(breaking|live|updates?)/i.test(i.title || "") ? 2 : 1) * (1 / Math.max(1, ageMin));
        items.push({ title: i.title, link: i.link, source: safeDomain(url), score });
      });
    } catch {}
  }));
  cache(res, 90, 60);
  res.json({ items: items.sort((a,b)=>b.score-a.score).slice(0,5) });
});

// translate target: hi|ur|te|romhi
app.post("/api/translate", async (req, res) => {
  const { text, target } = req.body || {};
  if (!text || !target) return res.status(400).json({ error: "text and target required" });
  let out = await translateText(text, target === "romhi" ? "hi" : target);
  if (target === "romhi") out = toRomanHindi(out);
  res.json({ text: out });
});

// TTS (mp3)
app.post("/api/tts", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: text,
    format: "mp3"
  });
  const buf = Buffer.from(await speech.arrayBuffer());
  res.setHeader("Content-Type", "audio/mpeg");
  res.send(buf);
});

// QR screenshot verification (Vision)
app.post("/api/verify-screenshot", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "image_required" });
  const sys = `Verify subscription payment screenshot. Extract amount (INR), date/time, gateway, txid. ok=true only if amount >= 599 and within last 24h. Return JSON: {ok, amount?, time?, gateway?, txid?, reason?}`;
  const out = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: [
        { type: "text", text: "Check this receipt." },
        { type: "image_url", image_url: { url: "data:image/png;base64," + req.file.buffer.toString("base64") } }
      ] }
    ]
  });
  let json = parseJsonLoose(out.choices?.[0]?.message?.content || "{}") || { ok: false, reason: "parse_error" };
  res.json(json);
});

// Weather (tomorrow) via Open‑Meteo
app.get("/api/weather", async (req, res) => {
  const lat = Number(req.query.lat) || 17.3850;
  const lon = Number(req.query.lon) || 78.4867;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_mean&timezone=Asia%2FKolkata`;
  try {
    const r = await fetchWithTimeout(url);
    const j = await r.json();
    const d = j?.daily;
    if (!d?.temperature_2m_max?.[1]) return res.json({ error: "unavailable" });
    cache(res, 300, 120);
    res.json({
      high: Math.round(d.temperature_2m_max[1]),
      low: Math.round(d.temperature_2m_min[1]),
      pop: d.precipitation_probability_mean?.[1] ?? 0,
      code: d.weathercode?.[1] ?? 0
    });
  } catch { res.json({ error: "unavailable" }); }
});

// Gold (today + estimate)
app.get("/api/gold", async (req, res) => {
  try {
    const fx = await (await fetchWithTimeout("https://api.exchangerate.host/latest?base=USD&symbols=INR")).json();
    const usdInInr = fx?.rates?.INR || 83;
    const y = await (await fetchWithTimeout("https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?range=7d&interval=1d")).json();
    const closes = y?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Boolean) || [];
    if (!closes.length) return res.json({ error: "unavailable" });
    const todayUsdPerOz = closes.at(-1);
    const inrPerGram = (todayUsdPerOz * usdInInr) / OZ_TO_G;
    const g24 = Math.round(inrPerGram), g22 = Math.round(inrPerGram * (22/24));
    let mean = 0; for (let i = 1; i < closes.length; i++) mean += (closes[i]-closes[i-1])/closes[i-1];
    mean = mean / Math.max(1, closes.length - 1);
    cache(res, 300, 120);
    res.json({
      currency: "INR",
      current: { g24, g22 },
      tomorrow_estimate: { g24: Math.round(g24*(1+mean)), g22: Math.round(g22*(1+mean)) },
      note: "Estimate based on recent trend. Retail rates vary by city/jeweller."
    });
  } catch { res.json({ error: "unavailable" }); }
});

// Telegram webhook (channel posts + DM submissions)
const studioMax = 50;
app.post("/telegram/webhook", express.json(), async (req, res) => {
  try {
    if (process.env.ADMIN_KEY) {
      const secret = req.headers["x-telegram-bot-api-secret-token"];
      if (secret !== process.env.ADMIN_KEY) return res.sendStatus(401);
    }
    const update = req.body || {};
    const ch = update.channel_post;
    const msg = update.message;
    const push = (obj) => { studioBuffer.unshift(obj); if (studioBuffer.length > studioMax) studioBuffer.pop(); };

    if (ch?.chat?.type === "channel") {
      let type = "text", file_id = null;
      if (ch.photo?.length) { type = "photo"; file_id = ch.photo.slice(-1)[0].file_id; }
      if (ch.video) { type = "video"; file_id = ch.video.file_id; }
      const text = (ch.text || ch.caption || "");
      push({
        id: ch.message_id, type, file_id,
        title: text.split("\n")[0]?.slice(0, 100) || "",
        caption: text, date: ch.date, tags: []
      });
    } else if (msg?.chat?.type === "private") {
      let type = "text", file_id = null;
      if (msg.photo?.length) { type = "photo"; file_id = msg.photo.slice(-1)[0].file_id; }
      if (msg.video) { type = "video"; file_id = msg.video.file_id; }
      const text = (msg.text || msg.caption || "");
      push({ id: msg.message_id, type, file_id, title: text.split("\n")[0]?.slice(0,100)||"", caption: text, date: msg.date, tags: [] });
    }
    res.sendStatus(200);
  } catch { res.sendStatus(200); }
});

// Proxy Telegram file (keeps bot token server-side)
app.get("/tg/file/:file_id", async (req, res) => {
  try {
    const token = process.env.BOT_TOKEN;
    const f = await (await fetchWithTimeout(`https://api.telegram.org/bot${token}/getFile?file_id=${req.params.file_id}`)).json();
    const p = f?.result?.file_path; if (!p) return res.sendStatus(404);
    const r = await fetchWithTimeout(`https://api.telegram.org/file/bot${token}/${p}`);
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    r.body.pipe(res);
  } catch { res.sendStatus(500); }
});

// Azad Studio feed (from memory)
app.get("/api/azad-studio", (req, res) => {
  cache(res, 30, 30);
  const out = studioBuffer.map(p => ({ ...p, mediaUrl: p.file_id ? `/tg/file/${p.file_id}` : null, source: "Azad Studio" }));
  res.json({ items: out });
});

// Admin notify (stub)  header: x-admin-key: ADMIN_KEY
app.post("/api/notify/breaking", (req, res) => {
  if ((req.headers["x-admin-key"] || "") !== (process.env.ADMIN_KEY || "")) return res.status(401).json({ error: "unauthorized" });
  res.json({ ok: true });
});

// 404 + error handler
app.use((req, res) => res.status(404).json({ error: "not_found", path: req.originalUrl }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "server_error" });
});

app.listen(PORT, () => console.log("API up on :" + PORT));

