import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
const PORT = process.env.PORT || 3000;

// Вставь сессию безопасно через ENV:
// macOS/Linux: REMIXSID=xxx npm start
// Windows: set REMIXSID=xxx && npm start
const REMIXSID = '1_VOYgCUTzjGiG898EG1MmUQ-EJUepMnPVPOCB4-3pqjdNslKbnthPe4DYlZCRy_9070_7MSSek3dL_PZebWmD4Q';

let browser;

function extractId(input) {
  if (!input) return null;
  const s = String(input);
  let m = s.match(/video(-?\d+)_(\d+)/i);
  if (m) return { owner: m[1], id: m[2], full: `${m[1]}_${m[2]}` };
  m = s.match(/(-?\d+)_(\d+)/);
  if (m) return { owner: m[1], id: m[2], full: `${m[1]}_${m[2]}` };
  return null;
}

async function ensureBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox']
    });
  }
  return browser;
}

app.get('/views', async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).json({ error: 'no url' });

  const vid = extractId(raw);
  if (!vid) return res.status(400).json({ error: 'bad url or id', raw });

  try {
    await ensureBrowser();
    const page = await browser.newPage();

    // Минимальная мимикрия под браузер
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });

    // Если есть сессия — устанавливаем на оба домена
    if (REMIXSID) {
      await page.setCookie(
        { name: 'remixsid', value: REMIXSID, domain: '.vk.com', httpOnly: true, secure: true },
        { name: 'remixsid', value: REMIXSID, domain: '.m.vk.com', httpOnly: true, secure: true }
      );
    }

    // Заходим на пустую страницу домена, чтобы привязать куку
    await page.goto('https://vk.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 1) ПРЯМОЙ ВЫЗОВ ВНУТРЕННЕГО API ИЗ СТРАНИЦЫ (главный путь)
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

    // Пробуем вытащить «views_count» из ответа
    let views = null;
    if (respText && !respText.startsWith('FETCH_ERR::')) {
      let m = respText.match(/views_count["']?\s*[:=]\s*["']?(\d+)/i);
      if (m) views = Number(m[1]);

      if (views == null) {
        m = respText.match(/"views"\s*:\s*\{\s*"count"\s*:\s*(\d{1,15})/);
        if (m) views = Number(m[1]);
      }
      if (views == null) {
        m = respText.match(/"views"\s*:\s*(\d{1,15})/);
        if (m) views = Number(m[1]);
      }
    }

    // 2) Бэкап: если не получилось — попробуем загрузить страницу и выдернуть из DOM/HTML
    if (views == null) {
      const deskUrl = `https://vk.com/video${vid.owner}_${vid.id}`;
      await page.goto(deskUrl, { waitUntil: 'networkidle2', timeout: 45000 });
      // читаем весь текст страницы
      const txt = await page.evaluate(() => document.body ? document.body.innerText : '');
      const t = (txt || '').replace(/\u00A0/g, ' ');
      const m = t.match(/([\d\s]+)\s*просмотр/iu);
      if (m) {
        const n = Number(m[1].replace(/[^\d]/g, ''));
        if (Number.isFinite(n)) views = n;
      }
      // ещё резерв — HTML JSON
      if (views == null) {
        const html = await page.content();
        let j = html.match(/"viewsCount"\s*:\s*(\d{1,15})/);
        if (j) views = Number(j[1]);
        if (views == null) {
          j = html.match(/"views"\s*:\s*\{\s*"count"\s*:\s*(\d{1,15})/);
          if (j) views = Number(j[1]);
        }
      }
    }

    await page.close();

    if (Number.isFinite(views)) {
      return res.json({ views, via: 'al_video.php|dom' });
    } else {
      return res.status(404).json({ error: 'views not found', id: vid.full });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log('VK scraper running on', PORT));
