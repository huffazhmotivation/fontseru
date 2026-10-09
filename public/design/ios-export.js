/*
 * Perbaikan export Design Mode untuk iPad/iPhone (Safari, Chrome iOS, dan PWA "Add to Home Screen").
 *
 * MASALAH ASLI
 *  1. Bundle menyimpan file dengan <a download>.click() SETELAH proses render yang async. iOS hanya
 *     mengizinkan unduhan/share di dalam gestur sentuhan langsung; klik programatik sesudahnya (apalagi
 *     beberapa file berturut-turut saat "slice") diabaikan TANPA error — tetapi fungsinya tetap
 *     mengembalikan "saved", maka muncul toast "berhasil" padahal tidak ada file.
 *  2. Canvas di iOS dibatasi (~16,7 juta piksel). Skala 2x/3x pada objek besar menghasilkan canvas kosong
 *     atau toBlob() = null, dan canvas lama menumpuk di memori sehingga ekspor berikutnya ikut gagal
 *     ("sempat berhasil lalu gagal").
 *
 * SOLUSI
 *  - Di iOS, file ditampung lalu ditampilkan di panel "Ekspor siap" dengan tombol yang diketuk pengguna
 *    (gestur asli): Simpan/Bagikan (share sheet → Simpan ke File / Simpan Gambar), Unduh per file, dan
 *    Unduh ZIP bila lebih dari satu file. Gambar juga ditampilkan agar bisa ditahan lama → Simpan ke Foto.
 *  - Skala canvas dibatasi di iOS dan canvas dilepas segera setelah dipakai.
 */
(function () {
  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var MAX_PIXELS = 12e6;   // ~48 MB per canvas: aman untuk iPad lama
  var MAX_SIDE = 8192;

  window.__dsIsIOS = isIOS;

  /** Batasi skala render supaya canvas tidak melewati batas iOS. Di platform lain tidak mengubah apa pun. */
  window.__dsClampScale = function (w, h, scale) {
    if (!isIOS || !(w > 0) || !(h > 0)) return scale;
    var s = scale;
    if (w * h * s * s > MAX_PIXELS) s = Math.sqrt(MAX_PIXELS / (w * h));
    if (Math.max(w, h) * s > MAX_SIDE) s = MAX_SIDE / Math.max(w, h);
    return s < scale ? Math.max(s, 0.05) : scale;
  };

  var MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf', eps: 'application/postscript', zip: 'application/zip', json: 'application/json'
  };
  function extOf(n) { var i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; }
  function mimeOf(n) { return MIME[extOf(n)] || 'application/octet-stream'; }
  function isImg(n) { var e = extOf(n); return e === 'png' || e === 'jpg' || e === 'jpeg' || e === 'webp' || e === 'svg'; }
  function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }

  /* ---------- ZIP (tanpa kompresi) ---------- */
  var crcT = (function () {
    var t = [], c, n, k;
    for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = crcT[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function makeZip(items) {
    var chunks = [], central = [], offset = 0, enc = new TextEncoder();
    items.forEach(function (it) {
      var nameB = enc.encode(it.name), crc = crc32(it.data), sz = it.data.length;
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true);
      lh.setUint16(26, nameB.length, true); lh.setUint16(28, 0, true);
      chunks.push(new Uint8Array(lh.buffer), nameB, it.data);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true);
      ch.setUint16(28, nameB.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nameB);
      offset += 30 + nameB.length + sz;
    });
    var cd = 0; central.forEach(function (c) { cd += c.length; });
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, items.length, true); end.setUint16(10, items.length, true);
    end.setUint32(12, cd, true); end.setUint32(16, offset, true);
    return new Blob(chunks.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
  }
  window.__dsMakeZip = makeZip;

  /* ---------- antrean + panel "Ekspor siap" ---------- */
  var items = [];          // { name, file, url }
  var root = null, list = null, zipFile = null, zipState = 'idle', timer = 0;

  function uniqueName(name) {
    var taken = {}; items.forEach(function (i) { taken[i.name] = 1; });
    if (!taken[name]) return name;
    var d = name.lastIndexOf('.'), base = d > 0 ? name.slice(0, d) : name, ext = d > 0 ? name.slice(d) : '';
    for (var n = 2; n < 999; n++) { var c = base + ' (' + n + ')' + ext; if (!taken[c]) return c; }
    return name;
  }

  function canShareFiles(files) {
    try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: files })); } catch (e) { return false; }
  }
  function anchorDownload(file) {
    var url = URL.createObjectURL(file);
    var a = document.createElement('a');
    a.href = url; a.download = file.name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
  }
  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  /* Warna mengikuti token tema app (--c-*) sehingga otomatis terang/gelap; angka cadangan = tema gelap. */
  var C = {
    panel: 'rgb(var(--c-panel,21 24 22))', text: 'rgb(var(--c-text,232 236 232))', muted: 'rgb(var(--c-muted,140 147 140))',
    border: 'rgb(var(--c-border,37 41 38))', input: 'rgb(var(--c-input,28 32 29))', hover: 'rgb(var(--c-hover,31 35 32))',
    accent: 'rgb(var(--c-accent,255 77 166))', onAccent: 'rgb(var(--c-on-accent,26 7 16))'
  };
  var FONT = 'ds-ui,-apple-system,system-ui,sans-serif';
  function btn(label, primary, onClick) {
    var b = el('button',
      'appearance:none;-webkit-appearance:none;border:0;border-radius:10px;padding:0 16px;min-height:44px;font:600 14px/1 ' + FONT + ';' +
      'touch-action:manipulation;cursor:pointer;flex:none;' +
      (primary ? 'background:' + C.accent + ';color:' + C.onAccent + ';'
               : 'background:' + C.input + ';color:' + C.text + ';box-shadow:inset 0 0 0 1px ' + C.border + ';'), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function prepareZip() {
    zipFile = null; zipState = 'idle';
    if (items.length < 2) return;
    zipState = 'busy';
    var snapshot = items.slice();
    Promise.all(snapshot.map(function (it) {
      return it.file.arrayBuffer().then(function (b) { return { name: it.name, data: new Uint8Array(b) }; });
    })).then(function (parts) {
      if (snapshot.length !== items.length) return; // daftar berubah, render ulang yang menyiapkan lagi
      zipFile = new File([makeZip(parts)], 'ekspor-designseru.zip', { type: 'application/zip' });
      zipState = 'ready'; render();
    }).catch(function () { zipState = 'error'; render(); });
  }

  function close() {
    if (root) root.remove();
    items.forEach(function (i) { if (i.url) URL.revokeObjectURL(i.url); });
    items = []; root = null; list = null; zipFile = null; zipState = 'idle';
  }

  function open() {
    if (root) return;
    // Modal di tengah layar (bukan bottom sheet); jarak aman dari notch / home indicator
    root = el('div',
      'position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);' +
      'padding:max(20px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));' +
      'box-sizing:border-box;');
    var sheet = el('div',
      'width:min(520px,100%);max-height:100%;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;' +
      'background:' + C.panel + ';color:' + C.text + ';border:1px solid ' + C.border + ';border-radius:16px;padding:20px;' +
      'font:14px/1.45 ' + FONT + ';box-shadow:var(--glass-shadow,0 24px 60px rgba(0,0,0,.45));');
    sheet.id = 'ds-export-sheet';
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
    root.appendChild(sheet);
    root.addEventListener('click', function (e) { if (e.target === root) close(); });
    document.body.appendChild(root);
    list = sheet;
    try {
      sheet.animate([{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 160, easing: 'ease-out' });
      root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    } catch (e) { /* animasi opsional */ }
    render();
  }

  function render() {
    if (!root || !list) return;
    var sheet = list; sheet.textContent = '';
    var n = items.length;
    sheet.appendChild(el('div', 'font:700 17px/1.3 ' + FONT + ';margin-bottom:4px;flex:none;',
      n > 1 ? 'Ekspor siap · ' + n + ' file' : 'Ekspor siap'));
    sheet.appendChild(el('div', 'color:' + C.muted + ';font-size:13px;margin-bottom:14px;flex:none;',
      'Ketuk Simpan / Bagikan, lalu pilih “Simpan ke File” atau “Simpan Gambar”. File belum tersimpan sebelum langkah ini.'));

    var files = items.map(function (i) { return i.file; });
    var actions = el('div', 'display:flex;flex-direction:column;gap:8px;margin-bottom:12px;flex:none;');
    if (canShareFiles(files)) {
      actions.appendChild(btn('Simpan / Bagikan' + (n > 1 ? ' (' + n + ' file)' : ''), true, function () {
        // dipanggil langsung dari ketukan → iOS mengizinkan share sheet
        navigator.share({ files: files }).catch(function (err) {
          if (err && err.name === 'AbortError') return;
          note('Share sheet gagal dibuka (' + ((err && err.message) || 'tidak diketahui') + '). Pakai tombol Unduh atau tahan lama gambarnya.');
        });
      }));
    }
    if (n > 1) {
      var zb = btn(zipState === 'busy' ? 'Menyiapkan ZIP…' : 'Simpan semua sebagai ZIP', false, function () {
        if (!zipFile) return;
        if (canShareFiles([zipFile])) {
          navigator.share({ files: [zipFile] }).catch(function (err) { if (!err || err.name !== 'AbortError') anchorDownload(zipFile); });
        } else anchorDownload(zipFile);
      });
      if (zipState !== 'ready') { zb.disabled = true; zb.style.opacity = '.55'; }
      if (zipState === 'error') zb.textContent = 'ZIP gagal dibuat — unduh satu per satu';
      actions.appendChild(zb);
    }
    sheet.appendChild(actions);

    var noteBox = el('div', 'color:#e5484d;font-size:13px;margin:0 0 10px;display:none;flex:none;'); noteBox.id = 'ds-export-note';
    sheet.appendChild(noteBox);

    // Daftar file: bagian yang bisa di-scroll bila file banyak, header & tombol tetap terlihat
    var scroller = el('div', 'flex:1 1 auto;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;border-top:1px solid ' + C.border + ';');
    items.forEach(function (it, idx) {
      var row = el('div', 'display:flex;gap:12px;align-items:center;padding:10px 0;' + (idx ? 'border-top:1px solid ' + C.border + ';' : ''));
      if (isImg(it.name)) {
        if (!it.url) it.url = URL.createObjectURL(it.file);
        var img = el('img', 'width:56px;height:56px;object-fit:contain;border-radius:8px;flex:none;border:1px solid ' + C.border + ';' +
          'background:repeating-conic-gradient(' + C.input + ' 0% 25%,' + C.hover + ' 0% 50%) 50%/12px 12px;-webkit-touch-callout:default;');
        img.src = it.url; img.alt = it.name; img.draggable = true;
        row.appendChild(img);
      } else {
        row.appendChild(el('div', 'width:56px;height:56px;border-radius:8px;flex:none;display:flex;align-items:center;justify-content:center;background:' + C.input + ';border:1px solid ' + C.border + ';font-weight:700;color:' + C.accent + ';',
          extOf(it.name).toUpperCase()));
      }
      var meta = el('div', 'min-width:0;flex:1;');
      meta.appendChild(el('div', 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', it.name));
      meta.appendChild(el('div', 'color:' + C.muted + ';font-size:12px;',
        fmtSize(it.file.size) + (isImg(it.name) && extOf(it.name) !== 'svg' ? ' · tahan lama gambar → Simpan ke Foto' : '')));
      row.appendChild(meta);
      row.appendChild(btn('Unduh', false, function () { anchorDownload(it.file); }));
      scroller.appendChild(row);
    });
    sheet.appendChild(scroller);

    var foot = el('div', 'margin-top:12px;display:flex;justify-content:flex-end;flex:none;');
    foot.appendChild(btn('Selesai', false, close));
    sheet.appendChild(foot);
  }

  function note(msg) {
    var b = document.getElementById('ds-export-note');
    if (b) { b.textContent = msg; b.style.display = 'block'; }
  }

  /** Dipanggil Zm() di iOS. Mengembalikan "saved" = file berhasil DITAMPUNG; pengguna menyimpannya di panel. */
  window.__dsIosSave = function (name, data) {
    try {
      var type = (data && data.type && data.type !== 'application/octet-stream') ? data.type : mimeOf(name);
      var file = new File([data], uniqueName(name), { type: type });
      if (!file.size) return Promise.resolve('failed');
      items.push({ name: file.name, file: file, url: null });
      if (root) { zipFile = null; render(); prepareZip(); }
      else { clearTimeout(timer); timer = setTimeout(window.__dsFlush, 1800); }
      return Promise.resolve('saved');
    } catch (e) {
      return Promise.resolve('failed');
    }
  };

  /** Tampilkan panel sekarang (dipanggil di akhir runExport; juga otomatis 1,8 dtk setelah file terakhir). */
  window.__dsFlush = function () {
    clearTimeout(timer);
    if (!items.length) return;
    if (!root) { open(); prepareZip(); }
    else { render(); prepareZip(); }
  };
})();
