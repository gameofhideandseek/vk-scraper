import express from 'express';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

const app = express();
const PORT = process.env.PORT || 3000;

// Секреты
const REMIXSID = process.env.REMIXSID || null;   // кука VK
const API_TOKEN = process.env.API_TOKEN || null; // токен доступа к /views

let browser;

// защита по токену
app.use((req, res, next) => {
  if (API_TOKEN && req.path === '/views') {
    if (req.query.token !== API_TOKEN) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }
  next();
});

// health (проверка)
app.get('/', (_, res) => res.send('OK'));
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// достаем video-ид из ссылки
function extractId(input) {
  if (!input) return null;
  const m = String(input).match(/video(-?\d+)_(\d+)/i);
  return m ? { owner: m[1], id: m[2], full: `${m[1]}_${m[2]}` } : null;
}

// запускаем Chromium от @sparticuz (он уже «встроенный»)
async function ensureBrowser() {
  if (!browser) {
    const execPath = await chromium.executablePath();
    browser = await puppeteer.launch({
      headless: chromium.headless,
      executablePath: execPath,
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox']
    });
  }
  return browser;
}

// Функция для извлечения просмотров из HTML страницы
async function getViewsFromHtml(page, videoId) {
  const videoUrl = `https://vk.com/video${videoId}`;
  
  // Переходим на страницу видео
  await page.goto(videoUrl, { waitUntil: 'networkidle2', timeout: 45000 });

  // Извлекаем количество просмотров из HTML
  const views = await page.evaluate(() => {
    // Ищем элемент, который содержит количество просмотров
    const viewsElement = document.querySelector('.views_count');
    return viewsElement ? parseInt(viewsElement.textContent.replace(/\D/g, ''), 10) : null;
  });

  return views;
}

app.get('/views', async (req, res) => {
  const raw = req.query.url;
  const vid = extractId(raw);
  if (!vid) return res.status(400).json({ error: 'bad url' });

  try {
    await ensureBrowser();
    const page = await browser.newPage();

    // кука VK (если нужна авторизация)
    if (REMIXSID) {
      await page.setCookie(
        { name: 'remixsid', value: REMIXSID, domain: '.vk.com', httpOnly: true, secure: true },
        { name: 'remixsid', value: REMIXSID, domain: '.m.vk.com', httpOnly: true, secure: true }
      );
    }

    // немного маскируемся под обычный браузер
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });

    // идем на vk.com, чтобы сессия закрепилась
    await page.goto('https://vk.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Получаем количество просмотров из HTML страницы
    const views = await getViewsFromHtml(page, vid.full);

    await page.close();

    if (views !== null && Number.isFinite(views)) {
      return res.json({ views, source: 'HTML' });
    } else {
      return res.status(404).json({ error: 'views not found', id: vid.full });
    }
  } catch (e) {
    console.error('Scraper error:', e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log(`VK scraper running on ${PORT}`)); //hellotest
