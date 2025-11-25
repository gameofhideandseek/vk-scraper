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

    // извлекаем объект videoModalInfoData из текста
    let videoModalInfoData = null;
    if (respText && !respText.startsWith('FETCH_ERR::')) {
      // Ищем объект videoModalInfoData
      const dataMatch = respText.match(/videoModalInfoData\s*=\s*(\{.*?\});/s);
      if (dataMatch) {
        try {
          videoModalInfoData = JSON.parse(dataMatch[1]);
        } catch (error) {
          console.error('Ошибка при парсинге JSON:', error);
        }
      }
    }

    // если нашли videoModalInfoData, проверяем на наличие данных views
    let views = null;
    if (videoModalInfoData && videoModalInfoData.views) {
      views = videoModalInfoData.views;
    }

    // если views не найдено, проверяем другие источники, такие как short_video_other_videos
    if (views == null) {
      const otherVideos = videoModalInfoData?.short_video_other_videos;
      if (otherVideos) {
        // ищем нужное видео среди других видео в плейлисте
        const video = otherVideos.find((v) => v.id === vid.id);
        if (video) {
          views = video.views;
        }
      }
    }

    await page.close();

    if (Number.isFinite(views)) {
      return res.json({ views, source: 'videoModalInfoData' });
    } else {
      return res.status(404).json({ error: 'views not found', id: vid.full });
    }
  } catch (e) {
    console.error('Scraper error:', e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log(`VK scraper running on ${PORT}`)); //hellotest
