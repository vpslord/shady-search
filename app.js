// ============================================================
// Shady Search - منطق التطبيق
// ============================================================

const DB_CACHE_NAME = 'shady-search-db-v1';
const DB_CACHE_KEY = '/customers.db.assembled';

let db = null;
let allAreas = [];

const splashEl = document.getElementById('splash');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const statusText = document.getElementById('statusText');
const resultsEl = document.getElementById('results');
const searchInput = document.getElementById('searchInput');
const areaSelect = document.getElementById('areaSelect');
const toastEl = document.getElementById('toast');
const refreshBtn = document.getElementById('refreshBtn');

function setProgress(pct, status) {
  progressFill.style.width = pct + '%';
  progressText.textContent = Math.round(pct) + '%';
  if (status) statusText.textContent = status;
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 1200);
}

// -------------------- تجميع قاعدة البيانات من الأجزاء --------------------

async function getCachedDbBytes() {
  try {
    const cache = await caches.open(DB_CACHE_NAME);
    const match = await cache.match(DB_CACHE_KEY);
    if (match) {
      const buf = await match.arrayBuffer();
      return new Uint8Array(buf);
    }
  } catch (e) {
    console.warn('cache read failed', e);
  }
  return null;
}

async function cacheDbBytes(bytes) {
  try {
    const cache = await caches.open(DB_CACHE_NAME);
    const response = new Response(bytes, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    await cache.put(DB_CACHE_KEY, response);
  } catch (e) {
    console.warn('cache write failed', e);
  }
}

async function assembleDatabase() {
  // أول حاجة: هل عندنا نسخة محفوظة من قبل؟
  setProgress(0, 'بيتأكد من وجود نسخة محفوظة...');
  const cached = await getCachedDbBytes();
  if (cached && cached.length > 0) {
    setProgress(100, 'لقينا نسخة جاهزة');
    return cached;
  }

  // نزّل عدد الأجزاء
  setProgress(0, 'بيتم تجهيز البيانات لأول مرة...');
  const chunkCountText = await (await fetch('data/customers.db.chunks')).text();
  const totalChunks = parseInt(chunkCountText.trim(), 10);

  const parts = [];
  let totalBytes = 0;
  for (let i = 1; i <= totalChunks; i++) {
    const partName = String(i).padStart(3, '0');
    const resp = await fetch(`data/customers.db.part${partName}`);
    if (!resp.ok) throw new Error(`فشل تحميل الجزء ${partName}`);
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    parts.push(bytes);
    totalBytes += bytes.length;
    setProgress(
      (i / totalChunks) * 100,
      `بيتحمّل الجزء ${i} من ${totalChunks}...`
    );
  }

  // ادمج كل الأجزاء في مصفوفة واحدة
  setProgress(100, 'بيتم التجميع...');
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }

  await cacheDbBytes(merged);
  return merged;
}

// -------------------- تهيئة قاعدة البيانات --------------------

async function initDatabase() {
  const SQL = await initSqlJs({ locateFile: (file) => file });
  const bytes = await assembleDatabase();
  db = new SQL.Database(bytes);

  // حمّل قايمة المناطق
  try {
    const res = db.exec(
      "SELECT DISTINCT area FROM customers WHERE area IS NOT NULL AND area != '' ORDER BY area"
    );
    if (res.length > 0) {
      allAreas = res[0].values.map((row) => row[0]);
      for (const area of allAreas) {
        const opt = document.createElement('option');
        opt.value = area;
        opt.textContent = area;
        areaSelect.appendChild(opt);
      }
    }
  } catch (e) {
    console.warn('area load failed', e);
  }

  splashEl.style.display = 'none';
}

// -------------------- البحث --------------------

function runSearch() {
  const q = searchInput.value.trim();
  const area = areaSelect.value;

  if (!q && !area) {
    resultsEl.innerHTML = `<div class="empty-state">اكتب اسم أو تليفون أو اختار منطقة عشان تبدأ البحث</div>`;
    return;
  }

  let sql, params;
  const like = `%${q}%`;

  if (!q && area) {
    sql = `SELECT * FROM customers WHERE area = ? LIMIT 300`;
    params = [area];
  } else if (area) {
    sql = `
      SELECT * FROM customers
      WHERE (name LIKE ? OR area LIKE ? OR phone1 LIKE ? OR phone2 LIKE ?
         OR phone3 LIKE ? OR description LIKE ? OR street LIKE ?
         OR building LIKE ? OR floor LIKE ? OR apartment LIKE ? OR notes LIKE ?)
        AND area = ?
      LIMIT 300
    `;
    params = [like, like, like, like, like, like, like, like, like, like, like, area];
  } else {
    sql = `
      SELECT * FROM customers
      WHERE name LIKE ? OR area LIKE ? OR phone1 LIKE ? OR phone2 LIKE ?
         OR phone3 LIKE ? OR description LIKE ? OR street LIKE ?
         OR building LIKE ? OR floor LIKE ? OR apartment LIKE ? OR notes LIKE ?
      LIMIT 300
    `;
    params = [like, like, like, like, like, like, like, like, like, like, like];
  }

  let rows = [];
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
  } catch (e) {
    resultsEl.innerHTML = `<div class="empty-state">حصل خطأ أثناء البحث: ${e.message}</div>`;
    return;
  }

  renderResults(rows);
}

function renderResults(rows) {
  if (rows.length === 0) {
    resultsEl.innerHTML = `<div class="empty-state">مفيش نتايج</div>`;
    return;
  }

  resultsEl.innerHTML = rows.map(rowToCardHtml).join('');

  // اربط أحداث النسخ لكل رقم
  resultsEl.querySelectorAll('.phone-chip').forEach((btn) => {
    btn.addEventListener('click', () => copyPhone(btn.dataset.phone));
  });
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function rowToCardHtml(row) {
  const name = row.name || '';
  const area = row.area || '';
  const phones = [row.phone1, row.phone2, row.phone3].filter((p) => p && p.trim());
  const addressParts = [
    ['الشارع', row.street],
    ['الوصف', row.description],
    ['رقم العقار', row.building],
    ['الدور', row.floor],
    ['الشقة', row.apartment],
    ['ملاحظات', row.notes],
  ].filter(([, v]) => v && v.trim());

  const initial = name ? esc(name.substring(0, 1)) : '?';

  const phonesHtml = phones.length
    ? `<div class="phones">${phones
        .map(
          (p) =>
            `<button class="phone-chip" data-phone="${esc(p)}">📞 ${esc(p)} 📋</button>`
        )
        .join('')}</div>`
    : '';

  const addressHtml = addressParts.length
    ? `<div class="address-lines">${addressParts
        .map(([label, val]) => `<div><b>${esc(label)}:</b> ${esc(val)}</div>`)
        .join('')}</div>`
    : '';

  return `
    <div class="card">
      <div class="card-top">
        <div class="avatar">${initial}</div>
        <div class="name">${esc(name) || '(بدون اسم)'}</div>
        ${area ? `<div class="area-chip">${esc(area)}</div>` : ''}
      </div>
      ${phonesHtml}
      ${addressHtml}
    </div>
  `;
}

function copyPhone(phone) {
  navigator.clipboard
    .writeText(phone)
    .then(() => showToast(`اتنسخ الرقم: ${phone}`))
    .catch(() => {
      // فولباك لو الكوبي API مش شغالة
      const ta = document.createElement('textarea');
      ta.value = phone;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(`اتنسخ الرقم: ${phone}`);
    });
}

// -------------------- إعادة التجهيز --------------------

async function resetDatabase() {
  if (!confirm('هيتم إعادة تحميل البيانات من جديد. متأكد؟')) return;
  try {
    const cache = await caches.open(DB_CACHE_NAME);
    await cache.delete(DB_CACHE_KEY);
  } catch (e) {
    console.warn(e);
  }
  location.reload();
}

// -------------------- ربط الأحداث --------------------

let debounceTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, 300);
});
areaSelect.addEventListener('change', runSearch);
refreshBtn.addEventListener('click', resetDatabase);

// -------------------- تسجيل Service Worker (للعمل أوفلاين) --------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((e) => {
      console.warn('service worker registration failed', e);
    });
  });
}

// -------------------- البدء --------------------

initDatabase().catch((e) => {
  statusText.textContent = 'حصلت مشكلة: ' + e.message;
  console.error(e);
});
