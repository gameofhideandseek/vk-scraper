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

// Функция для получения просмотров через al_video.php
async function fetchViewsFromAlVideo(videoId) {
  const url = `https://vk.com/al_video.php?act=show&al=1&video=${encodeURIComponent(videoId)}`;
  const page = await browser.newPage();

  // Установим куки, если они необходимы для авторизации
  if (REMIXSID) {
    await page.setCookie(
      { name: 'remixsid', value: REMIXSID, domain: '.vk.com', httpOnly: true, secure: true },
      { name: 'remixsid', value: REMIXSID, domain: '.m.vk.com', httpOnly: true, secure: true }
    );
  }

  // Маскируемся под обычный браузер
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Извлекаем количество просмотров из страницы
    const views = await page.evaluate(() => {
      const viewsElement = document.querySelector('.views_count');
      if (viewsElement) {
        const viewsText = viewsElement.textContent || viewsElement.innerText;
        return parseInt(viewsText.replace(/\D/g, ''), 10); // Убираем все нецифровые символы
      }
      return null;
    });

    await page.close();
    return views;
  } catch (e) {
    console.error('Ошибка при получении просмотров через al_video.php:', e);
    await page.close();
    return null;
  }
}

app.get('/views', async (req, res) => {
  const raw = req.query.url;
  const vid = extractId(raw);
  if (!vid) return res.status(400).json({ error: 'bad url' });

  try {
    await ensureBrowser();

    // Получаем количество просмотров через al_video.php
    const views = await fetchViewsFromAlVideo(vid.full);

    if (views !== null && Number.isFinite(views)) {
      return res.json({ views, source: 'al_video.php' });
    } else {
      return res.status(404).json({ error: 'views not found', id: vid.full });
    }
  } catch (e) {
    console.error('Scraper error:', e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log(`VK scraper running on ${PORT}`));
