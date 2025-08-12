import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const MAPS_URL_DEFAULT = 'https://www.google.com/maps/place/Beymen/...';

// input.json oku
let INPUT = {};
try {
  INPUT = JSON.parse(fs.readFileSync(path.join(__dirname, 'input.json'), 'utf8'));
} catch (_) {
  INPUT = {};
}

const rawLimit = Number(INPUT.limit);
const rawUrl   = (INPUT.maps_url || '').trim();

const LIMIT      = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100;
const TARGET_URL = /^https?:\/\//i.test(rawUrl) ? rawUrl : MAPS_URL_DEFAULT;

console.log('[INPUT] LIMIT =', LIMIT);
console.log('[INPUT] TARGET_URL =', TARGET_URL);

async function scrapeToTxt(limit, targetUrl) {
  const browser = await puppeteer.launch({
    headless: false, 
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu']
  });
  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  );
  await page.setViewport({ width: 1366, height: 900 });

  await page.goto(encodeURI(targetUrl), { waitUntil: 'domcontentloaded', timeout: 120000 });

  // İstasyon adı
  await page.waitForSelector('.iD2gKb.W1neJ', { timeout: 10000 }).catch(() => {});
  const stationName = (await firstText(page, [
    '.iD2gKb.W1neJ',
    '.DUwDvf.lfPIob',
    '[role="main"] h1'
  ])) || 'Bulunamadı';

  // Puan
  await page.waitForSelector('.fontDisplayLarge', { timeout: 10000 }).catch(() => {});
  const ratingText = (await firstText(page, [
    '.fontDisplayLarge',
    '.F7nice'
  ])) || 'Bulunamadı';

  // --- FİLTRE: En alakalı -> En yeni ---
  await selectNewestExplicit(page);         // buton.HQzyZ -> menü "En yeni"
  await new Promise(r => setTimeout(r, 2000)); // 2 sn filtre uygulaması

  // --- İlk yorum sahibinin üstüne gel, sonra wheel scroll ---
  const panelSelector = '.m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde';
  await page.waitForSelector(panelSelector, { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('.d4r55', { timeout: 15000 }).catch(() => {});
  const target = await page.$('.d4r55');
  if (target) {
    const box = await target.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      console.log('🖱 [SCROLL] Mouse ilk yorum sahibinin üstünde.');

      const scrollDuration = 30000; // 30 sn
      const start = Date.now();
      while (Date.now() - start < scrollDuration) {
        await page.mouse.wheel({ deltaY: 300 });
        await new Promise(r => setTimeout(r, 100));
      }
      console.log('✅ [SCROLL] 30 saniyelik mouse wheel scroll tamamlandı.');
    }
  } else {
    console.log('⚠ [SCROLL] İlk yorum sahibi (.d4r55) bulunamadı.');
  }

  // --- Senin eski akışın: yorumları yükle + daha fazla butonları ---
  await loadAllReviews(page, limit);
  await expandAllMore(page);

  // --- DEBUG (foto bölümü var mı?) ---
  const dbg = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.jftiEf'));
    const withPhoto = cards.filter(c => c.querySelector('.KtCyie'));
    const buttons = withPhoto.flatMap(c => Array.from(c.querySelectorAll('.KtCyie .Tya61d, [jsaction*="openPhoto"]')));
    return { cards: cards.length, withPhoto: withPhoto.length, buttons: buttons.length };
  });
  console.log(`🧪 Debug -> Yorum: ${dbg.cards}, FotoBölümü: ${dbg.withPhoto}, FotoButonu: ${dbg.buttons}`);

  // --- Yorumları topla (FOTOĞRAFLAR DAHİL) ---
  const reviews = await page.$$eval('.jftiEf', (blocks) => {
    const take = (el, sel) => el.querySelector(sel)?.textContent?.trim() || '';
    const takeAttr = (el, sel, attr) => el.querySelector(sel)?.getAttribute(attr) || '';

    // background-image URL'ini yakala (inline + computed)
    const pickBgUrl = (node) => {
      if (!node) return '';
      const s = node.getAttribute && node.getAttribute('style');
      if (s && /background-image/i.test(s)) {
        const m = s.match(/url\(["']?(.*?)["']?\)/i);
        if (m && m[1]) return m[1];
      }
      const win = node.ownerDocument && node.ownerDocument.defaultView;
      if (win) {
        const bg = win.getComputedStyle(node).backgroundImage || '';
        const m2 = bg.match(/url\(["']?(.*?)["']?\)/i);
        if (m2 && m2[1]) return m2[1];
      }
      return '';
    };

    return blocks.map((b) => {
      const name = take(b, '.d4r55') || take(b, '.fontTitleMedium');

      const starLabel = takeAttr(b, '.kvMYJc', 'aria-label') || '';
      const sm = starLabel.match(/(\d+)/);
      const stars = sm ? sm[1] : '';

      const date = take(b, '.rsqaWe');
      const text = take(b, '.MyEned .wiI7pd') || take(b, '.wiI7pd');
      const ownerReply = take(b, '.CDe7pd .wiI7pd');

      // 🔹 Fotoğraflar
      const photoUrls = [];

      // 1) .Tya61d butonları + olası openPhoto butonları
      b.querySelectorAll('.KtCyie .Tya61d, [jsaction*="openPhoto"]').forEach(btn => {
        const u = pickBgUrl(btn);
        if (u) photoUrls.push(u);
      });

      // 2) .KtCyie altında style="background-image:..."
      b.querySelectorAll('.KtCyie [style*="background-image"]').forEach(el => {
        const u = pickBgUrl(el);
        if (u) photoUrls.push(u);
      });

      // 3) <img src|srcset>
      b.querySelectorAll('.KtCyie img').forEach(img => {
        const srcset = img.getAttribute('srcset') || '';
        if (srcset) {
          const first = srcset.split(',')[0].trim().split(' ')[0];
          if (first) photoUrls.push(first);
        }
        const src = img.getAttribute('src') || '';
        if (src) photoUrls.push(src);
      });

      const photos = Array.from(new Set(photoUrls)).filter(Boolean);
      return { name, stars, date, text, ownerReply, photos };
    });
  });


  // --- JSON yaz ---
  const output = {
    stationName: stationName || '',
    stationRating: ratingText || '',
    reviews: reviews.slice(0, limit).map((r) => ({
      author: r.name || '',
      stars: r.stars ? Number(r.stars) : null,
      date: r.date || '',
      text: r.text || '',
      ownerReply: r.ownerReply || '',
      photos: Array.isArray(r.photos) ? r.photos : []
    }))
  };

  const outPath = path.join(__dirname, 'output.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log('✅ Bitti:', outPath);
  fs.writeFileSync(path.join(__dirname, 'argv.json'), JSON.stringify(process.argv, null, 2)); 
  console.log('✅ Bitti: output.json');

  // browser'ı kapatmak istemiyorsan yoruma al
  // await browser.close();
}

/* ----------------- Yardımcılar ----------------- */

// “En alakalı” butonuna bas → menüden “En yeni”yi seç
async function selectNewestExplicit(page) {
  console.log('🔄 [FILTER] "En alakalı" menüsü açılıyor…');

  // 1) "En alakalı" butonunu bul ve tıkla
  await page.waitForSelector('button.HQzyZ[aria-haspopup="true"]', { timeout: 15000 }).catch(() => {});
  const opened = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button.HQzyZ[aria-haspopup="true"]'));
    const btn = btns.find(b => {
      const label = (b.getAttribute('aria-label') || b.textContent || '').toLowerCase();
      return label.includes('en alakalı') || label.includes('sort');
    });
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!opened) {
    console.log('⚠ [FILTER] "En alakalı" butonu bulunamadı.');
    return;
  }
  await new Promise(r => setTimeout(r, 400)); // menünün açılması için kısa bekleme

  // 2) Menudan “En yeni” tıkla
  const clicked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.fxNQSd .mLuXec, .mLuXec'));
    const target = items.find(el => (el.textContent || '').trim().toLowerCase() === 'en yeni' || (el.textContent || '').trim().toLowerCase() === 'newest');
    if (target) { target.click(); return true; }
    return false;
  });

  if (clicked) {
    console.log('✅ [FILTER] "En yeni" seçildi.');
  } else {
    console.log('⚠ [FILTER] Menüsü açıldı ama "En yeni" maddesi bulunamadı.');
  }
}

async function firstText(page, selectors) {
  for (const sel of selectors) {
    const ok = await page.$(sel);
    if (ok) {
      const t = await page.$eval(sel, el => el.textContent.trim());
      if (t) return t;
    }
  }
  return '';
}

async function expandAllMore(page) {
  for (let round = 0; round < 8; round++) {
    const clicked = await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll('button.w8nwRe.kyuRq').forEach(btn => {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        const actions = btn.getAttribute('jsaction') || '';
        if (label.includes('daha fazla') || actions.includes('expandReview') || actions.includes('expandOwnerResponse')) {
          const rect = btn.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0;
          if (visible) { btn.click(); n++; }
        }
      });
      document.querySelectorAll('.CDe7pd button.w8nwRe.kyuRq').forEach(btn => {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) { btn.click(); n++; }
      });
      return n;
    });
    if (!clicked) break;
    await new Promise(r => setTimeout(r, 500));
  }
}

async function loadAllReviews(page, limit = 100) {
  await page.waitForSelector('.jftiEf').catch(() => {});
  let lastCount = 0;
  let stagnant = 0;
  for (let i = 0; i < 120; i++) {
    const count = await page.$$eval('.jftiEf', els => els.length);
    if (count >= limit) break;
    if (count === lastCount) stagnant++; else stagnant = 0;
    lastCount = count;

    await page.evaluate(() => {
      (document.scrollingElement || document.body).scrollBy(0, 1200);
    });
    await page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]');
      feed?.scrollBy(0, 1600);
      const last = document.querySelector('.jftiEf:last-child');
      last?.scrollIntoView({ behavior: 'instant', block: 'end' });
    });

    await new Promise(r => setTimeout(r, 700));
    if (stagnant >= 8) break;
  }
}

async function scrollReviewsPanel(page, limit = 100) {
  await page.waitForSelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde').catch(() => {});
  let lastCount = 0;
  let stagnant = 0;
  for (let i = 0; i < 200; i++) {
    const count = await page.$$eval('.jftiEf', els => els.length);
    if (count >= limit) break;
    if (count === lastCount) stagnant++; else stagnant = 0;
    lastCount = count;

    await page.evaluate(() => {
      const panel = document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde');
      if (panel) {
        panel.scrollBy(0, 1500);
        const last = panel.querySelector('.jftiEf:last-child');
        last?.scrollIntoView({ behavior: 'instant', block: 'end' });
      }
    });

    await new Promise(r => setTimeout(r, 700));
    if (stagnant >= 10) break;
  }
}

(async () => {
  try {
    await scrapeToTxt(LIMIT, TARGET_URL);
    process.exit(0);
  } catch (e) {
    console.error('❌ Hata (bot.js):', e?.stack || e);
    process.exit(1);
  }
})();

export async function runBot(limit = 20) {
  await scrapeToTxt(limit);
}
export { scrapeToTxt }; 