/* Tiehavainnot – PWA
 * Kamerat ja E85-asemat: OpenStreetMap (Overpass API)
 * Käyttäjäilmoitukset: Firebase Realtime Database (REST) tai paikallinen tallennus
 */
(() => {
  'use strict';

  // ---------- Asetukset ----------
  const TYPES = {
    police:    { icon: 'P', name: 'Poliisi',          ttlMin: 120,  cls: '' },
    mobilecam: { icon: 'K', name: 'Peltipoliisiauto', ttlMin: 180,  cls: '' },
    hazard:    { icon: '!', name: 'Vaara tiellä',     ttlMin: 120,  cls: '' },
    e85:       { icon: 'E', name: 'E85-asema',         ttlMin: 0,    cls: 'e85' }, // 0 = pysyvä
  };
  const OSM_CACHE_KEY = 'th_osm_v1';
  const OSM_MAX_AGE = 24 * 3600 * 1000;
  const POLL_MS = 30000;
  const OVERPASS_URLS = [
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];
  const SNAPSHOT_URL = 'data/osm.json'; // GitHub Actions päivittää tämän päivittäin
  const OVERPASS_QUERY = `[out:json][timeout:90];
area["ISO3166-1"="FI"][admin_level=2]->.fi;
(
  node["highway"="speed_camera"](area.fi);
  nwr["amenity"="fuel"]["fuel:e85"="yes"](area.fi);
);
out center tags;`;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const settings = Object.assign(
    { dbUrl: '', warnCam: 600, warnRep: 800, sound: true, layers: { camera: true, e85: true, reports: true } },
    store.get('th_settings', {})
  );
  const saveSettings = () => store.set('th_settings', settings);

  // ---------- Apu ----------
  const $ = (id) => document.getElementById(id);
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  function dist(a, b) {
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearing(a, b) {
    const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
              Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  const fmtDist = (m) => m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
  function fmtAge(t) {
    const min = Math.round((Date.now() - t) / 60000);
    if (min < 1) return 'juuri nyt';
    if (min < 60) return `${min} min sitten`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${h} h sitten`;
    return new Date(t).toLocaleDateString('fi-FI');
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer;
  function toast(msg, ms = 2500) {
    const el = $('toast'); el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  // ---------- Kartta ----------
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([62.5, 25.5], 6);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19, subdomains: 'abcd', attribution: '© OpenStreetMap © CARTO',
  }).addTo(map);

  const layers = {
    camera: L.layerGroup(),
    e85: L.layerGroup(),
    reports: L.layerGroup(),
  };
  const e85Osm = L.layerGroup().addTo(layers.e85);   // OSM:n asemat
  const e85User = L.layerGroup().addTo(layers.e85);  // käyttäjien ilmoittamat asemat
  Object.entries(layers).forEach(([k, lg]) => { if (settings.layers[k]) lg.addTo(map); });

  const camIcon = L.divIcon({ className: '', html: '<div class="mk-cam"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
  const e85Icon = L.divIcon({ className: '', html: '<div class="mk-e85"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });
  const repIcon = (t) => L.divIcon({ className: '', html: `<div class="mk-rep ${t === 'e85' ? 'light' : ''}">${TYPES[t].icon}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
  const ALERT_SVG = {
    cam: '<g fill="none" stroke="#fff" stroke-width="1.6"><rect x="3" y="7" width="13" height="10" rx="2"/><path d="m16 11 5-3v8l-5-3"/></g>',
    police: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z" fill="none" stroke="#fff" stroke-width="1.6"/>',
    mobilecam: '<g fill="none" stroke="#fff" stroke-width="1.6"><rect x="3" y="7" width="18" height="12" rx="2"/><circle cx="12" cy="13" r="3"/></g>',
    hazard: '<g fill="none" stroke="#fff" stroke-width="1.6"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17v.5"/></g>',
  };
  const meMarker = L.marker([0, 0], {
    icon: L.divIcon({ className: '', html: '<div class="mk-me"><svg viewBox="0 0 24 24"><path d="M12 2 19 21 12 17 5 21z" fill="#fff"/></svg></div>', iconSize: [40, 40], iconAnchor: [20, 20] }),
    zIndexOffset: 1000,
  });

  // ---------- Tila ----------
  let me = null;           // {lat, lon, speed (km/h), heading}
  let lastPos = null;
  let follow = true;
  let osmPoints = [];      // {id, kind:'camera'|'e85', lat, lon, tags}
  let reports = [];        // {id, type, lat, lon, t}
  const alerted = new Map(); // id -> true

  // ---------- OSM-data ----------
  async function loadOsm(force = false) {
    const cached = store.get(OSM_CACHE_KEY, null);
    if (cached && !force && Date.now() - cached.t < OSM_MAX_AGE) {
      osmPoints = cached.points; renderOsm(); updateOsmInfo(cached); return;
    }
    if (cached) { osmPoints = cached.points; renderOsm(); }
    $('status').textContent = 'Ladataan kameroita ja asemia…';
    const parse = (json) => json.elements.map((el) => {
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      const kind = el.tags?.highway === 'speed_camera' ? 'camera' : 'e85';
      return { id: `osm-${el.type}-${el.id}`, kind, lat, lon, tags: el.tags || {} };
    }).filter((p) => p.lat != null);
    const sources = [
      // 1) Repoon tallennettu, päivittäin päivittyvä kopio (nopea ja luotettava)
      () => fetch(SNAPSHOT_URL, { cache: 'no-cache' }),
      // 2) Overpass-palvelimet suoraan
      ...OVERPASS_URLS.map((url) => () => fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(OVERPASS_QUERY),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(45000) })),
    ];
    for (const src of sources) {
      try {
        const res = await src();
        if (!res.ok) throw new Error(res.status);
        const json = await res.json();
        const points = parse(json);
        if (!points.length) throw new Error('tyhjä');
        const data = { t: Date.now(), points };
        store.set(OSM_CACHE_KEY, data);
        osmPoints = points; renderOsm(); updateOsmInfo(data); checkWarnings();
        toast(`Ladattu ${points.filter(p => p.kind === 'camera').length} kameraa ja ${points.filter(p => p.kind === 'e85').length} E85-asemaa`);
        return;
      } catch (e) { console.warn('Lähde epäonnistui', e); }
    }
    toast('Kameratietojen lataus epäonnistui – yritä myöhemmin uudelleen', 4000);
  }
  function updateOsmInfo(data) {
    const c = data.points.filter(p => p.kind === 'camera').length;
    const e = data.points.filter(p => p.kind === 'e85').length;
    $('osmInfo').textContent = `OSM-data: ${c} kameraa, ${e} E85-asemaa · päivitetty ${fmtAge(data.t)}`;
  }
  function renderOsm() {
    layers.camera.clearLayers(); e85Osm.clearLayers();
    for (const p of osmPoints) {
      const t = p.tags;
      let html;
      if (p.kind === 'camera') {
        html = `<b>Nopeuskamera</b>${t.maxspeed ? `<br>Rajoitus: ${esc(t.maxspeed)} km/h` : ''}${t.direction ? `<br>Suunta: ${esc(t.direction)}` : ''}`;
      } else {
        html = `<b>${esc(t.name || t.brand || 'E85-asema')}</b>${t['addr:street'] ? `<br>${esc(t['addr:street'])} ${esc(t['addr:housenumber'] || '')}` : ''}${t.opening_hours ? `<br>Auki: ${esc(t.opening_hours)}` : ''}<br><small>Lähde: OpenStreetMap</small>`;
      }
      L.marker([p.lat, p.lon], { icon: p.kind === 'camera' ? camIcon : e85Icon })
        .bindPopup(html).addTo(p.kind === 'camera' ? layers.camera : e85Osm);
    }
  }

  // ---------- Ilmoitukset (Firebase REST tai paikallinen) ----------
  const LOCAL_KEY = 'th_local_reports';
  const dbBase = () => settings.dbUrl.replace(/\/+$/, '');
  const isAlive = (r) => {
    const ttl = TYPES[r.type]?.ttlMin;
    return ttl === 0 || (ttl && Date.now() - r.t < ttl * 60000);
  };

  async function fetchReports() {
    if (!settings.dbUrl) {
      reports = store.get(LOCAL_KEY, []).filter(isAlive);
      store.set(LOCAL_KEY, reports);
      renderReports(); checkWarnings(); return;
    }
    try {
      const res = await fetch(`${dbBase()}/reports.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      const obj = (await res.json()) || {};
      const all = Object.entries(obj).map(([id, r]) => ({ id, ...r }))
        .filter((r) => TYPES[r.type] && typeof r.lat === 'number' && typeof r.lon === 'number');
      reports = all.filter(isAlive);
      renderReports(); checkWarnings();
      // Siivoa vanhentuneet
      all.filter((r) => !isAlive(r)).slice(0, 20).forEach((r) =>
        fetch(`${dbBase()}/reports/${encodeURIComponent(r.id)}.json`, { method: 'DELETE' }).catch(() => {}));
    } catch (e) {
      console.warn('Ilmoitusten haku epäonnistui', e);
      $('status').textContent = 'Ei yhteyttä ilmoituspalvelimeen';
    }
  }

  async function addReport(type) {
    if (!me) { toast('Sijaintia ei vielä tiedossa'); return; }
    // Estä tuplailmoitus samasta paikasta
    const dup = reports.find((r) => r.type === type && dist(r, me) < 150 && (TYPES[type].ttlMin === 0 || Date.now() - r.t < 10 * 60000));
    if (dup) { toast('Tästä on jo ilmoitettu lähellä'); return; }
    const r = { type, lat: +me.lat.toFixed(5), lon: +me.lon.toFixed(5), t: Date.now() };
    if (navigator.vibrate) navigator.vibrate(60);
    if (!settings.dbUrl) {
      const list = store.get(LOCAL_KEY, []);
      list.push({ id: 'loc-' + r.t, ...r }); store.set(LOCAL_KEY, list);
      await fetchReports();
      toast(`${TYPES[type].name} ilmoitettu (vain tähän puhelimeen)`);
      return;
    }
    try {
      const res = await fetch(`${dbBase()}/reports.json`, { method: 'POST', body: JSON.stringify(r) });
      if (!res.ok) throw new Error(res.status);
      await fetchReports();
      toast(`${TYPES[type].name} ilmoitettu – kiitos!`);
    } catch (e) {
      toast('Ilmoituksen lähetys epäonnistui', 3500);
    }
  }

  async function removeReport(id) {
    if (id.startsWith('loc-')) {
      store.set(LOCAL_KEY, store.get(LOCAL_KEY, []).filter((r) => r.id !== id));
    } else if (settings.dbUrl) {
      try { await fetch(`${dbBase()}/reports/${encodeURIComponent(id)}.json`, { method: 'DELETE' }); } catch {}
    }
    map.closePopup();
    await fetchReports();
    toast('Poistettu');
  }
  window.__thRemove = removeReport;

  function renderReports() {
    layers.reports.clearLayers(); e85User.clearLayers();
    for (const r of reports) {
      const ty = TYPES[r.type];
      const btn = ty.ttlMin === 0 ? 'Poista asema' : 'Ei enää paikalla';
      const html = `<b>${ty.name}</b><br>${fmtAge(r.t)}${me ? `<br>${fmtDist(dist(me, r))} päässä` : ''}
        <br><button onclick="__thRemove('${esc(r.id)}')">${btn}</button>`;
      // E85-käyttäjäilmoitukset näytetään E85-tasolla
      const target = r.type === 'e85' ? e85User : layers.reports;
      L.marker([r.lat, r.lon], { icon: repIcon(r.type) }).bindPopup(html).addTo(target);
    }
  }

  // ---------- Varoitukset ----------
  let audioCtx;
  function beep(times = 2) {
    if (!settings.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < times; i++) {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = 880;
        const t0 = audioCtx.currentTime + i * 0.28;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.25);
      }
    } catch {}
  }

  // Selaimet sallivat äänen vasta ensimmäisen kosketuksen jälkeen
  document.addEventListener('pointerdown', () => {
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch {}
  }, { once: true });

  function checkWarnings() {
    if (!me) return;
    const candidates = [];
    if (settings.layers.camera) osmPoints.filter((p) => p.kind === 'camera')
      .forEach((p) => candidates.push({ id: p.id, lat: p.lat, lon: p.lon, icon: 'cam', title: 'Nopeuskamera', cls: 'cam', range: settings.warnCam, limit: parseInt(p.tags.maxspeed) || 0, extra: p.tags.maxspeed ? ` · ${p.tags.maxspeed} km/h` : '' }));
    if (settings.layers.reports) reports.filter((r) => r.type !== 'e85')
      .forEach((r) => candidates.push({ id: r.id, lat: r.lat, lon: r.lon, icon: r.type, title: TYPES[r.type].name, cls: TYPES[r.type].cls, range: settings.warnRep, extra: ` · ${fmtAge(r.t)}` }));

    const moving = me.speed != null && me.speed > 8 && me.heading != null;
    let best = null;
    for (const c of candidates) {
      const d = dist(me, c);
      if (d > c.range * 1.5) { alerted.delete(c.id); continue; }
      if (d > c.range) continue;
      // Liikkeessä: varoita vain edessä olevista (±50°), paitsi jos aivan vieressä
      if (moving && d > 120 && angDiff(bearing(me, c), me.heading) > 50) continue;
      if (!best || d < best.d) best = { ...c, d };
    }
    const el = $('alert');
    if (!best) { el.classList.add('hidden'); $('speed').classList.remove('over'); return; }
    el.className = best.cls || '';
    $('alertIcon').innerHTML = ALERT_SVG[best.icon] || '';
    $('speed').classList.toggle('over', !!best.limit && me.speed != null && me.speed > best.limit + 3);
    $('alertTitle').textContent = best.title;
    $('alertDist').textContent = `${fmtDist(best.d)} edessä${best.extra}`;
    if (!alerted.has(best.id)) {
      alerted.set(best.id, true);
      beep(best.cls === 'cam' ? 2 : 3);
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }
  }

  // ---------- GPS ----------
  function onPos(pos) {
    const c = pos.coords;
    const cur = { lat: c.latitude, lon: c.longitude };
    let speed = c.speed != null && !isNaN(c.speed) ? c.speed * 3.6 : null;
    let heading = c.heading != null && !isNaN(c.heading) ? c.heading : null;
    if (lastPos) {
      const d = dist(lastPos, cur), dt = (pos.timestamp - lastPos.ts) / 1000;
      if (speed == null && dt > 0.5) { const v = (d / dt) * 3.6; if (v < 300) speed = v; }
      if (heading == null && d > 8) heading = bearing(lastPos, cur);
    }
    if (heading == null && me?.heading != null) heading = me.heading;
    me = { ...cur, speed, heading, acc: c.accuracy };
    lastPos = { ...cur, ts: pos.timestamp };

    $('speedVal').textContent = speed != null ? Math.round(speed) : '–';
    $('status').textContent = c.accuracy > 100 ? `GPS epätarkka (±${Math.round(c.accuracy)} m)` : 'Sijainti OK';
    meMarker.setLatLng([me.lat, me.lon]);
    const arrow = meMarker.getElement()?.querySelector('svg');
    if (arrow) arrow.style.transform = `rotate(${me.heading || 0}deg)`;
    if (!map.hasLayer(meMarker)) { meMarker.addTo(map); map.setView([me.lat, me.lon], 15); }
    else if (follow) map.panTo([me.lat, me.lon], { animate: true });
    checkWarnings();
  }
  function onPosErr(err) {
    $('status').textContent = err.code === 1
      ? 'Sijaintilupa evätty – salli sijainti selaimen asetuksista'
      : 'Sijaintia ei saatu';
  }
  if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  } else {
    $('status').textContent = 'Laite ei tue sijaintia';
  }

  // Näyttö päällä ajon aikana
  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { keepAwake(); fetchReports(); } });
  keepAwake();

  // ---------- UI ----------
  map.on('dragstart', () => { follow = false; $('btnFollow').classList.remove('active'); });
  $('btnFollow').onclick = () => {
    follow = true; $('btnFollow').classList.add('active');
    if (me) map.setView([me.lat, me.lon], Math.max(map.getZoom(), 15));
  };
  $('btnLayers').onclick = () => $('layersPanel').classList.toggle('hidden');
  document.querySelectorAll('#layersPanel input[data-layer]').forEach((inp) => {
    const k = inp.dataset.layer; inp.checked = settings.layers[k];
    inp.onchange = () => {
      settings.layers[k] = inp.checked; saveSettings();
      inp.checked ? layers[k].addTo(map) : map.removeLayer(layers[k]);
      checkWarnings();
    };
  });
  $('chkSound').checked = settings.sound;
  $('chkSound').onchange = (e) => { settings.sound = e.target.checked; saveSettings(); if (settings.sound) beep(1); };

  document.querySelectorAll('.rep').forEach((b) => { b.onclick = () => { addReport(b.dataset.type); }; });

  $('btnSettings').onclick = () => {
    $('dbUrl').value = settings.dbUrl; $('warnCam').value = settings.warnCam; $('warnRep').value = settings.warnRep;
    const c = store.get(OSM_CACHE_KEY, null); if (c) updateOsmInfo(c);
    $('settings').classList.remove('hidden');
  };
  $('btnCloseSettings').onclick = () => {
    const url = $('dbUrl').value.trim();
    if (url && !/^https:\/\/[^/]+\.(firebaseio\.com|firebasedatabase\.app)\/?$/.test(url)) {
      toast('Osoitteen pitää olla Firebase Realtime Database -osoite (https://…firebaseio.com tai …firebasedatabase.app)', 4500);
      return;
    }
    settings.dbUrl = url;
    settings.warnCam = Math.min(2000, Math.max(100, +$('warnCam').value || 600));
    settings.warnRep = Math.min(3000, Math.max(100, +$('warnRep').value || 800));
    saveSettings(); $('settings').classList.add('hidden');
    fetchReports(); toast('Tallennettu');
  };
  $('btnRefreshOsm').onclick = () => loadOsm(true);

  // ---------- Käynnistys ----------
  loadOsm();
  fetchReports();
  setInterval(fetchReports, POLL_MS);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
