import express from 'express';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import iconv from 'iconv-lite';  // Подключаем iconv-lite для обработки кодировок

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
        return text;
      } catch (e) {
        return 'FETCH_ERR::' + String(e);
      }
    }, payload);

    // Декодируем текст с использованием iconv-lite, чтобы избежать ошибок при парсинге
    let decodedRespText = iconv.decode(Buffer.from(respText, 'utf-8'), 'utf-8');

    // Теперь ищем объект "videoModalInfoData"
    let videoModalInfoData = null;
    if (decodedRespText && !decodedRespText.startsWith('FETCH_ERR::')) {
      // Находим JSON-строку с объектом videoModalInfoData
      const m = decodedRespText.match(/"videoModalInfoData":\s*({[^}]*})/);
      if (m) {
        let videoModalInfoDataText = m[1];
        
        // Очищаем текст от лишних символов, чтобы избежать ошибок при парсинге
        videoModalInfoDataText = videoModalInfoDataText.replace(/\u200B/g, ''); // Убираем невидимые символы
        videoModalInfoDataText = videoModalInfoDataText.replace(/[\n\r\t]+/g, ''); // Убираем лишние пробелы и символы

        try {
          // Преобразуем строку в объект
          videoModalInfoData = JSON.parse(videoModalInfoDataText);
          console.log('videoModalInfoData:', videoModalInfoData); // Логируем содержимое videoModalInfoData
        } catch (e) {
          console.error('Ошибка при парсинге JSON:', e);
          console.log('Текст, который не удалось распарсить:', videoModalInfoDataText); // Логируем проблемный текст
        }
      }
    }

    // Если нашли videoModalInfoData, пытаемся извлечь просмотры
    let views = null;
    if (videoModalInfoData && videoModalInfoData.views) {
      views = videoModalInfoData.views;
    }

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
