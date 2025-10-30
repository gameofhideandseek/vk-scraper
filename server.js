import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const app = express();
const PORT = process.env.PORT || 10000;
const API_TOKEN = process.env.API_TOKEN || null;
const REMIXSID = process.env.REMIXSID || null;

let browser;

/* -------------------- Puppeteer bootstrap -------------------- */
async function ensureBrowser() {
  if (!browser) {
    const execPath = await chromium.executablePath();
    browser = await puppeteer.launch({
      headless: chromium.headless,
      executablePath: execPath,
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
      ],
      defaultViewport: { width: 1280, height: 800 },
    });
  }
  return browser;
}

/* -------------------- Utils -------------------- */
function matchFirst(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

function extractVideoId(url) {
  if (!url) return null;
  const s = String(url);
  // video-123_456, video123_456, -123_456
  let m = s.match(/video(-?\d+)_([0-9]+)/i);
  if (m) return { owner_id: m[1], video_id: m[2], full: `${m[1]}_${m[2]}` };
  m = s.match(/(-?\d+)_([0-9]+)/);
  return m ? { owner_id: m[1], video_id: m[2], full: `${m[1]}_${m[2]}` } : null;
}

async function hardenPage(page) {
  // шире таймауты
  page.setDefaultNavigationTimeout(65000);
  page.setDefaultTimeout(30000);

  // авторизация (если есть)
  if (REMIXSID) {
    await page.setCookie(
      { name: "remixsid", value: REMIXSID, domain: ".vk.com", httpOnly: true, secure: true },
      { name: "remixsid", value: REMIXSID, domain: ".m.vk.com", httpOnly: true, secure: true }
    );
  }

  // умеренный user-agent + язык
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "ru-RU,ru;q=0.9" });

  // блок тяжёлых ресурсов (ускоряет и снижает шанс таймаута)
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (type === "image" || type === "media" || type === "font" || type === "stylesheet") {
      return req.abort();
    }
    return req.continue();
  });
}

async function gotoWithRetries(page, url, opts = {}) {
  const attempts = [
    { waitUntil: "domcontentloaded", timeout: opts.timeout || 45000 },
    { waitUntil: "load",             timeout: opts.timeout || 45000 },
    { waitUntil: "networkidle2",     timeout: Math.max(30000, (opts.timeout || 45000) - 5000) },
  ];
  let lastErr;
  for (const attempt of attempts) {
    try {
      await page.goto(url, attempt);
      return true;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/* -------------------- Endpoint -------------------- */
app.get("/views", async (req, res) => {
  try {
    // auth
    if (API_TOKEN && req.query.token !== API_TOKEN) {
      return res.status(403).json({ error: "Invalid token" });
    }

    const targetUrl = String(req.query.url || "").trim();
    if (!targetUrl) return res.status(400).json({ error: "Missing url param" });

    const vid = extractVideoId(targetUrl);
    let views = null;

    const b = await ensureBrowser();
    const page = await b.newPage();
    try {
      await hardenPage(page);

      /* 1) Быстрый вариант: al_video.php по ID */
      if (vid) {
        // через навигацию можно словить редирект/403, поэтому пойдём XHR-ом внутри страницы
        await gotoWithRetries(page, "https://vk.com/", { timeout: 30000 });
        const respText = await page.evaluate(async (full) => {
          try {
            const body = "act=show&al=1&video=" + encodeURIComponent(full);
            const r = await fetch("https://vk.com/al_video.php", {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "Accept": "*/*",
                "Origin": "https://vk.com",
                "Referer": "https://vk.com/",
              },
              body,
            });
            return await r.text();
          } catch (e) {
            return "FETCH_ERR::" + String(e);
          }
        }, vid.full);

        if (respText && !respText.startsWith("FETCH_ERR::")) {
          const v = matchFirst(respText, [
            /"views"\s*:\s*\{"count"\s*:\s*(\d+)/i,
            /"viewsCount"\s*:\s*(\d+)/i,
            /views_count["']?\s*[:=]\s*["']?(\d+)/i,
          ]);
          if (v) views = Number(v);
        }
      }

      /* 2) Обычная страница vk.com/video… (лёгкие ожидания) */
      if (!Number.isFinite(views) && vid) {
        const deskUrl = `https://vk.com/video${vid.owner_id}_${vid.video_id}`;
        try {
          await gotoWithRetries(page, deskUrl, { timeout: 50000 });
          const html = await page.content();
          let v = matchFirst(html, [
            /"views"\s*:\s*\{"count"\s*:\s*(\d{1,15})/i,
            /"viewsCount"\s*:\s*(\d{1,15})/i,
          ]);
          if (v) views = Number(v);

          if (!Number.isFinite(views)) {
            const txt = await page.evaluate(() => document.body?.innerText || "");
            const clean = txt.replace(/\u00A0/g, " ").replace(/\s+/g, " ");
            const m = clean.match(/([\d\s]+)\s*просмотр/iu);
            if (m) views = Number((m[1] || "").replace(/[^\d]/g, ""));
          }
        } catch (_) {
          // игнорируем — пойдём на vkvideo
        }
      }

      /* 3) Fallback: vkvideo.ru (оставляем исходный URL, со всеми query) */
      if (!Number.isFinite(views) && /vkvideo\.ru/i.test(targetUrl)) {
        try {
          await gotoWithRetries(page, targetUrl, { timeout: 60000 });
          const html = await page.content();
          let v = matchFirst(html, [
            /"views"\s*:\s*\{"count"\s*:\s*(\d{1,15})/i,
            /"viewsCount"\s*:\s*(\d{1,15})/i,
            /"views_count"\s*:\s*(\d{1,15})/i,
          ]);
          if (v) views = Number(v);

          if (!Number.isFinite(views)) {
            const txt = await page.evaluate(() => document.body?.innerText || "");
            const clean = txt.replace(/\u00A0/g, " ").replace(/\s+/g, " ");
            const m = clean.match(/([\d\s]+)\s*просмотр/iu);
            if (m) views = Number((m[1] || "").replace(/[^\d]/g, ""));
          }
        } catch (e) {
          console.warn("vkvideo fallback timeout/error:", e?.message || e);
        }
      }

      if (Number.isFinite(views)) {
        return res.json({ views, source: "vk|vkvideo", url: targetUrl });
      }
      return res.status(404).json({ error: "views not found", url: targetUrl });
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err) {
    console.error("Scraper error:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/* -------------------- Health -------------------- */
app.get("/health", (req, res) =>
  res.json({ ok: true, ts: Date.now(), pid: process.pid })
);

/* -------------------- Listen -------------------- */
app.listen(PORT, () => {
  console.log(`VK scraper running on ${PORT}`);
});

/* -------------------- Graceful shutdown -------------------- */
process.on("SIGTERM", async () => {
  console.log("Shutting down gracefully...");
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
