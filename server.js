import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
const PORT = process.env.PORT || 3000;
const REMIXSID = process.env.REMIXSID || null;
const API_TOKEN = process.env.API_TOKEN || null;

let browser;

// === Безопасность: ограничим доступ к эндпоинту токеном ===
app.use((req, res, next) => {
  if (API_TOKEN && req.path === '/views') {
    if (req.query.token !== API_TOKEN) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }
  next();
});

// === Вспомогательные функции ===
function extractId(input) {
  if (!input) return null;
  const s = String(input);
  const m = s.match(/video(-?\d+)_(\d+)/i);
  return m ? { owner: m[1], id: m[2], full: `${m[1]}_${m[2]}` } : null;
}

async function ensureBrowser() {
  if (!browser) {
    const execPath =
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      '/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome';

    console.log('🔍 Puppeteer executable path:', execPath);

    browser = await puppeteer.launch({
      headless: true,
      executablePath: execPath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ]
    });
  }
  return browser;
}

// для проверки
app.get('/', (_, res) => res.send('OK ✅'));
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// === Главный эндпоинт ===
app.get('/views', async (req, res) => {
  const raw = req.query.url;
  const vid = extractId(raw);
  if (!vid) return res.status(400).json({ error: 'bad url' });

  try {
    await ensureBrowser();
    const page = await browser.newPage();

    // Авторизация, если есть remixsid
    if (REMIXSID) {
      await page.setCookie(
        { name: 'remixsid', value: REMIXSID, domain: '.vk.com', httpOnly: true, secure: true },
        { name: 'remixsid', value: REMIXSID, domain: '.m.vk.com', httpOnly: true, secure: true }
      );
    }

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });

    // Заходим на vk.com, чтобы кука применялась
    await page.goto('https://vk.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Прямой вызов внутреннего API VK
    const payload = `act=show&al=1&video=${encodeURIComponent(vid.full)}`;
    const respText = await page.evaluate(async (body) => {
      try {
        const r = await fetch('https://vk.com/al_video.php', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': '*/*',
            'Origin': 'https://vk.com',
            'Referer': 'https://vk.com/'
          },
          body
        });
        return await r.text();
      } catch (e) {
        return 'FETCH_ERR::' + String(e);
      }
    }, payload);

    // Извлекаем views_count из ответа
    let views = null;
    if (respText && !respText.startsWith('FETCH_ERR::')) {
      let m = respText.match(/views_count["']?\s*[:=]\s*["']?(\d+)/i);
      if (!m) m = respText.match(/"views"\s*:\s*\{\s*"count"\s*:\s*(\d{1,15})/);
      if (!m) m = respText.match(/"views"\s*:\s*(\d{1,15})/);
      if (m) views = Number(m[1]);
    }

    // Если прямой запрос не сработал — fallback по DOM
    if (views == null) {
      const deskUrl = `https://vk.com/video${vid.owner}_${vid.id}`;
      await page.goto(deskUrl, { waitUntil: 'networkidle2', timeout: 45000 });
      const txt = await page.evaluate(() => document.body?.innerText || '');
      const t = txt.replace(/\u00A0/g, ' ');
      const m = t.match(/([\d\s]+)\s*просмотр/iu);
      if (m) views = Number(m[1].replace(/[^\d]/g, ''));
      if (!views) {
        const html = await page.content();
        const j = html.match(/"viewsCount"\s*:\s*(\d{1,15})/);
        if (j) views = Number(j[1]);
      }
    }

    await page.close();

    if (Number.isFinite(views)) {
      return res.json({ views, source: 'al_video.php|dom' });
    } else {
      return res.status(404).json({ error: 'views not found', id: vid.full });
    }
  } catch (e) {
    console.error('❌ VK Scraper error:', e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log(`✅ VK scraper running on port ${PORT}`));
