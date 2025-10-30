import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const app = express();
const PORT = process.env.PORT || 10000;

// ====== Настройки Puppeteer ======
let browser;

async function ensureBrowser() {
  if (!browser) {
    const execPath = await chromium.executablePath();
    browser = await puppeteer.launch({
      headless: chromium.headless,
      executablePath: execPath,
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: { width: 1280, height: 800 },
    });
  }
  return browser;
}

// ====== Утилиты ======
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
  const m = s.match(/video(-?\d+)_([0-9]+)/i);
  return m ? { owner_id: m[1], video_id: m[2], full: `${m[1]}_${m[2]}` } : null;
}

// ====== Основной эндпоинт ======
app.get("/views", async (req, res) => {
  const targetUrl = req.query.url;
  const token = req.query.token;
  if (!targetUrl) return res.status(400).json({ error: "Missing url param" });
  if (process.env.API_TOKEN && token !== process.env.API_TOKEN)
    return res.status(403).json({ error: "Invalid token" });

  let views = null;
  let browserInstance;
  let page;

  try {
    browserInstance = await ensureBrowser();
    page = await browserInstance.newPage();

    // === 1. Быстрая проверка через al_video.php ===
    const vid = extractVideoId(targetUrl);
    if (vid) {
      const apiUrl = `https://vk.com/al_video.php?act=show&al=1&video=${vid.full}`;
      const resp = await page.goto(apiUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      const text = await resp.text();

      let v = matchFirst(text, [
        /"views"\s*:\s*\{"count"\s*:\s*(\d+)/i,
        /"viewsCount"\s*:\s*(\d+)/i,
      ]);
      if (v) views = Number(v);
    }

    // === 2. Если не нашли — пробуем обычную страницу vk.com/video ===
    if (!Number.isFinite(views) && vid) {
      const vkUrl = `https://vk.com/video${vid.owner_id}_${vid.video_id}`;
      await page.goto(vkUrl, { waitUntil: "networkidle2", timeout: 45000 });
      const html = await page.content();

      let v = matchFirst(html, [
        /"views"\s*:\s*\{"count"\s*:\s*(\d+)/i,
        /"viewsCount"\s*:\s*(\d+)/i,
      ]);
      if (v) views = Number(v);

      if (!Number.isFinite(views)) {
        const txt = await page.evaluate(() => document.body.innerText);
        const clean = txt.replace(/\u00A0/g, " ").replace(/\s+/g, " ");
        const m = clean.match(/([\d\s]+)\s*просмотр/iu);
        if (m) views = Number((m[1] || "").replace(/[^\d]/g, ""));
      }
    }

    // === 3. Fallback: vkvideo.ru ===
    if (!Number.isFinite(views) && /vkvideo\.ru/i.test(targetUrl)) {
      try {
        await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 60000 });
        const html = await page.content();

        let v = matchFirst(html, [
          /"views"\s*:\s*\{"count"\s*:\s*(\d{1,15})/i,
          /"viewsCount"\s*:\s*(\d{1,15})/i,
          /"views_count"\s*:\s*(\d{1,15})/i,
        ]);
        if (v) views = Number(v);

        if (!Number.isFinite(views)) {
          const txt = await page.evaluate(() => document.body.innerText);
          const clean = txt.replace(/\u00A0/g, " ").replace(/\s+/g, " ");
          const m = clean.match(/([\d\s]+)\s*просмотр/iu);
          if (m) views = Number((m[1] || "").replace(/[^\d]/g, ""));
        }
      } catch (e) {
        console.warn("vkvideo fallback failed:", e);
      }
    }

    if (Number.isFinite(views)) {
      return res.json({
        views,
        source: "vk|vkvideo",
        url: targetUrl,
      });
    } else {
      return res.status(404).json({
        error: "views not found",
        url: targetUrl,
      });
    }
  } catch (err) {
    console.error("Scraper error:", err);
    return res.status(500).json({ error: String(err) });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

// ====== Healthcheck ======
app.get("/health", (req, res) =>
  res.json({ ok: true, ts: Date.now(), pid: process.pid })
);

// ====== Запуск ======
app.listen(PORT, () => {
  console.log(`VK scraper running on ${PORT}`);
});

// ====== Чистое завершение ======
process.on("SIGTERM", async () => {
  console.log("Shutting down gracefully...");
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
