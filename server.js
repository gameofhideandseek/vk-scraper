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

// Устанавливаем кодировку UTF-8 для всех ответов
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8'); // Устанавливаем кодировку
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

    // главный способ: вызвать внутренний API al_video.php из самой страницы
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
        const text = await r.text();
        
        // Принудительно декодируем текст в UTF-8, если ответ не в правильной кодировке
        const decoder = new TextDecoder('utf-8');
        const decodedResponse = decoder.decode(new TextEncoder().encode(text));
        return decodedResponse;
      } catch (e) {
        return 'FETCH_ERR::' + String(e);
      }
    }, payload);

    // логируем ответ от al_video.php для отладки
    console.log("Ответ от al_video.php:", respText);

    // пытаемся достать просмотры из ответа al_video.php
    let views = null;
    if (respText && !respText.startsWith('FETCH_ERR::')) {
      let m = respText.match(/"videoModalInfoData":\s*{[^}]*"views"\s*:\s*\{[^}]*"count"\s*:\s*(\d+)/i);
      if (!m) m = respText.match(/"views"\s*:\s*\{\s*"count"\s*:\s*(\d{1,15})/);
      if (!m) m = respText.match(/"views"\s*:\s*(\d{1,15})/);
      if (m) views = Number(m[1]);
    }

    // запасной вариант: пробуем выдернуть из DOM/HTML
    if (views == null) {
      const deskUrl = `https://vk.com/video${vid.owner}_${vid.id}`;
      await page.goto(deskUrl, { waitUntil: 'networkidle2', timeout: 45000 });
      const txt = await page.evaluate(() => document.body?.innerText || '');
      const m = txt.replace(/\u00A0/g, ' ').match(/([\d\s]+)\s*просмотр/iu);
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
    console.error('Scraper error:', e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log(`VK scraper running on ${PORT}`)); //hellotest
