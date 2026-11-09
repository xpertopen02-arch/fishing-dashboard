(() => {
  "use strict";
  const { places: PLACES, pages: PAGES } = window.FISH;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem("fish." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("fish." + k, JSON.stringify(v)); } catch { /* storage may be blocked */ } },
  };
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TYPES = ["민물", "송어", "바다"];
  const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
  const TZ = "Asia%2FSeoul";

  const pad = (n) => String(n).padStart(2, "0");
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return toISO(d); };
  const TODAY = toISO(new Date());
  const diffDays = (a, b) => Math.round((parseISO(a) - parseISO(b)) / 864e5);
  const dayOfYear = (s) => { const d = parseISO(s); return Math.round((d - new Date(d.getFullYear(), 0, 0)) / 864e5); };
  const seasonGap = (a, b) => { const g = Math.abs(dayOfYear(a) - dayOfYear(b)); return Math.min(g, 365 - g); };
  const fmtDate = (s) => { const d = parseISO(s); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} (${WEEK[d.getDay()]})`; };
  const fmtShort = (s) => { const d = parseISO(s); return `${d.getMonth() + 1}/${d.getDate()} ${WEEK[d.getDay()]}`; };
  const compass = (deg) => ["북", "북북동", "북동", "동북동", "동", "동남동", "남동", "남남동", "남", "남남서", "남서", "서남서", "서", "서북서", "북서", "북북서"][Math.round(deg / 22.5) % 16];

  const WX = (c) => {
    if (c == null) return ["·", "자료 없음"];
    if (c === 0) return ["☀️", "맑음"];
    if (c <= 2) return ["🌤️", "구름 조금"];
    if (c === 3) return ["☁️", "흐림"];
    if (c <= 48) return ["🌫️", "안개"];
    if (c <= 57) return ["🌦️", "이슬비"];
    if (c <= 67) return ["🌧️", "비"];
    if (c <= 77) return ["🌨️", "눈"];
    if (c <= 82) return ["🌧️", "소나기"];
    if (c <= 86) return ["🌨️", "눈 소나기"];
    return ["⛈️", "뇌우"];
  };

  // Places: the pin the user dragged wins over the built-in coordinate.
  const pinOverrides = store.get("pins", {});
  const placeById = {};
  PLACES.forEach((p) => {
    p.orig = { lat: p.lat, lon: p.lon, accuracy: p.accuracy };
    const o = pinOverrides[p.id];
    if (o) { p.lat = o.lat; p.lon = o.lon; p.accuracy = "직접 지정"; }
    placeById[p.id] = p;
    p.trips = PAGES.filter((x) => x.trip && x.place === p.id).sort((a, b) => b.trip.date.localeCompare(a.trip.date));
  });
  const hasPin = (p) => p.lat != null && p.lon != null;
  const placeTypes = (p) => [p.type, ...(p.also || [])];
  const allTrips = PAGES.filter((x) => x.trip).sort((a, b) => b.trip.date.localeCompare(a.trip.date));

  const state = {
    view: "plan",
    date: TODAY,
    place: store.get("place", null) || allTrips[0].place,
    hour: new Date().getHours(),
    weather: null,
    marine: null,
    scores: {},
    outlook: null,
    outlookAll: null,
    alertClosed: {},
    mapTab: "ideal",
    mapType: "",
    windOn: true,
    bubbles: false,
    similar: null,
    playing: null,
    picking: false,
    satellite: store.get("satellite", false) === true,
    log: { type: null, place: null, month: null, year: null },
    shelf: PAGES[0].section,
    sources: [],
    notes: { month: new Date().getMonth() + 1, tab: "summary", chapters: {}, fitTarget: null, fitDate: null },
  };
  if (!placeById[state.place]) state.place = allTrips[0].place;

  /* ---------- scripts loaded on demand (works from file://) ---------- */
  const loaded = {};
  const loadScript = (name) => loaded[name] || (loaded[name] = new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = `data/${name}.js`;
    s.onload = ok; s.onerror = fail;
    document.head.append(s);
  }));

  /* ---------- weather ---------- */
  const HOURLY = "temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,weather_code";
  // What Open-Meteo actually serves: its archive starts 1940-01-01 (only partly, in Korean time), its forecast ends 15 days out.
  // Later dates fall back to the average of the same date in recent years.
  const WEATHER_MIN = "1940-01-02";
  const FORECAST_END = addDays(TODAY, 15);
  const weatherMode = (date) => (date > FORECAST_END ? "climate" : diffDays(date, TODAY) < -85 ? "archive" : "forecast");
  const MODE_LABEL = {
    forecast: (d) => (d < TODAY ? "최근 실황 모델 값" : "예보"),
    archive: () => "과거 재분석 값",
    climate: () => "예보 범위 밖: 최근 3년 같은 날짜의 평균",
  };

  // set when the service worker answered from its saved copy because there was no connection
  let weatherSavedAt = null;
  async function getJSON(url) {
    // no-store: every open of the page asks Open-Meteo again instead of reusing the browser's copy
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const saved = r.headers.get("x-fish-saved");
    if (saved) weatherSavedAt = saved;
    return r.json();
  }
  const asList = (j) => (Array.isArray(j) ? j : [j]);
  function normal(j) {
    const h = j.hourly;
    return {
      time: h.time.map((t) => t.slice(11, 16)),
      temp: h.temperature_2m, precip: h.precipitation, prob: h.precipitation_probability || null,
      wind: h.wind_speed_10m, dir: h.wind_direction_10m, gust: h.wind_gusts_10m,
      pressure: h.pressure_msl, code: h.weather_code || null,
      sunrise: j.daily?.sunrise?.[0]?.slice(11, 16), sunset: j.daily?.sunset?.[0]?.slice(11, 16),
    };
  }
  async function fetchRange(host, path, located, date, extra = "") {
    const lat = located.map((p) => p.lat).join(",");
    const lon = located.map((p) => p.lon).join(",");
    const url = `https://${host}/v1/${path}?latitude=${lat}&longitude=${lon}&hourly=${HOURLY}${extra}&daily=sunrise,sunset&wind_speed_unit=ms&timezone=${TZ}&start_date=${date}&end_date=${date}`;
    return asList(await getJSON(url)).map(normal);
  }
  function meanOf(sets) {
    const avg = (key) => sets[0][key] && sets[0][key].map((_, i) => {
      const v = sets.map((s) => s[key][i]).filter((x) => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    });
    return {
      time: sets[0].time, temp: avg("temp"), precip: avg("precip"), prob: null, wind: avg("wind"), gust: avg("gust"), pressure: avg("pressure"), code: null,
      dir: sets[0].dir.map((_, i) => {
        let x = 0, y = 0;
        sets.forEach((s) => { const a = (s.dir[i] ?? 0) * Math.PI / 180; x += Math.sin(a); y += Math.cos(a); });
        return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
      }),
      sunrise: sets[0].sunrise, sunset: sets[0].sunset,
    };
  }
  async function fetchWeather(date) {
    const located = PLACES.filter(hasPin);
    const mode = weatherMode(date);
    weatherSavedAt = null;
    let rows;
    let years = null;
    if (mode === "forecast") {
      rows = await fetchRange("api.open-meteo.com", "forecast", located, date, ",precipitation_probability");
    } else if (mode === "archive") {
      rows = await fetchRange("archive-api.open-meteo.com", "archive", located, date);
    } else {
      const [, m, d] = date.split("-");
      const limit = addDays(TODAY, -6);
      const days = [];
      for (let y = parseISO(TODAY).getFullYear(); days.length < 3 && y > 2000; y--) {
        const c = `${y}-${m}-${m === "02" && d === "29" ? "28" : d}`;
        if (c <= limit) days.push(c);
      }
      years = days.map((c) => c.slice(0, 4)).reverse();
      const sets = await Promise.all(days.map((c) => fetchRange("archive-api.open-meteo.com", "archive", located, c)));
      rows = located.map((_, i) => meanOf(sets.map((s) => s[i])));
    }
    const out = {};
    located.forEach((p, i) => { out[p.id] = rows[i]; });
    return { date, mode, years, savedAt: weatherSavedAt, data: out };
  }
  async function fetchMarine(place, date) {
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${place.lat}&longitude=${place.lon}&hourly=wave_height,sea_level_height_msl,ocean_current_velocity,ocean_current_direction&timezone=${TZ}&start_date=${date}&end_date=${date}`;
    const j = await getJSON(url);
    return { wave: j.hourly.wave_height, sea: j.hourly.sea_level_height_msl, cur: (j.hourly.ocean_current_velocity || []).map((v) => (v == null ? null : v / 3.6)), curDir: j.hourly.ocean_current_direction || [] };
  }
  const outlookCache = {};
  async function fetchOutlook(place) {
    const key = `${place.id}:${place.lat},${place.lon}`;
    if (outlookCache[key]) return outlookCache[key];
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&hourly=${HOURLY},precipitation_probability&daily=sunrise,sunset&wind_speed_unit=ms&timezone=${TZ}&past_days=10&forecast_days=16`;
    const j = await getJSON(url), h = j.hourly;
    const water = waterFromAir(h.temperature_2m);
    const days = j.daily.time.map((date, d) => {
      const sl = (arr) => (arr ? arr.slice(d * 24, d * 24 + 24) : null);
      return { date, w: { time: sl(h.time).map((t) => t.slice(11, 16)), temp: sl(h.temperature_2m), precip: sl(h.precipitation), prob: sl(h.precipitation_probability), wind: sl(h.wind_speed_10m), dir: sl(h.wind_direction_10m), gust: sl(h.wind_gusts_10m), pressure: sl(h.pressure_msl), code: sl(h.weather_code), sunrise: j.daily.sunrise[d]?.slice(11, 16), sunset: j.daily.sunset[d]?.slice(11, 16), water: sl(water) } };
    });
    return (outlookCache[key] = days);
  }
  // Expected water temperature, hour by hour, from the air temperature alone. A pond's surface water follows the
  // air slowly: here it closes the gap by 1/72 every hour (about a three-day lag), so its daily swing is about a
  // twentieth of the air's. It never reads below 0.5 °C (the surface freezes instead). An estimate, not a measurement.
  const WATER_TAU = 72;
  function waterFromAir(air) {
    const start = fin(air.slice(0, 72));
    let wv = start.length ? start.reduce((a, b) => a + b, 0) / start.length : null;
    return air.map((t) => {
      if (t == null || wv == null) return wv == null ? null : Math.max(.5, wv);
      wv += (t - wv) / WATER_TAU;
      return Math.max(.5, wv);
    });
  }
  // The chosen place's water curve for the chosen day (trout and freshwater only). On this PC, where measured
  // temperatures exist, the curve is shifted so its daily mean matches the measured seasonal curve for that day.
  function waterSeries(p) {
    if (!p || p.type === "바다") return null;
    const day = state.outlookAll?.find((d) => d.date === state.date);
    const arr = day?.w.water;
    if (!arr || !fin(arr).length) return null;
    const est = waterEstimate(p, state.date);
    if (!est) return { values: arr, fitted: false };
    const mean = fin(arr).reduce((a, b) => a + b, 0) / fin(arr).length;
    return { values: arr.map((v) => (v == null ? null : Math.max(.5, v + est.surface - mean))), fitted: true };
  }
  const dailyCache = {};
  async function fetchTripDays(place) {
    if (!place.trips.length) return {};
    const key = `${place.id}:${place.lat},${place.lon}`;
    if (dailyCache[key]) return dailyCache[key];
    const dates = place.trips.map((t) => t.trip.date);
    const start = dates[dates.length - 1];
    const end = [dates[0], addDays(TODAY, -6)].sort()[0];
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${place.lat}&longitude=${place.lon}&daily=temperature_2m_mean,wind_speed_10m_max,precipitation_sum&wind_speed_unit=ms&timezone=${TZ}&start_date=${start}&end_date=${end}`;
    const d = (await getJSON(url)).daily;
    const out = {};
    d.time.forEach((t, i) => { out[t] = { temp: d.temperature_2m_mean[i], wind: d.wind_speed_10m_max[i], rain: d.precipitation_sum[i] }; });
    return (dailyCache[key] = out);
  }

  /* ---------- number helpers ---------- */
  const fin = (a) => (a || []).filter((v) => v != null);
  const num = (v, n = 1) => (v == null ? "–" : Number(v).toFixed(n));
  // v2.0.2: numbers simply appear; the old count-up animation read as decoration.
  function countUp() {}

  /* ---------- icons (Lucide, ISC licence; only where the meaning is clear) ---------- */
  const ICONS = {
    fish: '<path d="M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z"/><path d="M18 12v.5"/><path d="M16 17.93a9.77 9.77 0 0 1 0-11.86"/><path d="M7 10.67C7 8 5.58 5.97 2.73 5.5c-1.17 1.5-1.17 4.5 0 6-1.17 1.5-1.17 4.5 0 6C5.58 17.03 7 14.97 7 12.33"/>',
    dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
    flask: '<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    contrast: '<circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z"/>',
    pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    chev: '<path d="m6 9 6 6 6-6"/>',
    calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
    activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
    map: '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>',
    wind: '<path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/>',
    thermo: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
    gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    rain: '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sunrise: '<path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
    sunset: '<path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
    waves: '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    cube: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    play: '<path d="M6 3l14 9-14 9z"/>',
    pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
    up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    chevL: '<path d="m15 18-6-6 6-6"/>',
    home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    rotate: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    phone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>',
    today: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>',
    chevR2: '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    bolt: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    compass: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    medal: '<path d="M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"/><path d="M11 12 5.12 2.2"/><path d="m13 12 5.88-9.8"/><path d="M8 7h8"/><circle cx="12" cy="17" r="5"/>',
    check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    xcircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    trend: '<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  };
  const icon = (name, cls = "") => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  const fillIcons = (root = document) => $$("i[data-icon]", root).forEach((el) => { el.outerHTML = icon(el.dataset.icon, el.className); });

  /* ---------- fishing score ----------
     New in v2.0.2: there was no score before, so every weight below is an assumption, and the screen says so.
     Each hour gets factors between 0 and 1 (wind, rain, pressure change, temperature, time of day mixed with
     the place's own catch record, and waves at sea). The hour's score is their weighted geometric mean, so one
     bad factor pulls the hour down hard. The day's score is the average over its best stretch of hours. */
  const hourFrac = (t) => { if (!t) return null; const [a, b] = t.split(":").map(Number); return a + b / 60; };
  const lerp = (pts, x) => {
    if (x == null || Number.isNaN(x)) return 1;
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      if (x <= x1) { const [x0, y0] = pts[i - 1]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
    }
    return pts[pts.length - 1][1];
  };
  const SCORE_W = { wind: .25, rain: .2, press: .1, temp: .25, time: .2, wave: .15 };
  const FACTOR_NAME = { wind: "바람", rain: "강수", press: "기압", temp: "기온", water: "수온", time: "시간대", wave: "파고" };
  // 공기 온도가 낚시에 알맞은 범위 (어종별 가정)
  const TEMP_CURVE = {
    // v2.0.4: narrower comfortable ranges so ordinary days stop scoring like perfect ones
    송어: [[-6, .25], [-2, .45], [2, .7], [6, .9], [9, 1], [14, 1], [18, .8], [24, .5]],
    민물: [[0, .15], [6, .3], [10, .55], [14, .8], [18, 1], [25, 1], [29, .8], [33, .5]],
    바다: [[0, .25], [6, .4], [10, .6], [14, .85], [18, 1], [26, 1], [30, .75]],
  };
  const curveOf = (type) => TEMP_CURVE[type] || TEMP_CURVE.민물;
  // 송어 수온: 덕봉 3D 모델과 같은 활성 곡선 (2℃에서 바닥, 10℃에서 최대), 16℃ 위로는 떨어집니다.
  const waterF = (T) => Math.min(Math.max((T - 2) / 8, .1), 1) * lerp([[16, 1], [20, .6], [23, .3]], T);
  const windF = (ws, gust) => lerp([[0, 1], [1.5, 1], [3, .8], [5, .55], [7, .3], [10, .1]], ws) * (gust != null && ws != null && gust - ws > 5 ? .9 : 1);
  const rainF = (mm, prob) => Math.min(lerp([[0, 1], [.1, .85], [.5, .65], [2, .4], [5, .2]], mm ?? 0), prob == null ? 1 : 1 - .5 * prob / 100);
  const pressF = (series, h) => {
    const a = series?.[Math.max(0, h - 3)], b = series?.[h];
    if (a == null || b == null) return 1;
    const d = b - a;
    return d < 0 ? lerp([[0, 1], [1, .95], [2, .8], [3, .6], [5, .45]], -d) : lerp([[0, 1], [1.5, .95], [3, .8]], d);
  };
  const waveF = (m) => lerp([[0, 1], [.5, 1], [1, .7], [1.5, .4], [2.5, .1]], m);
  const NIGHT = { 송어: .15, 민물: .75, 바다: .65 };
  function lightF(type, h, rise, set) {
    if (rise == null || set == null) return 1;
    const c = h + .5;
    if (c < rise - 1 || c > set + 1) return NIGHT[type] ?? .6;
    return Math.min(Math.abs(c - rise), Math.abs(c - set)) <= 1.5 ? 1 : .8;
  }
  // Hours with catches in this place's own trip logs (only trips of the place's main fishing type).
  function catchProfile(p) {
    const own = p.trips.filter((t) => !t.trip.other && t.trip.hourly && t.fishing === p.type);
    if (!own.length) return null;
    const sum = Array(24).fill(0);
    own.forEach((t) => t.trip.hourly.forEach((v, h) => { sum[h] += v || 0; }));
    const total = sum.reduce((a, b) => a + b, 0);
    if (total < 8) return null;
    const top = Math.max(...sum);
    return { sum, total, top, trips: own.length, peak: sum.indexOf(top) };
  }
  const geo = (f) => {
    let lg = 0, tw = 0;
    Object.keys(f).forEach((k) => { lg += SCORE_W[k] * Math.log(Math.max(f[k], .02)); tw += SCORE_W[k]; });
    // squared (v2.0.4): a merely decent factor now costs more, which spreads days apart
    return 100 * Math.exp(2 * lg / tw);
  };
  const daylight = (hours, rise, set, fallback) => {
    if (rise == null || set == null) return fallback;
    const v = hours.slice(Math.ceil(rise), Math.floor(set)).filter(Boolean).map((x) => x.s);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : fallback;
  };
  function scorePlace(p, w, marine, date = state.date) {
    if (!w || !fin(w.temp).length) return null;
    const type = p.type, water = waterEstimate(p, date), prof = catchProfile(p);
    const rise = hourFrac(w.sunrise), set = hourFrac(w.sunset);
    const hours = Array.from({ length: 24 }, (_, h) => {
      if (w.temp[h] == null) return null;
      const light = lightF(type, h, rise, set);
      const rec = prof ? (prof.sum[h] ? .55 + .45 * prof.sum[h] / prof.top : .5) : null;
      const f = {
        wind: windF(w.wind[h], w.gust?.[h]),
        rain: rainF(w.precip?.[h], w.prob?.[h]),
        press: pressF(w.pressure, h),
        temp: water ? waterF(water.surface) : lerp(curveOf(type), w.temp[h]),
        time: rec == null ? light : (light + rec) / 2,
      };
      if (marine?.wave?.[h] != null) f.wave = waveF(marine.wave[h]);
      return { h, f, s: geo(f) };
    });
    const valid = hours.filter(Boolean);
    if (!valid.length) return null;
    const top = valid.reduce((a, b) => (b.s > a.s ? b : a));
    let a = top.h, b = top.h;
    const near = (h) => (hours[h] && hours[h].s >= top.s - 6 ? hours[h].s : -1);
    while (b - a < 3) {
      const L = a > 0 ? near(a - 1) : -1, R = b < 23 ? near(b + 1) : -1;
      if (L < 0 && R < 0) break;
      if (R >= L) b++; else a--;
    }
    if (a === b) { const L = hours[a - 1]?.s ?? -1, R = hours[b + 1]?.s ?? -1; if (R >= L && R >= 0) b++; else if (L >= 0) a--; }
    const span = hours.slice(a, b + 1).filter(Boolean);
    const mean = (fn) => span.reduce((s, x) => s + fn(x), 0) / span.length;
    const factors = {};
    Object.keys(span[0].f).forEach((k) => { factors[k] = mean((x) => x.f[k]); });
    const avg = (arr) => { const v = (arr || []).slice(a, b + 1).filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
    const pr = fin(w.pressure);
    return {
      // the day: 70% its best window, 30% the average of the daylight hours, so one good hour cannot carry a poor day
      id: p.id, type, hours, from: a, to: b + 1, score: Math.round(.7 * mean((x) => x.s) + .3 * daylight(hours, rise, set, mean((x) => x.s))), factors, water, prof,
      temp: avg(w.temp), wind: avg(w.wind), gust: w.gust ? Math.max(...fin(w.gust.slice(a, b + 1))) : null,
      dir: w.dir[Math.round((a + b) / 2)], pressure: avg(w.pressure), pTrend: pr.length ? pr[pr.length - 1] - pr[0] : 0,
      prob: w.prob ? Math.max(...fin(w.prob.slice(a, b + 1))) : null, rain: fin(w.precip).reduce((s, x) => s + x, 0),
      rainSpan: fin((w.precip || []).slice(a, b + 1)).reduce((s, x) => s + x, 0),
      wave: marine?.wave ? avg(marine.wave) : null, sunrise: w.sunrise, sunset: w.sunset,
    };
  }
  const scoreTone = (s) => (s >= 80 ? "good" : s >= 65 ? "info" : s >= 50 ? "warn" : "bad");
  const factorTone = (f) => (f >= .85 ? "good" : f >= .65 ? "info" : f >= .45 ? "warn" : "bad");
  const hhmm = (h) => `${pad(h)}:00`;
  const spanText = (r) => `${hhmm(r.from)} ~ ${hhmm(r.to)}`;

  // Moon age from a known new moon (2000-01-06 18:14 UTC), at noon local time.
  function moonAge(iso) {
    const SYN = 29.530588853, t = (parseISO(iso).getTime() + 12 * 36e5 - Date.UTC(2000, 0, 6, 18, 14)) / 864e5;
    return ((t % SYN) + SYN) % SYN;
  }
  const moonName = (a) => (a < 1.85 || a >= 27.7 ? "신월" : a < 5.5 ? "초승달" : a < 9.2 ? "상현달" : a < 13.8 ? "보름 전" : a < 15.7 ? "보름달" : a < 20.3 ? "보름 뒤" : a < 24 ? "하현달" : "그믐달");
  // Spring tides come about 1 to 3 days after new and full moon. A rough guide only, not a tide table.
  // True new moon (Meeus, Astronomical Algorithms ch. 49, main periodic terms; good to a few minutes), as a JS time.
  function newMoonTime(k) {
    const T = k / 1236.85, rad = Math.PI / 180;
    let jde = 2451550.09766 + 29.530588861 * k + .00015437 * T * T - .00000015 * T ** 3;
    const E = 1 - .002516 * T - .0000074 * T * T;
    const M = (2.5534 + 29.1053567 * k - .0000014 * T * T) * rad;
    const Mp = (201.5643 + 385.81693528 * k + .0107582 * T * T) * rad;
    const F = (160.7108 + 390.67050284 * k - .0016118 * T * T) * rad;
    const Om = (124.7746 - 1.56375588 * k + .0020672 * T * T) * rad;
    jde += -.4072 * Math.sin(Mp) + .17241 * E * Math.sin(M) + .01608 * Math.sin(2 * Mp) + .01039 * Math.sin(2 * F)
      + .00739 * E * Math.sin(Mp - M) - .00514 * E * Math.sin(Mp + M) + .00208 * E * E * Math.sin(2 * M)
      - .00111 * Math.sin(Mp - 2 * F) - .00057 * Math.sin(Mp + 2 * F) + .00056 * E * Math.sin(2 * Mp + M)
      - .00042 * Math.sin(3 * Mp) + .00042 * E * Math.sin(M + 2 * F) + .00038 * E * Math.sin(M - 2 * F)
      - .00024 * E * Math.sin(2 * Mp - M) - .00017 * Math.sin(Om);
    return (jde - 2440587.5) * 864e5 - 69e3;   // TT to UT, roughly
  }
  // Day of the lunar month in Korea: the month starts on the KST calendar day of the new moon.
  function lunarDay(iso) {
    const KST = 9 * 36e5, endOfDay = parseISO(iso).getTime() + 864e5;   // local midnight after the date
    let k = Math.floor((endOfDay / 864e5 - 10957.5) / 29.530588861) + 1;
    while (newMoonTime(k) > endOfDay) k--;
    const nm = new Date(newMoonTime(k) + KST), nmDay = Date.UTC(nm.getUTCFullYear(), nm.getUTCMonth(), nm.getUTCDate());
    const d = parseISO(iso), day = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.round((day - nmDay) / 864e5) + 1;
  }
  // 물때 as the West Sea counts it (7물때식): lunar 1st and 16th are 7물, 8th and 23rd 조금, 9th and 24th 무쉬.
  const MUL = ["7물", "8물", "9물", "10물", "11물", "12물", "13물", "조금", "무쉬", "1물", "2물", "3물", "4물", "5물", "6물"];
  function mulTae(iso) {
    const ld = lunarDay(iso), name = MUL[(ld - 1) % 15];
    const n = parseInt(name, 10);
    const note = Number.isNaN(n) ? "물살 가장 약함" : n >= 6 && n <= 9 ? "사리 무렵, 물살 셈" : n >= 4 && n <= 11 ? "물살 강한 편" : "물살 보통";
    return { name, note, lunar: ld };
  }
  const tideHint = (iso) => { const m = mulTae(iso); return `${m.name}(${m.note})`; };

  // What each value means for fishing.
  const READ = {
    wind: (r) => (r.wind <= 2 ? "채비 운용 좋음" : r.wind <= 4 ? "채비 운용 양호" : r.wind <= 7 ? "캐스팅 주의" : "낚시에 불리"),
    temp: (r) => { const c = curveOf(r.type), lo = c.find((x) => x[1] === 1)[0]; return lerp(c, r.temp) >= .85 ? "활성에 알맞은 기온" : r.temp < lo ? "낮은 기온, 활성 약함" : "높은 기온, 활성 저하"; },
    water: (r) => (r.water.surface < 4 ? "활성 낮음, 느린 운용" : r.water.surface < 8 ? "활성 보통" : r.water.surface <= 16 ? "활성 양호" : "고수온 주의"),
    // the words follow the same 3-hour change the score uses, so the dot and the text agree
    press: (r) => (r.factors.press >= .85 ? "안정적" : r.pTrend < 0 ? "하강 중, 입질 둔화 가능" : "상승 중, 회복세"),
    // judged on the best hours, like the score; rain at other hours is mentioned separately
    rain: (r) => (r.rainSpan > 4 ? "많은 비, 출조 불리" : (r.prob ?? 0) >= 50 || r.rainSpan > 1 ? "비 예상, 우비 준비" : (r.prob ?? 0) >= 20 || r.rainSpan > .2 ? "약한 비 가능" : r.rain > 1 ? "이 시간대는 비 없음" : "비 소식 없음"),
    wave: (r) => (r.wave <= .5 ? "잔잔함" : r.wave <= 1 ? "보통" : r.wave <= 1.5 ? "높음, 주의" : "위험, 출조 자제"),
    time: (r) => (r.prof ? `기록상 ${r.prof.peak}시대 조과가 가장 많음` : "해 뜰 무렵과 해 질 무렵 유리"),
  };
  const GOOD_WORD = { wind: "바람 약함", rain: "비 없음", press: "기압 안정", temp: "기온 알맞음", water: "수온 알맞음", time: "시간대 유리", wave: "파도 잔잔" };
  const BAD_WORD = { wind: "바람 강함", rain: "비", press: "기압 변화", temp: "기온 불리", water: "수온 불리", time: "시간대 불리", wave: "파도 높음" };
  const named = (r) => Object.entries(r.factors).map(([k, f]) => [k === "temp" && r.water ? "water" : k, f]);
  const whyText = (r) => {
    const list = named(r).sort((x, y) => y[1] - x[1]);
    const good = list.filter(([, f]) => f >= .85).slice(0, 2).map(([k]) => GOOD_WORD[k]);
    const bad = list.filter(([, f]) => f < .65).slice(-1).map(([k]) => BAD_WORD[k]);
    return [...good, ...bad].join(", ") || "무난함";
  };
  // Data, then what it means, then what to do.
  function verdictText(r, p) {
    const list = named(r).sort((x, y) => y[1] - x[1]);
    const goods = list.filter(([, f]) => f >= .85).map(([k]) => FACTOR_NAME[k]);
    const weak = list.filter(([, f]) => f < .65).map(([k]) => FACTOR_NAME[k]);
    const data = [
      r.water ? `표층 수온 약 ${num(r.water.surface)}℃` : `기온 ${num(r.temp)}℃`,
      `바람 ${r.dir != null ? compass(r.dir) + "풍 " : ""}${num(r.wind)}m/s`,
      r.pressure != null ? `기압 ${Math.round(r.pressure)}hPa(${READ.press(r).split(",")[0]})` : "",
      r.prob != null ? `강수확률 ${r.prob}%` : `강수 ${num(r.rain)}mm`,
      r.wave != null ? `파고 ${num(r.wave)}m` : "",
    ].filter(Boolean).join(", ");
    const meaning = goods.length ? `${goods.slice(0, 3).join(", ")} 조건이 좋${weak.length ? `고, ${weak.join(", ")} 조건이 약점입니다` : "습니다"}.` : weak.length ? `${weak.join(", ")} 조건이 불리합니다.` : "큰 약점은 없습니다.";
    const act = [];
    if (r.prof && r.prof.sum.slice(r.from, r.to).some((v) => v > 0)) act.push(`지난 출조 ${r.prof.trips}회의 기록에서도 이 시간대에 입질이 있었습니다.`);
    if (r.wind > 4) act.push("바람을 등지는 자리를 고르고 무게 있는 채비로 운용하세요.");
    else if (r.wind <= 2) act.push("가벼운 채비도 운용하기 좋습니다.");
    if (p.type === "송어") {
      const t = r.water ? r.water.surface : r.temp;
      act.push(t < 4 ? "물이 차가우니 바닥층 위주로 천천히 운용하세요." : t > 16 ? "수온이 높으니 깊은 층을 먼저 탐색하세요." : "중층부터 탐색해 반응층을 찾으세요.");
    }
    if ((r.prob ?? 0) >= 50 || r.rainSpan > 1) act.push("비에 대비해 우비를 챙기세요.");
    else if (r.rain > 1) act.push(`비는 이 시간대 밖에 하루 ${num(r.rain)}mm 예보돼 있으니 늦어지지 않게 정리하세요.`);
    if (r.wave != null && r.wave > 1) act.push("파도가 높으니 갯바위와 방파제 끝은 피하세요.");
    const close = r.score >= 65 ? `${r.from}시 전에 자리를 잡으세요.` : r.score >= 50 ? `나간다면 ${r.from}시부터 ${r.to}시 사이에 짧게 노리세요.` : "아래 16일 전망에서 점수가 높은 날을 고르는 편이 낫습니다.";
    return { lead: `${spanText(r)}이 가장 유리합니다.`, data: `${data}.`, meaning, act: [...act, close] };
  }

  /* ---------- charts ---------- */
  const charts = [];
  function makeChart(el, cfg) {
    // the same height and margins on every chart keep the plot areas level across a row
    const H = 190;
    const m = { l: 34, r: 12, t: 24, b: 22 };
    const n = 24;
    let width = 0;
    const svgHolder = document.createElement("div");
    const nowEl = $(".chart-now", el);
    el.append(svgHolder);
    const tip = document.createElement("div");
    tip.className = "tooltip"; tip.hidden = true;
    el.append(tip);

    const all = cfg.series.flatMap((s) => fin(s.values));
    let lo = cfg.zero ? 0 : Math.min(...all), hi = Math.max(...all);
    if (cfg.zero) hi = Math.max(hi, cfg.minTop || 1);
    if (hi - lo < (cfg.minSpan || 2)) { const c = (hi + lo) / 2; if (!cfg.zero) lo = c - (cfg.minSpan || 2) / 2; hi = cfg.zero ? hi : c + (cfg.minSpan || 2) / 2; }
    const headroom = cfg.zero ? 0 : (hi - lo) * .12;
    lo -= headroom; hi += cfg.zero ? (hi - lo) * .12 : headroom;
    if (cfg.fixed) [lo, hi] = cfg.fixed;

    const X = (i) => m.l + (width - m.l - m.r) * (cfg.bars ? (i + .5) / n : i / (n - 1));
    const Y = (v) => m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo));
    const hourFrac = (t) => { if (!t) return null; const [a, b] = t.split(":").map(Number); return a + b / 60; };

    function draw(animate) {
      width = el.clientWidth - 28;
      if (width < 120) return;
      const parts = [];
      const rise = hourFrac(cfg.sunrise), set = hourFrac(cfg.sunset);
      if (rise != null) {
        const toX = (h) => X(0) + (X(n - 1) - X(0)) * (cfg.bars ? (h - .5) / (n - 1) : h / (n - 1));
        parts.push(`<rect x="${m.l}" y="${m.t}" width="${Math.max(0, toX(rise) - m.l)}" height="${H - m.t - m.b}" fill="var(--night)"/>`);
        parts.push(`<rect x="${toX(set)}" y="${m.t}" width="${Math.max(0, width - m.r - toX(set))}" height="${H - m.t - m.b}" fill="var(--night)"/>`);
      }
      for (let k = 0; k <= 2; k++) {
        const v = lo + (hi - lo) * (k / 2), y = Y(v);
        parts.push(`<line x1="${m.l}" x2="${width - m.r}" y1="${y}" y2="${y}" stroke="${k === 0 ? "var(--axis)" : "var(--grid)"}"/>`);
        parts.push(`<text x="${m.l - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${cfg.tick ? cfg.tick(v) : Math.round(v)}</text>`);
      }
      [0, 6, 12, 18, 23].forEach((h) => parts.push(`<text x="${X(h)}" y="${H - m.b + 15}" text-anchor="middle" font-size="11" fill="var(--muted)">${h}시</text>`));
      if (cfg.band) {
        const slot = (width - m.l - m.r) / n;
        parts.push(`<rect x="${m.l + slot * cfg.band[0]}" y="${m.t}" width="${slot * (cfg.band[1] - cfg.band[0] + 1)}" height="${H - m.t - m.b}" fill="var(--accent-soft)" opacity=".7"/>`);
      }
      if (cfg.bars) {
        const s = cfg.series[0];
        const bw = Math.max(2, (width - m.l - m.r) / n - 2);
        s.values.forEach((v, i) => {
          if (!v) return;
          const y = Y(v), h = Y(lo) - y, r = Math.min(4, h, bw / 2);
          parts.push(`<path class="${animate ? "bar-in" : ""}" style="animation-delay:${i * 18}ms" fill="${s.colorAt ? s.colorAt(i) : s.color}" d="M${X(i) - bw / 2} ${Y(lo)}V${y + r}Q${X(i) - bw / 2} ${y} ${X(i) - bw / 2 + r} ${y}H${X(i) + bw / 2 - r}Q${X(i) + bw / 2} ${y} ${X(i) + bw / 2} ${y + r}V${Y(lo)}Z"/>`);
        });
        if (!cfg.band && !fin(s.values).some((v) => v > 0)) parts.push(`<text x="${(width + m.l) / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="var(--muted)">이날 강수 없음</text>`);
      } else {
        cfg.series.forEach((s) => {
          let d = "", pen = false;
          s.values.forEach((v, i) => {
            if (v == null) { pen = false; return; }
            d += `${pen ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`; pen = true;
          });
          if (s.bands) {
            const gid = `bg${Math.random().toString(36).slice(2, 8)}`;
            parts.push(`<defs>${bandGradient(gid, Y(-60), Y(100), -60, 100, s.bands)}</defs><path d="${d}" fill="none" stroke="url(#${gid})" stroke-width="2.4"${s.dashed ? ' stroke-dasharray="6 4"' : ""} stroke-linecap="round" stroke-linejoin="round"/>`);
            return;
          }
          parts.push(s.dash
            ? `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.5" stroke-dasharray="4 4"/>`
            : `<path class="${animate ? "draw" : ""}" pathLength="1" d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
        });
      }
      if (cfg.arrows) {
        for (let i = 1; i < 24; i += 3) {
          if (cfg.arrows[i] == null) continue;
          parts.push(`<g transform="translate(${X(i)} 11) rotate(${(cfg.arrows[i] + 180) % 360})"><path d="M0 -6L4 5L0 2.5L-4 5Z" fill="var(--ink-2)"/></g>`);
        }
      }
      // highest and lowest of each line (dashed helper lines such as gusts excepted) with the hour;
      // bars show only their largest value. Labels step aside if they would land on one another.
      const bandColour = (s, v) => (s.bands ? (s.bands.find(([upTo]) => v < upTo) || s.bands[s.bands.length - 1])[1] : s.color);
      const exLabels = [];
      cfg.series.forEach((s) => {
        if (s.dash || s.noExt) return;
        const vals = s.values.map((v, i) => [v, i]).filter(([v]) => v != null);
        if (!vals.length) return;
        const hi = vals.reduce((a, b) => (b[0] > a[0] ? b : a)), lo = vals.reduce((a, b) => (b[0] < a[0] ? b : a));
        const marks = cfg.bars ? (hi[0] > 0 ? [[hi, "최대", -6]] : []) : hi[0] === lo[0] ? [] : [[hi, "최고", -8], [lo, "최저", 15]];
        marks.forEach(([[v, i], word, dy]) => {
          const x = X(i), y = Y(v), col = s.colorAt ? s.colorAt(i) : bandColour(s, v);
          if (!cfg.bars) parts.push(`<circle cx="${x}" cy="${y}" r="3" fill="${col}" stroke="var(--surface)" stroke-width="1.5"/>`);
          exLabels.push({ x, y: y + dy, text: `${word} ${num(v, cfg.digits)}${cfg.unit} ${i}시`, anchor: i < 3 ? "start" : i > 20 ? "end" : "middle", col });
        });
      });
      const meas = document.createElement("canvas").getContext("2d");
      meas.font = '600 10.5px "Pretendard Variable", Pretendard, sans-serif';
      const placed = [];
      exLabels.forEach((l) => {
        const w = meas.measureText(l.text).width + 4;
        const box = (yy) => { const x0 = l.anchor === "start" ? l.x : l.anchor === "end" ? l.x - w : l.x - w / 2; return { x0, x1: x0 + w, y0: yy - 10, y1: yy + 3 }; };
        let y = Math.max(m.t + 9, Math.min(H - m.b - 3, l.y));
        for (const off of [0, -12, 12, -24, 24, -36, 36]) {
          const ty = Math.max(m.t + 9, Math.min(H - m.b - 3, l.y + off)), b = box(ty);
          if (!placed.some((q) => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0)) { y = ty; break; }
        }
        placed.push(box(y));
        parts.push(`<text x="${l.x}" y="${y}" text-anchor="${l.anchor}" class="exl" fill="${l.col}">${l.text}</text>`);
      });
      parts.push(`<g class="cross"><line y1="${m.t}" y2="${H - m.b}" stroke="var(--ink-2)" stroke-width="1"/></g>`);
      parts.push(cfg.series.filter((s) => !cfg.bars).map((s, i) => `<circle class="pt pt${i}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`).join(""));
      parts.push(`<rect class="hit" x="0" y="0" width="${width}" height="${H}" fill="transparent"/>`);
      svgHolder.innerHTML = `<svg viewBox="0 0 ${width} ${H}" height="${H}" role="img" aria-label="${esc(cfg.title)} 시간별 그래프">${parts.join("")}</svg>`;
      const hit = $(".hit", svgHolder);
      const hourAt = (e) => {
        const box = hit.ownerSVGElement.getBoundingClientRect();
        const x = (e.clientX - box.left) / box.width * width;
        return Math.max(0, Math.min(23, Math.round(cfg.bars ? (x - m.l) / (width - m.l - m.r) * n - .5 : (x - m.l) / (width - m.l - m.r) * (n - 1))));
      };
      hit.addEventListener("pointermove", (e) => { stopPlay(); setHour(hourAt(e), true); showTip(hourAt(e)); });
      hit.addEventListener("pointerleave", () => { tip.hidden = true; });
      update(state.hour);
    }
    function showTip(h) {
      tip.hidden = false;
      tip.innerHTML = `${pad(h)}:00<br>` + cfg.series.map((s) => `${esc(s.label)} ${s.values[h] == null ? "–" : num(s.values[h], cfg.digits)}${cfg.unit}`).join("<br>");
      tip.style.left = `${Math.max(60, Math.min(el.clientWidth - 60, X(h) + 14))}px`;
      tip.style.top = `${44 + m.t}px`;
    }
    function update(h) {
      if (width < 120 || !svgHolder.firstChild) return;
      const line = $(".cross line", svgHolder);
      line.setAttribute("x1", X(h)); line.setAttribute("x2", X(h));
      if (!cfg.bars) cfg.series.forEach((s, i) => {
        const c = $(".pt" + i, svgHolder), v = s.values[h];
        c.setAttribute("visibility", v == null ? "hidden" : "visible");
        if (v != null) { c.setAttribute("cx", X(h)); c.setAttribute("cy", Y(v)); }
      });
      const v = cfg.series[0].values[h];
      nowEl.innerHTML = `${v == null ? "–" : num(v, cfg.digits)}<small>${cfg.unit}${cfg.note ? " · " + esc(cfg.note(h)) : ""}</small>`;
    }
    draw(!REDUCED);
    const ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - 28 - width) > 2) draw(false); });
    ro.observe(el);
    return { update, destroy: () => ro.disconnect() };
  }

  function chartShell(host, title, i, legend = "", cls = "") {
    const el = document.createElement("div");
    el.className = `chart ${cls}`;
    el.style.setProperty("--i", i);
    el.innerHTML = `<div class="chart-head"><div class="chart-title"><h3>${title}</h3>${legend}</div><div class="chart-now"></div></div>`;
    host.append(el);
    return el;
  }

  function renderCharts() {
    charts.splice(0).forEach((c) => c.destroy());
    const host = $("#charts");
    host.innerHTML = "";
    const w = state.weather?.data[state.place];
    if (!w) return;
    const accent = "var(--accent)";
    const sun = { sunrise: w.sunrise, sunset: w.sunset };
    let i = 0;
    const wsr = waterSeries(placeById[state.place]);
    charts.push(makeChart(chartShell(host, wsr ? "기온과 수온" : "기온", i++, `<div class="legend"><span>기온 <i class="wk r">0℃ 미만</i><i class="wk y">0~10℃</i><i class="wk b">10℃~</i></span>${wsr ? `<span><i style="background:var(--line-water)"></i>수온 ${wsr.fitted ? "(실측 맞춤 추정)" : "(추정)"}</span>` : ""}</div>`), {
      ...sun, title: "기온", unit: "°C", digits: 1, minSpan: 4,
      series: [{ label: "기온", color: "var(--line-temp)", values: w.temp, bands: TEMP_BANDS }, ...(wsr ? [{ label: "수온", color: "var(--line-water)", values: wsr.values }] : [])],
      note: (h) => (w.code ? WX(w.code[h])[1] : "평균값"),
    }));
    charts.push(makeChart(chartShell(host, "바람", i++, `<div class="legend"><span>풍속 <i class="wk g">~2m/s</i><i class="wk o">2~5m/s</i><i class="wk r">5m/s~</i></span><span><i class="dash"></i>돌풍</span></div>`), {
      ...sun, title: "바람", unit: "m/s", digits: 1, zero: true, minTop: 5,
      series: [{ label: "풍속", color: "#ff9f3a", values: w.wind, bands: [[2, WIND_COL[0]], [5, WIND_COL[1]], [99, WIND_COL[2]]], dashed: true }, { label: "돌풍", color: "var(--muted)", values: w.gust, dash: true }],
      arrows: w.dir,
      note: (h) => (w.dir[h] == null ? "" : `${compass(w.dir[h])}풍`),
    }));
    charts.push(makeChart(chartShell(host, "강수량", i++, `<div class="legend"><span><i style="background:#ffd23f"></i>1mm 미만</span><span><i style="background:#ff4f4f"></i>1mm 이상</span></div>`), {
      ...sun, title: "강수량", unit: "mm", digits: 1, zero: true, minTop: 2, bars: true,
      series: [{ label: "강수량", color: "#ffd23f", colorAt: (h) => rainCol(w.precip[h] ?? 0), values: w.precip }],
      note: (h) => (w.prob ? `확률 ${w.prob[h] ?? "–"}%` : ""),
    }));
    charts.push(makeChart(chartShell(host, "기압", i++), {
      ...sun, title: "기압", unit: "hPa", digits: 0, minSpan: 4,
      series: [{ label: "기압", color: accent, values: w.pressure }],
      tick: (v) => Math.round(v),
    }));
    const place = placeById[state.place];
    if (place.type === "바다") {
      const mr = state.marine;
      if (mr && fin(mr.wave).length) {
        charts.push(makeChart(chartShell(host, "파고 (모델 참고값)", i++, `<div class="legend"><span><i style="background:var(--accent)"></i>1m 이하</span><span><i style="background:#ff4f4f"></i>1m 넘음</span></div>`), {
          ...sun, title: "파고", unit: "m", digits: 1, zero: true, minTop: 1,
          // over 1 m the line turns red
          series: [{ label: "파고", color: accent, values: mr.wave, bands: [[1, "var(--accent)"], [99, "#ff4f4f"]] }],
          tick: (v) => v.toFixed(1),
        }));
        if (fin(mr.sea).length) charts.push(makeChart(chartShell(host, "해수면 높이 (조석 포함, 모델 참고값)", i++), {
          ...sun, title: "해수면 높이", unit: "m", digits: 2, minSpan: 1,
          series: [{ label: "해수면", color: accent, values: mr.sea }],
          tick: (v) => v.toFixed(1),
        }));
      } else {
        const el = chartShell(host, "파고", i++);
        $(".chart-now", el).remove();
        el.insertAdjacentHTML("beforeend", `<p class="state-msg">이 날짜와 위치의 해상 모델 값이 없습니다. 보통 앞으로 7일 정도까지만 제공됩니다.</p>`);
      }
    }
  }

  /* ---------- hour ---------- */
  function setHour(h, fromChart) {
    if (h === state.hour && fromChart) return;
    state.hour = h;
    $("#hourRange").value = h;
    $("#hourLabel").textContent = `${pad(h)}:00`;
    charts.forEach((c) => c.update(h));
    bigChart?.update(h);
    updatePins();
    refreshWindField();
  }
  function stopPlay() {
    if (state.playing) { clearInterval(state.playing); state.playing = null; $("#playBtn").innerHTML = icon("play"); }
  }
  function togglePlay() {
    if (state.playing) return stopPlay();
    $("#playBtn").innerHTML = icon("pause");
    state.playing = setInterval(() => setHour((state.hour + 1) % 24), 650);
  }

  /* ---------- map ---------- */
  // close enough to see the water and the roads around one fishing spot
  const PLACE_ZOOM = 14;
  let map = null, tiles = [];
  const markers = {};
  const ARROW = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 0.5L10 11L6 8.6L2 11Z" fill="currentColor"/></svg>';
  const isDark = () => getComputedStyle(document.documentElement).colorScheme.includes("dark");

  function setTiles() {
    if (!map) return;
    tiles.forEach((layer) => layer.remove());
    const weather = ' · 날씨 <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>';
    const esri = (service, attribution = "") => L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 18, attribution });
    if (state.satellite) {
      tiles = [esri("World_Imagery", `Imagery &copy; Esri${weather}`), esri("Reference/World_Boundaries_and_Places")];
    } else if (location.protocol === "file:") {
      // OpenStreetMap refuses requests without a Referer, which is what a page opened from file:// sends.
      tiles = [esri("World_Street_Map", `Tiles &copy; Esri${weather}`)];
    } else {
      tiles = [L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18, attribution: `&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>${weather}`,
      })];
    }
    tiles.forEach((layer) => layer.addTo(map));
    $(".map-card").classList.toggle("satellite", state.satellite);
    $("#mapSat").textContent = state.satellite ? "일반 지도" : "위성 보기";
    $("#mapSat").setAttribute("aria-pressed", String(state.satellite));
  }
  function toggleSatellite() {
    state.satellite = !state.satellite;
    store.set("satellite", state.satellite);
    setTiles();
    renderMapPanel();
  }
  function addMarker(p) {
    const icon = L.divIcon({ className: "", html: `<div class="pin ${p.type}"><i class="arrow">${ARROW}</i><b>–</b><span>${esc(p.id)}</span></div>`, iconSize: [0, 0] });
    const mk = L.marker([p.lat, p.lon], { icon, title: p.name, riseOnHover: true, keyboard: true }).addTo(map);
    mk.on("click", () => selectPlace(p.id));
    markers[p.id] = mk;
  }
  function movePin(p, lat, lon) {
    p.lat = +lat.toFixed(4); p.lon = +lon.toFixed(4); p.accuracy = "직접 지정";
    pinOverrides[p.id] = { lat: p.lat, lon: p.lon };
    store.set("pins", pinOverrides);
    Object.keys(cacheW).forEach((k) => delete cacheW[k]);
    if (markers[p.id]) markers[p.id].setLatLng([p.lat, p.lon]);
    else addMarker(p);
    setPicking(false);
    loadAll();
  }
  function resetPin(p) {
    Object.assign(p, p.orig);
    delete pinOverrides[p.id];
    store.set("pins", pinOverrides);
    Object.keys(cacheW).forEach((k) => delete cacheW[k]);
    if (hasPin(p)) {
      markers[p.id]?.setLatLng([p.lat, p.lon]);
      map?.flyTo([p.lat, p.lon], Math.max(map.getZoom(), PLACE_ZOOM), { duration: REDUCED ? 0 : .9 });
    } else if (markers[p.id]) {
      markers[p.id].remove();
      delete markers[p.id];
    }
    setPicking(false);
    loadAll();
  }
  function updateMapNote() {
    const p = placeById[state.place];
    const note = $("#mapNote");
    note.hidden = hasPin(p) && !state.picking;
    if (state.picking) note.textContent = `${p.name}의 위치를 지도에서 누르세요. 확대해서 누르면 더 정확합니다.`;
    else if (!hasPin(p)) note.textContent = `${p.name} 주소를 찾지 못했습니다. 지도에서 위치를 클릭해 지정해 주세요.`;
    $(".map-card").classList.toggle("picking", state.picking || !hasPin(p));
  }
  function setPicking(on) {
    state.picking = on;
    updateMapNote();
    const btn = $("[data-pick]");
    if (btn) btn.textContent = on ? "위치 지정 취소" : "지도에서 위치 지정";
    if (on && state.view !== "map") go("map");
    renderMapPanel();
  }
  function initMap() {
    if (!window.L) {
      $("#map").innerHTML = '<p class="state-msg">지도 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하세요. 노트 자료는 그대로 볼 수 있습니다.</p>';
      return;
    }
    // The page scrolls past the map: the wheel zooms only with Ctrl, and on a phone one finger scrolls the page.
    // the map has its own screen now, so the mouse wheel zooms it directly
    map = L.map("map", { zoomControl: true, attributionControl: true, scrollWheelZoom: true, wheelPxPerZoomLevel: 90, dragging: !L.Browser.mobile }).setView([36.9, 127], 9);
    map.zoomControl.setPosition("topright");
    guardMapScroll();
    setTiles();
    PLACES.filter(hasPin).forEach(addMarker);
    // the map starts hidden on its own screen; it fits the pins the first time it is shown (a hidden map has no size)
    map.on("click", (e) => {
      const p = placeById[state.place];
      if (state.picking || !hasPin(p)) movePin(p, e.latlng.lat, e.latlng.lng);
    });
    map.on("moveend zoomend", refreshWindField);
    map.on("movestart zoomstart", () => clearCanvas());
  }
  let mapFitted = false;
  function fitAll() {
    if (!map || state.view !== "map") return;
    mapFitted = true;
    const pts = PLACES.filter(hasPin).map((p) => [p.lat, p.lon]);
    // the bottom padding keeps every pin clear of the hour bar
    map.flyToBounds(pts, { paddingTopLeft: [60, 60], paddingBottomRight: [90, 110], duration: REDUCED ? 0 : .9 });
  }
  function updatePins() {
    const data = state.weather?.data;
    Object.entries(markers).forEach(([id, mk]) => {
      const el = mk.getElement()?.querySelector(".pin");
      if (!el) return;
      const w = data?.[id], h = state.hour;
      el.classList.toggle("sel", id === state.place);
      mk.setZIndexOffset(id === state.place ? 1000 : 0);
      mk.getElement().style.display = !state.mapType || placeTypes(placeById[id]).includes(state.mapType) ? "" : "none";
      const sc = state.scores?.[id];
      $("b", el).textContent = sc ? sc.score : "–";
      el.dataset.tone = sc ? scoreTone(sc.score) : "";
      $("span", el).textContent = id === state.place && w?.wind[h] != null ? `${id} ${Math.round(w.temp[h])}° ${w.wind[h].toFixed(1)}m/s` : id;
      const dir = w?.dir[h];
      if (dir != null) {
        const svg = $(".arrow svg", el);
        // keep rotating the short way round so the arrow never spins a full circle
        const prev = +(svg.dataset.rot || 0);
        const target = (dir + 180) % 360;
        const next = prev + ((target - prev + 540) % 360) - 180;
        svg.dataset.rot = next;
        svg.style.transform = `rotate(${next}deg)`;
      }
    });
  }

  /* ---------- animated wind layer (interpolated between the pins) ---------- */
  const canvas = $("#windCanvas");
  const ctx = canvas.getContext("2d");
  let field = [], particles = [], raf = null;
  function clearCanvas() { ctx.clearRect(0, 0, canvas.width, canvas.height); }
  function refreshWindField() {
    if (!map || !state.weather) { field = []; return; }
    const size = map.getSize();
    if (canvas.width !== size.x || canvas.height !== size.y) { canvas.width = size.x; canvas.height = size.y; }
    field = PLACES.filter((p) => hasPin(p) && state.weather.data[p.id]).map((p) => {
      const w = state.weather.data[p.id];
      const pt = map.latLngToContainerPoint([p.lat, p.lon]);
      const dir = (w.dir[state.hour] ?? 0) * Math.PI / 180, sp = w.wind[state.hour] ?? 0;
      return { x: pt.x, y: pt.y, u: -Math.sin(dir) * sp, v: Math.cos(dir) * sp };
    });
    if (!particles.length) for (let i = 0; i < 260; i++) particles.push(seed());
    if (!raf && !REDUCED) raf = requestAnimationFrame(tick);
  }
  function seed() { return { x: Math.random() * canvas.width, y: Math.random() * canvas.height, age: Math.random() * 90 }; }
  function windAt(x, y) {
    let wu = 0, wv = 0, wt = 0;
    for (const f of field) {
      const d = 1 / ((x - f.x) ** 2 + (y - f.y) ** 2 + 400);
      wu += f.u * d; wv += f.v * d; wt += d;
    }
    return wt ? [wu / wt, wv / wt] : [0, 0];
  }
  function tick() {
    raf = null;
    if (state.view !== "map" || document.hidden || !field.length || !state.windOn) return;
    const rgb = state.satellite ? "255, 255, 255" : getComputedStyle(document.documentElement).getPropertyValue("--particle");
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,.09)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = `rgba(${rgb},.55)`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const p of particles) {
      const [u, v] = windAt(p.x, p.y);
      const nx = p.x + u * .42, ny = p.y + v * .42;
      ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny);
      p.x = nx; p.y = ny; p.age++;
      if (p.age > 120 || nx < 0 || ny < 0 || nx > canvas.width || ny > canvas.height) Object.assign(p, seed(), { age: 0 });
    }
    ctx.stroke();
    raf = requestAnimationFrame(tick);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !raf && !REDUCED && field.length) raf = requestAnimationFrame(tick); });

  /* ---------- plan view ---------- */
  function guardMapScroll() {
    const box = map.getContainer();
    const hint = document.createElement("div");
    hint.className = "map-hint";
    hint.setAttribute("aria-hidden", "true");
    box.append(hint);
    let hinted = false;
    const showHint = (text) => {
      if (hinted) return;
      hinted = true;
      hint.textContent = text;
      hint.classList.add("on");
      setTimeout(() => hint.classList.remove("on"), 1800);
    };
    if (L.Browser.mobile) box.addEventListener("touchmove", (e) => { if (e.touches.length === 1) showHint("지도를 움직이려면 두 손가락을 쓰세요"); }, { passive: true });
  }

  function renderPlaceChips() {
    const cur = placeById[state.place];
    $("#placeName").textContent = cur.name;
    $("#placeType").textContent = `${cur.type}낚시`;
    $("#placeChips").innerHTML = TYPES.map((t) => `<div class="place-row"><b><i class="dot ${t}"></i>${t}</b>` +
      PLACES.filter((p) => placeTypes(p).includes(t)).sort((a, b) => b.trips.length - a.trips.length).map((p) =>
        `<button class="chip ${p.id === state.place ? "on" : ""} ${hasPin(p) ? "" : "nopin"}" data-place="${esc(p.id)}" title="${esc(p.accuracy)}">${esc(p.id)}<small>${p.trips.length}</small></button>`).join("") + `</div>`).join("");
  }
  function quickDates() {
    const now = parseISO(TODAY);
    const sat = addDays(TODAY, (6 - now.getDay() + 7) % 7 || 7);
    const items = [["오늘", TODAY], ["내일", addDays(TODAY, 1)], ["이번 토요일", sat], ["일요일", addDays(sat, 1)]];
    $("#quickDates").innerHTML = items.map(([l, d]) => `<button data-date="${d}" class="${d === state.date ? "on" : ""}">${l}</button>`).join("");
  }
  function focusStripDay() {
    const strip = $("#dayStrip");
    const day = $(`.day[data-date="${state.date}"]`, strip);
    if (!day) return;
    const left = day.offsetLeft - strip.offsetLeft - (strip.clientWidth - day.clientWidth) / 2;
    strip.scrollTo({ left, behavior: REDUCED ? "auto" : "smooth" });
  }
  // Scores for every place that has weather for the chosen day; the chosen sea place also counts its waves.
  function computeScores() {
    state.scores = {};
    if (!state.weather) return;
    PLACES.filter(hasPin).forEach((p) => {
      const r = scorePlace(p, state.weather.data[p.id], p.id === state.place ? state.marine : null);
      if (r) state.scores[p.id] = r;
    });
  }
  const MODE_SHORT = { forecast: "예보", archive: "과거 재분석", climate: "평년값 참고" };
  // v2.0.10: words that say what to do (score 80+, 65-79, 50-64, under 50)
  const VERDICT = { good: "출조 추천", info: "출조 가능", warn: "짧게 출조", bad: "출조 보류" };
  const mono = (t) => `<span class="mono">${t}</span>`;
  // Wind colours: up to 2 m/s green, 2 to 5 m/s orange, 5 m/s and above red.
  const WIND_COL = ["#2ee68f", "#ff9f3a", "#ff4f4f"];
  const windCol = (v) => WIND_COL[v < 2 ? 0 : v < 5 ? 1 : 2];
  // A gradient along the y axis (in the chart's own pixels) whose colour steps at the given values.
  // bands: [[upTo, colour], ...] from the bottom; the last colour runs to the top.
  function bandGradient(id, yAtLo, yAtHi, lo, hi, bands) {
    const f = (v) => Math.max(0, Math.min(1, (v - lo) / (hi - lo))).toFixed(4);
    let stops = "", from = lo;
    bands.forEach(([upTo, col]) => { stops += `<stop offset="${f(from)}" stop-color="${col}"/><stop offset="${f(Math.min(upTo, hi))}" stop-color="${col}"/>`; from = upTo; });
    return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${yAtLo}" y2="${yAtHi}">${stops}</linearGradient>`;
  }
  // Temperature colours: below 0 °C red, 0 to 10 °C yellow, above 10 °C the usual blue.
  const TEMP_BANDS = [[0, "#ff4f4f"], [10, "#ffd23f"], [99, "var(--line-temp)"]];
  const tempCol = (v) => (v < 0 ? "#ff4f4f" : v < 10 ? "#ffd23f" : "var(--line-temp)");
  // Rain colours: under 1 mm yellow, 1 mm and more red.
  const rainCol = (v) => (v >= 1 ? "#ff4f4f" : "#ffd23f");
  // The wind version: changes exactly at the 2 and 5 m/s lines.
  function windGradient(id, yAt0, yAtTop, top) {
    const f = (v) => Math.max(0, Math.min(1, v / top)).toFixed(4);
    return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${yAt0}" y2="${yAtTop}"><stop offset="0" stop-color="${WIND_COL[0]}"/><stop offset="${f(2)}" stop-color="${WIND_COL[0]}"/><stop offset="${f(2)}" stop-color="${WIND_COL[1]}"/><stop offset="${f(5)}" stop-color="${WIND_COL[1]}"/><stop offset="${f(5)}" stop-color="${WIND_COL[2]}"/><stop offset="1" stop-color="${WIND_COL[2]}"/></linearGradient>`;
  }
  // A three-lamp traffic light beside the verdict: green for 출조 추천 and 출조 가능 (dimmer), yellow for 짧게 출조, red for 출조 보류.
  const LAMP = { good: 2, info: 2, warn: 1, bad: 0 };
  function signalLight(tone, cls = "") {
    const on = LAMP[tone];
    const lamp = (i, color) => `<circle cx="20" cy="${18 + i * 28}" r="10" class="${i === on ? `lamp-on${tone === "info" ? " dim" : ""}` : "lamp-off"}" style="--lamp:${color}"/>`;
    return `<svg class="signal ${cls}" viewBox="0 0 40 96" role="img" aria-label="신호등 ${["빨강", "노랑", "초록"][on]}"><rect x="2" y="2" width="36" height="92" rx="12" class="sig-box"/>${lamp(0, "#ff5147")}${lamp(1, "#ffc02e")}${lamp(2, "#2ee68f")}</svg>`;
  }

  // 입질 = how the fish should feed (temperature, time of day, pressure); 편의 = how easy the water is to fish (wind, rain, waves).
  // Both come from the same hourly factors as the score, so they never disagree with it.
  const peakBite = (r) => Math.max(...r.hours.filter(Boolean).map((x) => Math.round(geo({ temp: x.f.temp, time: x.f.time, press: x.f.press }))));
  function subScores(r) {
    const span = r.hours.slice(r.from, r.to).filter(Boolean);
    const part = (keys) => Math.round(span.reduce((s, x) => s + geo(Object.fromEntries(keys.filter((k) => x.f[k] != null).map((k) => [k, x.f[k]]))), 0) / (span.length || 1));
    return { bite: part(["temp", "time", "press"]), access: part(["wind", "rain", "wave"]) };
  }
  // How far ahead the forecast reaches; a rough guide, not a model statistic.
  function confidence(date, mode) {
    if (mode === "climate") return 30;
    if (mode === "archive") return 95;
    const lead = diffDays(date, TODAY);
    return lead <= 0 ? 95 : Math.max(50, Math.round(92 - 3 * lead));
  }
  function windowState(r) {
    if (state.date < TODAY) return ["지난 날", ""];
    if (state.date > TODAY) return [`${diffDays(state.date, TODAY)}일 뒤`, "wait"];
    const now = new Date().getHours() + new Date().getMinutes() / 60;
    if (now < r.from) return [`${Math.ceil(r.from - now)}시간 뒤`, "wait"];
    if (now < r.to) return ["열림", "open"];
    return ["닫힘", ""];
  }
  function alertsFor(p, w) {
    const out = [];
    const wmax = Math.max(...fin(w.wind)), gmax = w.gust ? Math.max(...fin(w.gust)) : 0, rain = fin(w.precip).reduce((a, b) => a + b, 0);
    if (state.weather.savedAt) out.push({ k: "offline", t: "인터넷 연결 없음", body: `${new Date(state.weather.savedAt).toLocaleString("ko-KR")}에 저장된 날씨로 계산했습니다. 최신 예보와 다를 수 있습니다.`, src: "저장된 예보" });
    if (state.weather.mode === "climate") out.push({ k: "climate", t: "예보 범위 밖", body: `${state.weather.years.join(", ")}년 같은 날짜의 평균 날씨로 낸 참고 점수입니다. 예보는 ${FORECAST_END.replaceAll("-", ".")}까지 나옵니다.`, src: "Open-Meteo 과거 자료" });
    // weather warning boxes are for sea spots only; at ponds strong wind and rain show in the score and the advice
    if (p.type === "바다" && (wmax >= 7 || gmax >= 12)) out.push({ k: "wind", t: `강풍 주의 · ${w.wind.indexOf(wmax)}시 전후`, body: `바람이 최대 ${num(wmax)}m/s, 돌풍은 ${num(gmax)}m/s까지 붑니다. 보트와 갯바위 끝은 피하세요.`, src: "Open-Meteo 예보" });
    if (p.type === "바다" && rain >= 10) out.push({ k: "rain", t: "많은 비", body: `하루 ${num(rain)}mm의 비가 예보돼 있습니다. 물이 불고 흐려질 수 있습니다.`, src: "Open-Meteo 예보" });
    const wave = state.marine?.wave ? Math.max(0, ...fin(state.marine.wave)) : 0;
    if (p.type === "바다" && wave > 1.5) out.push({ k: "wave", t: "높은 파도", body: `파고가 최대 ${num(wave)}m까지 오릅니다.`, src: "Open-Meteo 해상 모델" });
    if (p.type === "바다") out.push({ k: "sea", t: "해상 값은 참고치", body: "출항 판단은 기상청 특보와 물때표로 다시 확인하세요.", src: "기상청 해상특보" });
    return out.filter((a) => !state.alertClosed[`${state.date}|${p.id}|${a.k}`]).map((a) => ({ ...a, key: `${state.date}|${p.id}|${a.k}` }));
  }
  // Highs and lows of the modelled sea level for sea spots; sun and moon for the rest.
  function dayTiles(p, r) {
    const sea = state.marine?.sea;
    if (p.type === "바다" && sea && fin(sea).length > 6) {
      const ext = [];
      for (let h = 1; h < 23; h++) {
        const [a, b, c] = [sea[h - 1], sea[h], sea[h + 1]];
        if ([a, b, c].some((v) => v == null)) continue;
        if (b >= a && b > c) ext.push([h, "H", b]);
        else if (b <= a && b < c) ext.push([h, "L", b]);
      }
      if (ext.length) return { title: `물때 · ${dayLabel()} · ${tideHint(state.date)}`, tiles: ext.slice(0, 4).map(([h, k, v]) => ({ mark: k === "H" ? "▲" : "▼", cls: k === "H" ? "hi" : "lo", top: hhmm(h), sub: `${k === "H" ? "만조" : "간조"} ${v.toFixed(1)}m` })) };
    }
    const age = moonAge(state.date);
    return { title: `해와 달 · ${dayLabel()}`, tiles: [
      { mark: "▲", cls: "hi", top: r.sunrise || "–", sub: "일출" },
      { mark: "▼", cls: "lo", top: r.sunset || "–", sub: "일몰" },
      { mark: "●", cls: "", top: age.toFixed(1), sub: `월령 ${moonName(age)}` },
      r.water ? { mark: "≈", cls: "", top: `${num(r.water.surface)}℃`, sub: "표층 수온" } : { mark: "≈", cls: "", top: `${num(r.temp)}℃`, sub: "기온" },
    ] };
  }
  const guideFor = (p) => PAGES.filter((x) => x.guide && x.place === p.id).sort((a, b) => (b.version || "").localeCompare(a.version || ""))[0];
  const dayLabel = () => (state.date === TODAY ? "오늘" : fmtShort(state.date));

  function renderTop() {
    const p = placeById[state.place], r = state.scores?.[p.id];
    $("#topGo").innerHTML = r ? `${signalLight(scoreTone(r.score), "sm")}<b class="tg-v tone-${scoreTone(r.score)}">${VERDICT[scoreTone(r.score)]}</b><b class="mono tone-${scoreTone(r.score)}">${r.score}</b><span class="eyebrow">· 최고<br>${hhmm(r.from)}</span>` : "";
    $("#typeToggle").innerHTML = TYPES.map((t) => `<button data-type="${t}" class="${p.type === t ? "on" : ""}">${t}</button>`).join("");
  }
  // Weather source and the time it was fetched, with a button to fetch it again.
  function renderWxBtn(busy = false) {
    const b = $("#wxBtn");
    if (!b) return;
    const t = state.wxAt ? `${pad2(state.wxAt.getHours())}:${pad2(state.wxAt.getMinutes())}` : "–";
    b.classList.toggle("busy", busy);
    b.innerHTML = `${icon("refresh")}<span><small>날씨 출처 Open-Meteo</small><b>${busy ? "받는 중" : state.weather?.savedAt ? "저장본" : `${t} 갱신`}</b></span>`;
    b.title = `날씨: Open-Meteo 예보(open-meteo.com, 여러 기상 모델을 합친 값). ${state.wxAt ? `마지막으로 ${t}에 받았습니다. ` : ""}누르면 지금 다시 받습니다.`;
  }
  function refreshWeather() {
    [cacheW, outlookCache, dailyCache].forEach((c) => Object.keys(c).forEach((k) => delete c[k]));
    renderWxBtn(true);
    loadAll();
  }
  function updateClock() {
    const d = new Date();
    $("#topClock").innerHTML = `${WEEK[d.getDay()]}요일, ${d.getMonth() + 1}월 ${d.getDate()}일<br><b class="mono">${pad(d.getHours())}:${pad(d.getMinutes())}</b>`;
  }

  function renderBrief(err) {
    if (state.view === "home") setTimeout(renderHome, 0);
    const p = placeById[state.place];
    const w = state.weather?.data[p.id];
    const r = state.scores?.[p.id];
    renderTop();
    renderMapPanel();
    const msg = (text) => { $("#ccLeft").innerHTML = `<p class="eyebrow">판단 · ${dayLabel()}</p><p class="lead">${text}</p>`; $("#ccMid").innerHTML = ""; $("#ccRight").innerHTML = ""; bigChart = null; };
    if (!hasPin(p)) return msg("이 낚시터의 주소를 찾지 못해 날씨를 조회할 수 없습니다. 지도 화면에서 낚시터 위치를 누르면 저장되고 점수가 바로 나옵니다.");
    if (err) return msg(`날씨 정보를 불러오지 못했습니다(${esc(err)}). 인터넷 연결을 확인한 뒤 날짜를 다시 선택해 주세요. 아래 공략 자료는 그대로 볼 수 있습니다.`);
    if (!w || !r) {
      $("#ccLeft").innerHTML = `<div class="skeleton" style="min-height:420px"></div>`;
      $("#ccMid").innerHTML = `<div class="skeleton" style="min-height:360px"></div>`;
      $("#ccRight").innerHTML = `<div class="skeleton" style="min-height:420px"></div>`;
      bigChart = null;
      return;
    }
    const tone = scoreTone(r.score), sub = subScores(r), v = verdictText(r, p);
    const alerts = alertsFor(p, w), a = alerts[0];
    const guide = guideFor(p);
    const tt = dayTiles(p, r);
    const lead = [`바람 ${num(r.wind)}m/s, ${READ.wind(r)}`, `기압 ${READ.press(r).split(",")[0]}`, READ.rain(r)].join(". ");
    $("#ccLeft").innerHTML = `
      ${a ? `<div class="alert"><button class="alert-x" data-alert-close="${esc(a.key)}" aria-label="알림 닫기">${icon("x")}</button>
        <b class="mono">${esc(a.t)}${alerts.length > 1 ? ` · 외 ${alerts.length - 1}건` : ""}</b><p>${esc(a.body)}</p><small>출처: <span>${esc(a.src)}</span></small></div>` : ""}
      <p class="eyebrow accent">판단 · ${dayLabel()} · ${state.date === TODAY ? `${pad2(new Date().getHours())}:${pad2(new Date().getMinutes())}` : MODE_SHORT[state.weather.mode]}</p>
      <div class="verdict-row">${signalLight(tone)}<div class="verdict-word tone-${tone}">${VERDICT[tone]}</div></div>
      <p class="lead">${esc(lead)}. ${state.date < TODAY || (state.date === TODAY && new Date().getHours() >= r.to) ? `${mono(hhmm(r.from))}부터 ${r.to - r.from}시간이 가장 좋았습니다` : state.date === TODAY && new Date().getHours() >= r.from ? `좋은 시간이 ${mono(hhmm(r.to))}까지 이어집니다` : `${r.to - r.from}시간의 좋은 시간이 ${mono(hhmm(r.from))}에 열립니다`}.</p>
      <div class="kpis">
        <div><span class="eyebrow">입질</span><strong>${sub.bite}</strong><small class="mono">하루 최고 · ${peakBite(r)}</small></div>
        <div><span class="eyebrow">편의</span><strong>${sub.access}</strong><small class="mono">바람 ${num(r.wind)}m/s ${r.dir != null ? compass(r.dir) : ""}</small></div>
      </div>
      <button class="cta" ${guide ? `data-open="${guide.id}"` : 'data-jump="docsSec"'}><span><small class="eyebrow">출조 준비</small><b>${guide ? "이 낚시터 공략법 보기" : "공략 자료 보기"}</b></span>${icon("play")}</button>
      <p class="eyebrow">${tt.title}</p>
      <div class="tiles4">${(() => { const nowHm = `${pad2(new Date().getHours())}:${pad2(new Date().getMinutes())}`; const nx = state.date === TODAY ? tt.tiles.findIndex((t) => /^\d\d:\d\d$/.test(t.top) && t.top >= nowHm) : -1; return tt.tiles.map((t, i) => `<div class="tile4 ${t.cls} ${i === nx ? "next" : ""}"><i>${t.mark}</i><b class="mono">${esc(t.top)}</b><small class="mono">${esc(t.sub)}</small></div>`).join(""); })()}</div>
      <div class="chips2"><span class="mono">${r.dir != null ? compass(r.dir) + "풍 " : ""}${num(r.wind)}m/s</span><span class="mono">${r.pressure != null ? `${Math.round(r.pressure)}hPa ${r.pTrend >= 0 ? "+" : "−"}${num(Math.abs(r.pTrend))}` : "기압 –"}</span></div>
      <ul class="todo">${v.act.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;

    const temps = fin(w.temp), winds = fin(w.wind);
    const past = state.date < TODAY || (state.date === TODAY && new Date().getHours() >= r.to);
    $("#ccMid").innerHTML = `
      <p class="eyebrow">하루 24시간 · 점수 · 기온 · 바람${p.type === "바다" ? ` · 물때 ${mulTae(state.date).name}(${mulTae(state.date).note}) · 유속` : ""}</p>
      <h2 class="mid-title">가장 좋은 시간${past ? "은" : "은"} <em class="mono">${hhmm(r.from)}</em>${past ? "이었습니다" : "입니다"}.</h2>
      <p class="mid-sub" id="midSub">16일 전망을 불러오는 중입니다.</p>
      <div class="bigchart" id="bigChart"><div class="bc-read mono" id="bcRead"></div></div>
      <p class="bc-legend mono">${legendFor(p, w)}</p>
      <p class="bc-src">날씨 출처: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> 예보 · ${esc(p.id)} 좌표 기준${state.wxAt ? ` · ${pad2(state.wxAt.getHours())}:${pad2(state.wxAt.getMinutes())} 갱신` : ""}${p.type === "바다" ? ` · 조위·파고·유속은 Open-Meteo 해상 모델 값 · 물때는 음력 ${mulTae(state.date).lunar}일 기준 서해 7물때식` : " · 수온은 지난 10일과 예보 기온으로 낸 추정값(약 3일 늦게 기온을 따라감)"}</p>`;
    bigChart = drawBigChart($("#bigChart"), r, w);
    renderMidSub();

    const [ws, wcls] = windowState(r);
    // each place is scored as its main kind of fishing, so it is ranked only among places of that kind
    const list = Object.values(state.scores).filter((x) => placeById[x.id].type === p.type).sort((x, y) => y.score - x.score);
    $("#ccRight").innerHTML = `
      <p class="eyebrow accent">최고 · ${dayLabel()}</p>
      <div class="peak mono">${hhmm(r.from)}<span>–</span>${hhmm(r.to)}</div>
      <p class="peak-sub">${esc(r.water ? `표층 수온 ${num(r.water.surface)}℃` : `기온 ${num(r.temp)}℃`)}, 바람 ${num(r.wind)}m/s. ${esc(READ.rain(r))}.</p>
      <div class="boxes">
        <div class="box"><span class="eyebrow">시간대</span><b class="mono ${wcls}">${ws}</b></div>
        <div class="box"><span class="eyebrow">예보 신뢰도</span><b class="mono accent">${confidence(state.date, state.weather.mode)}%</b></div>
      </div>
      <p class="eyebrow">갈 만한 곳 · ${esc(p.type)}낚시 ${list.length}곳</p>
      <ol class="rank-list">${list.slice(0, 7).map((x) => `<li><button data-place="${esc(x.id)}" class="${x.id === p.id ? "on" : ""}">
        <span class="ri">${icon("fish")}</span>
        <span class="rn"><b>${esc(x.id)}</b><small>${x.from}~${x.to}시 · ${esc(whyText(x))}</small></span>
        <span class="rs mono tone-${scoreTone(x.score)}">${x.score}</span></button></li>`).join("")}</ol>
      ${p.id === "덕봉" ? `<a class="side-link" href="research/deokbong3d.html" target="_blank" rel="noopener">${icon("cube")}덕봉 3D 자리 분석</a>` : ""}${p.id === "한터" ? `<a class="side-link" href="research/hanteo3d.html" target="_blank" rel="noopener">${icon("cube")}한터 3D 자리 분석</a>` : ""}${p.id === "장광" ? `<a class="side-link" href="research/jangkwang3d.html" target="_blank" rel="noopener">${icon("cube")}장광 3D 자리 분석</a>` : ""}
      <details class="v-how"><summary>점수 계산 방법</summary><p>시간마다 바람(25%), 기온 또는 송어터 수온(25%), 강수(20%), 시간대(20%, 조과 기록이 있으면 절반 반영), 3시간 기압 변화(10%)${p.type === "바다" ? ", 파고(15%)" : ""}를 0~1로 바꿔 가중 기하평균을 내고 제곱합니다. 하루 점수는 가장 좋은 연속 2~4시간(70%)과 해 있는 시간 전체(30%)의 평균입니다. 입질은 수온·시간대·기압만, 편의는 바람·강수${p.type === "바다" ? "·파고" : ""}만으로 같은 방식으로 낸 값입니다. 예보 신뢰도는 예보까지 남은 날수로 정한 어림값입니다. 가중치는 가정이며 실제 조과로 검증하지 않았습니다.</p></details>`;
  }

  function renderMidSub() {
    const el = $("#midSub");
    if (!el) return;
    const days = (state.outlook || []).filter((d) => d.r);
    if (!days.length) { el.textContent = "16일 전망을 불러오지 못했습니다."; return; }
    const next = days.find((d) => d.date === addDays(state.date, 1));
    const best = days.reduce((x, y) => (y.r.score > x.r.score ? y : x));
    const parts = [];
    if (next) parts.push(`${state.date === TODAY ? "내일" : "다음 날"} 최고는 ${mono(hhmm(next.r.from))}, ${next.r.score}점입니다.`);
    parts.push(best.date === state.date ? "16일 중 이날이 가장 좋습니다." : `16일 중 가장 좋은 날은 ${fmtShort(best.date)}, ${best.r.score}점입니다.`);
    el.innerHTML = parts.join(" ");
  }

  function legendFor(p, w) {
    const rng = (a, d = 1) => { const v = fin(a); return `${num(Math.min(...v), d)}~${num(Math.max(...v), d)}`; };
    const sea = p.type === "바다" && state.marine?.sea && fin(state.marine.sea).length > 6, wave = sea && state.marine.wave && fin(state.marine.wave).length;
    const wsr = waterSeries(p);
    const curv = sea && state.marine.cur && fin(state.marine.cur).length;
    // each colour key and its words form one unbreakable item, so a line never breaks between them
    const item = (key, text) => `<b class="lg"><span class="${key}"></span>${text}</b>`;
    return [
      item("k-bar", "점수 0~100"),
      item("k-temp", `기온 ${rng(w.temp, 1)}℃(<i class="wk r">0 미만</i><i class="wk y">0~10</i><i class="wk b">10~</i>)`),
      curv ? item("k-cur", `유속 ${rng(state.marine.cur, 2)}m/s`) : "",
      wsr ? item("k-water", `수온 ${rng(wsr.values, 1)}℃(${wsr.fitted ? "실측 곡선에 맞춘 추정" : "추정"})`) : "",
      item("k-wind", `바람 ${rng(w.wind)}m/s(<i class="wk g">~2m/s</i><i class="wk o">2~5m/s</i><i class="wk r">5m/s~</i>)`),
      sea ? item("k-tide", `조위 ${rng(state.marine.sea, 1)}m${wave ? `, 파고 ${rng(state.marine.wave)}m` : ""}`) : "",
      item("k-sun", "일출·일몰"),
    ].filter(Boolean).join("");
  }
  // Score bars for each hour with temperature and wind drawn over them.
  let bigChart = null;
  function drawBigChart(host, r, w) {
    const H = 300, m = { l: 34, r: 12, t: 38, b: 26 };
    const svgBox = document.createElement("div");
    host.append(svgBox);
    let W = 0;
    const X = (i) => m.l + (W - m.l - m.r) * (i + .5) / 24;
    const slot = () => (W - m.l - m.r) / 24;
    const Y = (v) => m.t + (H - m.t - m.b) * (1 - v / 100);
    const sea = placeById[state.place].type === "바다" && state.marine?.sea && fin(state.marine.sea).length > 6;
    const blue = w.temp, dash = w.wind, dashUnit = "m/s";
    const tide = sea ? state.marine.sea : null;
    const tv = tide ? fin(tide) : [], tdl = Math.min(...tv), tdh = Math.max(...tv);
    const DY = (v) => m.t + (H - m.t - m.b) * (.92 - .5 * (v - tdl) / ((tdh - tdl) || 1));
    const cur = sea && state.marine.cur && fin(state.marine.cur).length ? state.marine.cur : null;
    const cmax = cur ? Math.max(.3, ...fin(cur)) : 1;
    const CY = (v) => m.t + (H - m.t - m.b) * (1 - v / cmax * .45);
    const wsr = waterSeries(placeById[state.place]), wat = wsr?.values || null;
    const bv = [...fin(blue), ...(wat ? fin(wat) : [])], tlo = Math.min(...bv), thi = Math.max(...bv), pad = (thi - tlo) * .15 || 1;
    const TY = (t) => m.t + (H - m.t - m.b) * (.88 - .72 * (t - tlo + pad) / (thi - tlo + 2 * pad));
    const wmax = Math.max(dash === w.wind ? 6 : 2, ...fin(dash));
    const WY = (v) => m.t + (H - m.t - m.b) * (1 - v / wmax * .9);
    const nowH = state.date === TODAY ? new Date().getHours() : -1;
    const vals = r.hours.map((x) => (x ? Math.round(x.s) : null));
    const top = Math.max(...vals.filter((v) => v != null));
    const topAt = vals.findIndex((v, h) => v === top && h >= r.from && h < r.to);
    function draw() {
      W = host.clientWidth;
      if (W < 200) return;
      const P = [], LBL = [];
      // fixed = labels that must stay where they are (score over its bar, 지금)
      const lab = (x, y, text, anchor, cls, style = "", fixed = false) => LBL.push({ x, y, text, anchor, cls, style, fixed });
      [0, 25, 50, 75, 100].forEach((v) => {
        P.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/>`);
        P.push(`<text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end" class="ax">${v}</text>`);
      });
      const bw = Math.max(3, slot() - 3);
      vals.forEach((v, h) => {
        if (v == null) return;
        const cls = h >= r.from && h < r.to ? "b-on" : h === nowH ? "b-now" : "b-off";
        P.push(`<rect class="${cls}" x="${X(h) - bw / 2}" y="${Y(v)}" width="${bw}" height="${Y(0) - Y(v)}" rx="2"/>`);
        if (h === topAt && h !== nowH) lab(X(h), Y(v) - 6, String(v), "middle", "acc", "", true);
        if (h === nowH) lab(X(h), Y(v) - 6, "지금", "middle", "", "", true);
      });
      // Catmull-Rom through the hourly points, drawn as cubic Béziers, so the lines read as curves
      const smooth = (arr, fy) => {
        const pts = arr.map((v, i) => (v == null ? null : [X(i), fy(v)])).filter(Boolean);
        if (pts.length < 2) return "";
        let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
          d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
        }
        return d;
      };
      const tl = smooth(blue, TY);
      if (tl) {
        const first = blue.findIndex((v) => v != null), last = blue.length - 1 - [...blue].reverse().findIndex((v) => v != null);
        P.unshift(`<defs><linearGradient id="bcFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--line-temp)" stop-opacity=".28"/><stop offset="1" stop-color="var(--line-temp)" stop-opacity="0"/></linearGradient></defs>`);
        P.push(`<path d="${tl}L${X(last).toFixed(1)} ${Y(0)}L${X(first).toFixed(1)} ${Y(0)}Z" fill="url(#bcFill)"/>`);
        P.push(`<defs>${bandGradient("bcTemp", TY(-60), TY(100), -60, 100, TEMP_BANDS)}</defs><path d="${tl}" class="l-temp" style="stroke:url(#bcTemp)"/>`);
      }
      P.push(`<defs>${windGradient("bcWind", WY(0), WY(wmax), wmax)}</defs><path d="${smooth(dash, WY)}" class="l-wind" style="stroke:url(#bcWind)"/>`);
      // highest and lowest of temperature and wind, marked on their lines
      const ext = (arr, fy, cls, unit, d) => {
        const v = fin(arr);
        if (!v.length) return;
        const hi = arr.indexOf(Math.max(...v)), lo = arr.indexOf(Math.min(...v));
        [[hi, "최고", -9], [lo, "최저", 17]].forEach(([i, word, dy]) => {
          const x = X(i), y = fy(arr[i]);
          const anchor = i < 2 ? "start" : i > 21 ? "end" : "middle";
          const col = cls === "wind" ? ` style="fill:${windCol(arr[i])}"` : cls === "temp" ? ` style="fill:${tempCol(arr[i])}"` : "";
          P.push(`<circle cx="${x}" cy="${y}" r="3.2" class="pt ${cls}"${col}/>`);
          lab(x, y + dy, `${word} ${num(arr[i], d)}${unit}`, anchor, cls, col);
        });
      };
      ext(blue, TY, "temp", "℃", 1);
      if (wat) {
        P.push(`<path d="${smooth(wat, TY)}" class="l-water"/>`);
        const wv = fin(wat), hi = wat.indexOf(Math.max(...wv)), lo = wat.indexOf(Math.min(...wv));
        [[hi, "수온 최고", -9], [lo, "수온 최저", 17]].forEach(([i, word, dy], k) => {
          if (k === 1 && Math.abs(wat[hi] - wat[lo]) < .05) return;
          const anchor = i < 2 ? "start" : i > 21 ? "end" : "middle";
          P.push(`<circle cx="${X(i)}" cy="${TY(wat[i])}" r="3.2" class="pt water"/>`);
          lab(X(i), TY(wat[i]) + dy, `${word} ${num(wat[i], 1)}℃`, anchor, "water");
        });
      }
      ext(dash, WY, "wind", dashUnit, 1);
      // sunrise and sunset as thin vertical lines with their times
      const xt = (t) => m.l + (W - m.l - m.r) * t / 24;
      [[r.sunrise ?? w.sunrise, "일출"], [r.sunset ?? w.sunset, "일몰"]].forEach(([t, word]) => {
        const f = hourFrac(t);
        if (f == null) return;
        P.push(`<line x1="${xt(f)}" x2="${xt(f)}" y1="${m.t - 14}" y2="${H - m.b}" class="sunline"/><text x="${xt(f) + (word === "일출" ? 4 : -4)}" y="${m.t - 6}" text-anchor="${word === "일출" ? "start" : "end"}" class="lab sun">${word} ${esc(t)}</text>`);
      });
      // at sea: the modelled tide as a third line, with high and low water times
      if (tide) {
        P.push(`<path d="${smooth(tide, DY)}" class="l-tide"/>`);
        for (let h = 1; h < 23; h++) {
          const [a, b, c] = [tide[h - 1], tide[h], tide[h + 1]];
          if ([a, b, c].some((v) => v == null)) continue;
          const high = b >= a && b > c, low = b <= a && b < c;
          if (!high && !low) continue;
          lab(X(h), DY(b) + (high ? -8 : 15), `${high ? "▲만조" : "▼간조"} ${pad2(h)}:00`, "middle", "tide");
        }
      }
      // hourly current speed (model): fastest and slowest marked
      if (cur) {
        P.push(`<path d="${smooth(cur, CY)}" class="l-cur"/>`);
        const cv = fin(cur), hi = cur.indexOf(Math.max(...cv)), lo = cur.indexOf(Math.min(...cv));
        [[hi, "유속 최고", -8], [lo, "유속 최저", 15]].forEach(([i, word, dy]) => {
          const anchor = i < 2 ? "start" : i > 21 ? "end" : "middle";
          P.push(`<circle cx="${X(i)}" cy="${CY(cur[i])}" r="3" class="pt cur"/>`);
          lab(X(i), CY(cur[i]) + dy, `${word} ${num(cur[i], 2)}m/s`, anchor, "cur");
        });
      }
      [0, 3, 6, 9, 12, 15, 18, 21].forEach((h) => P.push(`<text x="${m.l + slot() * h}" y="${H - 6}" class="ax">${pad2(h)}</text>`));
      // Labels: fixed ones first, then each other label tries its own spot and, if that overlaps
      // a label already placed, moves up or down in 13 px steps until it finds a free spot.
      const meas = document.createElement("canvas").getContext("2d");
      meas.font = '600 11.5px "Pretendard Variable", Pretendard, sans-serif';
      const placed = [];
      const boxOf = (l, y) => { const w = meas.measureText(l.text).width + 4; const x0 = l.anchor === "start" ? l.x : l.anchor === "end" ? l.x - w : l.x - w / 2; return { x0, x1: x0 + w, y0: y - 11, y1: y + 3 }; };
      const hits = (b) => placed.some((q) => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0);
      const yMin = m.t + 10, yMax = H - m.b - 4;
      [...LBL.filter((l) => l.fixed), ...LBL.filter((l) => !l.fixed)].forEach((l) => {
        let y = Math.max(yMin, Math.min(yMax, l.y));
        if (!l.fixed) {
          for (const off of [0, -13, 13, -26, 26, -39, 39, -52, 52, -65, 65]) {
            const ty = Math.max(yMin, Math.min(yMax, l.y + off));
            if (!hits(boxOf(l, ty))) { y = ty; break; }
          }
        }
        placed.push(boxOf(l, y));
        P.push(`<text x="${l.x}" y="${y}" text-anchor="${l.anchor}" class="lab ${l.cls}"${l.style}>${l.text}</text>`);
      });
      P.push(`<line class="cur" y1="${m.t}" y2="${H - m.b}" stroke="var(--ink-2)" stroke-dasharray="2 3"/>`);
      P.push(`<rect class="hit" x="0" y="0" width="${W}" height="${H}" fill="transparent"/>`);
      svgBox.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="시간대별 점수와 기온, 바람">${P.join("")}</svg>`;
      const hit = $(".hit", svgBox);
      hit.addEventListener("pointermove", (e) => {
        const b = hit.ownerSVGElement.getBoundingClientRect();
        const h = Math.max(0, Math.min(23, Math.floor(((e.clientX - b.left) / b.width * W - m.l) / slot())));
        stopPlay(); setHour(h, true);
      });
      update(state.hour);
    }
    function update(h) {
      const cur = $(".cur", svgBox);
      if (!cur) return;
      cur.setAttribute("x1", X(h)); cur.setAttribute("x2", X(h));
      const rd = $("#bcRead");
      if (rd) rd.innerHTML = `${pad2(h)}:00 · 점수 <b>${vals[h] ?? "–"}</b> · 기온 ${num(w.temp[h])}℃${wat?.[h] != null ? ` · 수온 ${num(wat[h])}℃` : ""} · 바람 ${num(w.wind[h])}m/s${w.dir[h] != null ? ` ${compass(w.dir[h])}` : ""}${sea ? ` · 조위 ${num(state.marine.sea[h], 2)}m` : ""}${cur?.[h] != null ? ` · 유속 ${num(cur[h], 2)}m/s(${num(cur[h] * 1.944, 1)}노트${state.marine.curDir?.[h] != null ? ` ${compass(state.marine.curDir[h])}쪽` : ""})` : ""}${sea && state.marine.wave?.[h] != null ? ` · 파고 ${num(state.marine.wave[h])}m` : ""}${w.precip?.[h] ? ` · 비 ${num(w.precip[h])}mm` : ""}`;
    }
    draw();
    const ro = new ResizeObserver(() => { if (Math.abs(host.clientWidth - W) > 2) draw(); });
    ro.observe(host);
    return { update, destroy: () => ro.disconnect() };
  }

  // Two rings per day: outer = 입질, inner = 편의. Each ring is drawn in short pieces that run from red at 0
  // through yellow to green at 100, so a ring that stops early stays red and a full ring ends in green.
  const hueAt = (v) => `hsl(${Math.round(Math.max(0, Math.min(100, v)) * 1.2)} 78% 50%)`;
  function ringGauge(outer, inner) {
    const PIECES = 40;
    const pt = (r, pos) => { const a = (pos * 3.6 - 90) * Math.PI / 180; return `${(32 + r * Math.cos(a)).toFixed(2)} ${(32 + r * Math.sin(a)).toFixed(2)}`; };
    const ring = (r, v) => {
      let out = `<circle r="${r}" cx="32" cy="32" class="rg-track"/>`;
      for (let i = 0; i < PIECES; i++) {
        const p0 = i * 100 / PIECES, p1 = Math.min(v, (i + 1) * 100 / PIECES);
        if (p0 >= v) break;
        out += `<path d="M${pt(r, p0)}A${r} ${r} 0 0 1 ${pt(r, p1 + (p1 < v ? .3 : 0))}" stroke="${hueAt((p0 + p1) / 2)}"/>`;
      }
      return out;
    };
    return `<svg class="rg" viewBox="0 0 64 64" role="img" aria-label="입질 ${outer}, 편의 ${inner}">${ring(27.5, outer)}${ring(20, inner)}
      <text x="32" y="30" text-anchor="middle" class="rg-n" fill="${hueAt(outer)}">${outer}</text><line x1="24" x2="40" y1="33.5" y2="33.5" class="rg-sep"/><text x="32" y="44.5" text-anchor="middle" class="rg-n" fill="${hueAt(inner)}">${inner}</text></svg>`;
  }
  // Sixteen days laid out on a week grid, each with its own best window from the hourly forecast.
  function renderDays() {
    const el = $("#dayStrip"), days = (state.outlook || []).filter((d) => d.r);
    if (!days.length) { el.innerHTML = ""; return; }
    const lead = parseISO(days[0].date).getDay();
    const tail = (7 - ((lead + days.length) % 7)) % 7;
    const head = WEEK.map((w, i) => `<span class="cal-w ${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${w}</span>`).join("");
    const pad = (n) => Array.from({ length: n }, () => '<span class="cal-pad" aria-hidden="true"></span>').join("");
    const cells = days.map((d) => {
      const r = d.r, t = scoreTone(r.score), sub = subScores(r), dt = parseISO(d.date), wd = dt.getDay();
      return `<button class="cday tone-${t} ${d.date === state.date ? "on" : ""} ${d.date === TODAY ? "today" : ""}" data-date="${d.date}" title="${fmtDate(d.date)} ${VERDICT[t]} 점수 ${r.score}, 입질 ${sub.bite}, 편의 ${sub.access}, 좋은 시간 ${r.from}~${r.to}시">
        <span class="cd-top"><b class="mono ${wd === 0 ? "sun" : wd === 6 ? "sat" : ""}">${dt.getDate()}${d.date === TODAY ? "<small>오늘</small>" : dt.getDate() === 1 ? `<small>${dt.getMonth() + 1}월</small>` : ""}</b><span class="cd-s mono">${r.score}</span></span>
        ${ringGauge(sub.bite, sub.access)}
        <span class="cd-v">${VERDICT[t]}</span>
        ${placeById[state.place].type === "바다" ? `<span class="cd-m">${mulTae(d.date).name}</span>` : ""}<span class="cd-w mono">${pad2(r.from)}–${pad2(r.to)}시</span></button>`;
    }).join("");
    el.innerHTML = `<div class="cal-top"><span class="eyebrow">앞으로 16일</span><span class="cal-key mono"><i class="k-grad"></i>낮음 → 높음 <span>· 위 숫자 입질(바깥 원) · 아래 숫자 편의(안쪽 원) · 오른쪽 위 하루 점수</span></span></div>
      <div class="cal">${head}${pad(lead)}${cells}${pad(tail)}</div>`;
    renderMidSub();
  }
  const pad2 = (n) => String(n).padStart(2, "0");

  // Circles on the map sized by how many fish the log holds for each place.
  let bubbleLayer = null;
  function catchTotals() {
    return PLACES.filter(hasPin).map((p) => {
      const own = p.trips.filter((t) => !t.trip.other && t.trip.catch != null);
      const total = own.reduce((s, t) => s + t.trip.catch, 0);
      return { p, n: own.length, total, avg: own.length ? total / own.length : 0 };
    }).filter((x) => x.n);
  }
  function catchSummary(p) {
    const list = catchTotals().filter((x) => !state.mapType || placeTypes(x.p).includes(state.mapType));
    const own = list.find((x) => x.p.id === p.id);
    return own ? `${p.id} ${own.n}회, 모두 ${own.total.toLocaleString()}수, 한 번에 평균 ${Math.round(own.avg)}수` : `${p.id}는 조과 기록이 없습니다. 기록이 있는 곳 ${list.length}곳`;
  }
  function drawBubbles() {
    if (bubbleLayer) { bubbleLayer.remove(); bubbleLayer = null; }
    if (!map || !state.bubbles) return;
    bubbleLayer = L.layerGroup(catchTotals().filter((x) => !state.mapType || placeTypes(x.p).includes(state.mapType)).map((x) => {
      const color = x.avg >= 20 ? "#ef6a5b" : x.avg >= 10 ? "#f2b33d" : "#9ad05b";
      return L.circleMarker([x.p.lat, x.p.lon], { radius: 8 + Math.sqrt(x.total) * 1.5, color, weight: 1, fillColor: color, fillOpacity: .32, interactive: true })
        .bindTooltip(`${x.p.id}: ${x.n}회, ${x.total.toLocaleString()}수, 평균 ${Math.round(x.avg)}수`);
    })).addTo(map);
  }
  /* ---------- 홈 (v2.1.0 draft): one-screen overview in the layout of the reference dashboard ---------- */
  const HOME_HEAD = { good: "출조하기 좋은 날!", info: "출조해 볼 만한 날", warn: "짧게 다녀오기 좋은 날", bad: "오늘은 쉬어 가는 날" };
  let homeMap = null, homeMarkers = null, homeFocus = "";
  // An aerial picture centred on the place: a 3 x 3 block of satellite tiles positioned so the
  // spot sits in the middle of the card. If site/img/places/<id>.jpg exists (your own photo), it is shown instead.
  function aerial(p, z = 16) {
    const n = 2 ** z, rad = p.lat * Math.PI / 180;
    const px = (p.lon + 180) / 360 * n * 256, py = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n * 256;
    const tx = Math.floor(px / 256), ty = Math.floor(py / 256), ox = px - tx * 256, oy = py - ty * 256;
    let tiles = "";
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tiles += `<img alt="" loading="lazy" src="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty + dy}/${tx + dx}" style="left:${dx * 256 - ox}px;top:${dy * 256 - oy}px">`;
    const photos = window.FISH_PLACE_PHOTOS?.[p.id] || [];
    if (!photos.length) return `<div class="aer">${tiles}</div><span class="credit">위성 사진 © Esri</span>`;
    // the chosen photos, one at a time (tap the picture for the next), each with its source in small type
    const k = (state.photoIdx?.[p.id] || 0) % photos.length, ph = photos[k];
    return `<div class="aer">${tiles}</div><img class="own" alt="${esc(p.id)} 풍경" src="${ph.src}" loading="lazy" data-photo-next="${esc(p.id)}" title="${esc(ph.title)}">${photos.length > 1 ? `<span class="ph-n">${k + 1}/${photos.length}</span>` : ""}<a class="credit" href="${esc(ph.page)}" target="_blank" rel="noopener" title="${esc(ph.title)}">출처: ${esc(ph.site)}</a>`;
  }
  const starRow = (score) => { const n = Math.max(1, Math.min(5, Math.round(score / 20))); return `<span class="h-stars">${"★".repeat(n)}<i>${"★".repeat(5 - n)}</i></span>`; };
  function homeGauge(score, tone) {
    // 270-degree arc, open at the bottom
    const R = 70, C = 2 * Math.PI * R, arc = C * .75, len = arc * Math.max(0, Math.min(100, score)) / 100;
    return `<svg class="h-gauge" viewBox="0 0 180 170" role="img" aria-label="출조 점수 ${score}점">
      <defs><linearGradient id="hgGrad" x1="0" x2="1" y1="1" y2="0"><stop offset="0" stop-color="#2fd0ff"/><stop offset=".55" stop-color="#3ddc84"/><stop offset="1" stop-color="#b6f36a"/></linearGradient></defs>
      <circle cx="90" cy="88" r="${R}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="14" stroke-dasharray="${arc} ${C}" transform="rotate(135 90 88)" stroke-linecap="round"/>
      <circle cx="90" cy="88" r="${R}" fill="none" stroke="url(#hgGrad)" stroke-width="14" stroke-dasharray="${len} ${C}" transform="rotate(135 90 88)" stroke-linecap="round"/>
      <text x="90" y="100" text-anchor="middle" class="hg-n">${score}</text><text x="90" y="128" text-anchor="middle" class="hg-d">/100</text></svg>`;
  }
  // Hourly score with water (or air) temperature on a second axis, best window shaded.
  function homeActivity(r, p, w) {
    const W = 360, H = 170, L = 30, RR = 30, T = 18, B = 24;
    const X = (h) => L + (W - L - RR) * h / 23;
    const sc = r.hours.map((x) => (x ? x.s : null));
    const wsr = waterSeries(p), temp = wsr ? wsr.values : w.temp, tv = fin(temp);
    const tlo = Math.floor(Math.min(...tv) - 1), thi = Math.ceil(Math.max(...tv) + 1);
    const YS = (v) => T + (H - T - B) * (1 - v / 100), YT = (v) => T + (H - T - B) * (1 - (v - tlo) / ((thi - tlo) || 1));
    const line = (arr, fy) => arr.map((v, i) => (v == null ? "" : `${i && arr[i - 1] != null ? "L" : "M"}${X(i).toFixed(1)} ${fy(v).toFixed(1)}`)).join("");
    const bx0 = X(r.from), bx1 = X(Math.min(23, r.to));
    return `<svg class="h-act" viewBox="0 0 ${W} ${H}" role="img" aria-label="시간대별 낚시 활성도">
      ${[0, 50, 100].map((v) => `<line x1="${L}" x2="${W - RR}" y1="${YS(v)}" y2="${YS(v)}" stroke="rgba(255,255,255,.08)"/><text x="${L - 6}" y="${YS(v) + 3}" text-anchor="end" class="ha-ax">${v}</text>`).join("")}
      ${[tlo, (tlo + thi) / 2, thi].map((v) => `<text x="${W - RR + 6}" y="${YT(v) + 3}" class="ha-ax">${Math.round(v)}</text>`).join("")}
      <rect x="${bx0}" y="${T}" width="${Math.max(4, bx1 - bx0)}" height="${H - T - B}" fill="rgba(140,180,255,.14)"/>
      <rect x="${(bx0 + bx1) / 2 - 46}" y="${T - 2}" width="92" height="30" rx="5" fill="#13274a" stroke="rgba(140,180,255,.35)"/>
      <text x="${(bx0 + bx1) / 2}" y="${T + 10}" text-anchor="middle" class="ha-t1">최적 시간</text><text x="${(bx0 + bx1) / 2}" y="${T + 23}" text-anchor="middle" class="ha-t2">${hhmm(r.from)}~${hhmm(r.to)}</text>
      <path d="${line(sc, YS)}" class="ha-score"/><path d="${line(temp, YT)}" class="ha-temp"/>
      ${[0, 6, 12, 18, 23].map((h) => `<text x="${X(h)}" y="${H - 6}" text-anchor="middle" class="ha-ax">${pad2(h === 23 ? 24 : h)}시</text>`).join("")}
    </svg><p class="h-legend"><i class="d1"></i>활성도 <i class="d2"></i>${wsr ? "수온(추정)" : "기온"}(℃)</p>`;
  }
  function renderHome() {
    const host = $("#view-home");
    const p = placeById[state.place], r = state.scores?.[p.id], w = state.weather?.data?.[p.id];
    if (!host.dataset.built) {
      host.dataset.built = "1";
      host.innerHTML = `<div class="home">
        <header class="h-banner"><div class="hb-text"><h1>FISHING INTELLIGENCE</h1><p>데이터로 예측하고, 경험으로 완성하는 스마트 낚시</p></div><div class="hb-chips" id="hChips"></div></header>
        <div class="h-row r1"><section class="hc h-score" id="hScore"></section><section class="hc h-wx" id="hWx"></section><section class="hc h-chart" id="hChart"></section></div>
        <div class="h-row r2"><section class="hc h-map"><header class="hc-h"><h2>${icon("pin")}추천 포인트</h2><div class="h-tabs" id="hTabs"></div><button class="h-link" data-go="map">지도 보기 ${icon("map")}</button></header><div id="homeMap"></div></section>
          <section class="hc h-places"><header class="hc-h"><h2><span class="h-star">★</span>주요 낚시터 상세 정보</h2><small class="h-src" title="사진마다 아래에 출처가 있습니다. 출처를 누르면 원래 글이 열립니다.">사진을 누르면 다음 사진</small></header><div class="h-cards" id="hCards"></div></section></div>
        <div class="h-row r3"><section class="hc h-past" id="hPast"></section><section class="hc h-keys" id="hKeys"></section><section class="hc h-quick" id="hQuick"></section></div>
        <p class="h-note">v2.1.1 시안 화면입니다. 실제 자료로 채웠고, 수심처럼 자료가 없는 항목은 넣지 않았습니다. 카드 사진은 위성 항공 사진(Esri)이며, site/img/places/낚시터이름.jpg 에 사진을 넣으면 그 사진이 대신 나옵니다.</p>
      </div>`;
      if (window.L) {
        homeMap = L.map("homeMap", { zoomControl: true, attributionControl: true, scrollWheelZoom: true, dragging: !L.Browser.mobile }).setView([36.9, 127], 9);
        L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18, attribution: "Imagery &copy; Esri" }).addTo(homeMap);
        homeMarkers = L.layerGroup().addTo(homeMap);
      }
    }
    $("#hChips").innerHTML = `<span>${icon("calendar")}${fmtDate(state.date)}</span><span>${icon("pin")}${esc(p.name)}</span>${w ? `<span>${icon("thermo")}${num(w.temp[new Date().getHours()] ?? r?.temp)}℃</span>` : ""}`;
    if (!r || !w) {
      ["#hScore", "#hWx", "#hChart", "#hCards", "#hPast", "#hKeys"].forEach((s) => { $(s).innerHTML = `<div class="skeleton" style="min-height:160px"></div>`; });
      return;
    }
    const tone = scoreTone(r.score);
    $("#hScore").innerHTML = `<div class="hs-g">${homeGauge(r.score, tone)}<span class="h-pill tone-${tone}">${icon("check")}${VERDICT[tone]}</span></div>
      <div class="hs-t"><h2>오늘의 낚시 전망</h2><b class="hs-head tone-${tone}">${HOME_HEAD[tone]}</b><p>${esc(whyText(r))} 조건입니다. ${esc(READ.wind(r))}, 기압 ${esc(READ.press(r).split(",")[0])}.</p>
        <button class="hs-best" data-go="plan"><span>${icon("clock")}BEST TIME</span><b>${hhmm(r.from)} ~ ${hhmm(r.to)}</b>${icon("chevR")}</button></div>`;
    const water = waterSeries(p), wNow = water ? water.values[Math.min(23, r.from + 1)] : null;
    const wx = [
      ["thermo", water ? "수온" : "기온", water ? `${num(wNow)}<small>℃</small>` : `${num(r.temp)}<small>℃</small>`, water ? (wNow < 4 ? "활성 낮음" : wNow < 8 ? "활성 보통" : wNow <= 16 ? "활성도 양호" : "고수온 주의") : READ.temp(r), "c-red"],
      ["wind", "바람", `${num(r.wind)}<small>m/s</small>`, READ.wind(r).replace("채비 운용 ", "채비 운용 "), "c-cyan"],
      ["gauge", "기압", `${Math.round(r.pressure)}<small>hPa</small>`, READ.press(r).split(",")[0], "c-orange"],
      ["rain", "강수확률", r.prob != null ? `${r.prob}<small>%</small>` : `${num(r.rainSpan)}<small>mm</small>`, (r.prob ?? 0) < 20 ? "낮음" : (r.prob ?? 0) < 50 ? "보통" : "높음", "c-blue"],
    ];
    $("#hWx").innerHTML = `<header class="hc-h"><h2><span class="h-sun">☀</span>오늘의 날씨 요약</h2></header><div class="hw-grid">${wx.map(([ic, k, val, read, c]) => `<div class="hw"><span class="hw-ic ${c}">${icon(ic)}</span><span class="hw-k">${k}</span><b>${val}</b><em>${esc(read)}</em></div>`).join("")}</div>`;
    $("#hChart").innerHTML = `<header class="hc-h"><h2>${icon("trend")}시간대별 낚시 활성도</h2></header>${homeActivity(r, p, w)}`;

    // top three of the same kind of fishing, on the map and as cards
    const list = Object.values(state.scores).filter((x) => placeById[x.id].type === p.type).sort((a, b) => b.score - a.score);
    const top = list.slice(0, 3);
    if (!top.some((x) => x.id === p.id) && state.scores[p.id]) top[2] = state.scores[p.id];
    $("#hTabs").innerHTML = ["", ...top.map((x) => x.id)].map((id) => `<button class="${homeFocus === id ? "on" : ""}" data-home-focus="${esc(id)}">${id || "전체"}</button>`).join("");
    if (homeMap && homeMarkers) {
      homeMarkers.clearLayers();
      const colors = ["#3ddc84", "#ffb547", "#4f9bff"];
      top.forEach((x, i) => {
        const q = placeById[x.id];
        if (!hasPin(q)) return;
        homeMarkers.addLayer(L.marker([q.lat, q.lon], { icon: L.divIcon({ className: "", html: `<div class="hm-pin" style="--c:${colors[i]}"><i>★</i><span><b>${esc(x.id)}</b><em>${x.score}점</em></span></div>`, iconSize: [0, 0] }) }).on("click", () => selectPlace(x.id, false)));
      });
      setTimeout(() => {
        homeMap.invalidateSize();
        const pts = top.map((x) => placeById[x.id]).filter(hasPin).map((q) => [q.lat, q.lon]);
        const f = homeFocus && placeById[homeFocus];
        if (f && hasPin(f)) homeMap.setView([f.lat, f.lon], 14);
        else if (pts.length > 1) homeMap.fitBounds(pts, { padding: [50, 50], maxZoom: 13 });
        else if (pts.length) homeMap.setView(pts[0], 13);
      }, 60);
    }
    const badge = ["#3ddc84", "#ffc94a", "#4f9bff"];
    $("#hCards").innerHTML = top.map((x, i) => {
      const q = placeById[x.id], ws = waterSeries(q);
      return `<article class="h-card"><div class="hcd-img">${hasPin(q) ? aerial(q) : ""}</div>
        <div class="hcd-b"><div class="hcd-t"><b>${i + 1}. ${esc(x.id)}</b><span class="hcd-s" style="--c:${badge[i]}">${x.score}점</span></div>${starRow(x.score)}
        <ul><li>${icon("thermo")}${ws ? `수온 ${num(ws.values[Math.min(23, x.from + 1)])}℃` : `기온 ${num(x.temp)}℃`}</li><li>${icon("wind")}바람 ${num(x.wind)}m/s</li><li>${icon("clock")}추천시간 ${hhmm(x.from)}~${hhmm(x.to)}</li></ul>
        <button class="hcd-more" data-home-open="${esc(x.id)}">상세보기 ${icon("chevR")}</button></div></article>`;
    }).join("");

    // the place's own record: trips around this time of year, catches and when they came
    const seasonal = p.trips.filter((t) => !t.trip.other && seasonGap(t.trip.date, state.date) <= 30);
    const withC = seasonal.filter((t) => t.trip.catch != null);
    const avg = withC.length ? withC.reduce((s2, t) => s2 + t.trip.catch, 0) / withC.length : null;
    const best = withC.length ? Math.max(...withC.map((t) => t.trip.catch)) : null;
    const prof = catchProfile(p);
    const bars = prof ? (() => { const hs = prof.sum.map((v2, h) => [v2, h]).filter(([, h]) => h >= 5 && h <= 20); const mx = Math.max(1, ...hs.map(([v2]) => v2)); return `<div class="hp-bars">${hs.map(([v2, h]) => `<i style="height:${Math.max(4, v2 / mx * 100)}%" title="${h}시 ${v2}수"></i>`).join("")}</div><div class="hp-x"><span>06시</span><span>12시</span><span>18시</span></div>`; })() : `<p class="hp-none">시간대 조과 기록이 없습니다</p>`;
    $("#hPast").innerHTML = `<header class="hc-h"><h2>${icon("chart")}과거 출조 분석 <small>${esc(p.id)}, 이맘때 앞뒤 30일</small></h2></header>
      <div class="hp-grid"><div class="hp"><span class="hp-ic">${icon("fish")}</span><b>${seasonal.length}<small>회</small></b><em>이맘때 출조</em></div>
      <div class="hp"><span class="hp-ic">${icon("fish")}</span><em>평균 조과</em><b>${avg == null ? "–" : Math.round(avg)}<small>마리</small></b></div>
      <div class="hp"><span class="hp-ic gold">${icon("trophy")}</span><em>최고 조과</em><b>${best ?? "–"}<small>마리</small></b></div>
      <div class="hp-chart"><em>시간대별 조과 추이</em>${bars}</div></div>`;
    const keys = [`${hhmm(r.from)}~${hhmm(r.to)}이 최적의 타임`, water ? `수온 ${num(wNow)}℃로 ${water && wNow >= 8 && wNow <= 16 ? "안정적" : "활성 약함"}` : `기온 ${num(r.temp)}℃, ${READ.temp(r)}`, `바람 ${num(r.wind)}m/s로 ${READ.wind(r)}`];
    $("#hKeys").innerHTML = `<header class="hc-h"><h2><span class="h-bulb">💡</span>오늘의 핵심 포인트</h2></header><ul class="hk">${keys.map((k) => `<li>${icon("check")}${esc(k)}</li>`).join("")}</ul>`;
    const guide = guideFor(p);
    $("#hQuick").innerHTML = `<header class="hc-h"><h2>${icon("book")}바로가기</h2></header><div class="hq">
      <button ${guide ? `data-open="${guide.id}"` : 'data-go="plan"'}>${icon("book")}<span>공략법</span></button>
      <button data-go="map">${icon("map")}<span>낚시터 지도</span></button>
      <button data-go="log">${icon("trophy")}<span>조행기</span></button>
      <button data-go="notes">${icon("flask")}<span>연구 노트</span></button></div>`;
  }

  // The fish logo: a short welcome over the dusk picture, then the 홈 screen.
  // 날씨를 늦게 받았으면 떠 있는 환영 화면에 오늘 점수 줄을 채웁니다.
  function fillWelcome() {
    const w = $(".welcome"), p = placeById[state.place], r = state.scores?.[p.id];
    if (!w || !r || w.querySelector(".wl-today")) return;
    w.querySelector("em").insertAdjacentHTML("beforebegin", `<p class="wl-today">${esc(p.id)} · ${VERDICT[scoreTone(r.score)]} ${r.score}점 · 최고 ${hhmm(r.from)}</p>`);
  }
  function showWelcome() {
    if ($(".welcome")) return;
    // the logo also brings the date back to today
    if (state.date !== TODAY) selectDate(TODAY);
    const p = placeById[state.place], r = state.scores?.[p.id];
    const w = document.createElement("div");
    w.className = "welcome";
    w.setAttribute("role", "status");
    w.innerHTML = `<div class="wl-in"><span class="wl-logo">${icon("fish")}</span><h1>FISHING INTELLIGENCE</h1><p>데이터로 예측하고, 경험으로 완성하는 스마트 낚시</p>
      ${r ? `<p class="wl-today">${esc(p.id)} · ${VERDICT[scoreTone(r.score)]} ${r.score}점 · 최고 ${hhmm(r.from)}</p>` : ""}<em>Good Fishing!</em></div>`;
    document.body.append(w);
    const done = () => { if (w.classList.contains("out")) return; w.classList.add("out"); setTimeout(() => w.remove(), REDUCED ? 0 : 500); go("home"); };
    w.addEventListener("click", done);
    setTimeout(done, REDUCED ? 600 : 1800);
  }
  // Map side panel: details of the chosen place, with buttons that change the map.
  function renderMapPanel() {
    const p = placeById[state.place], r = state.scores?.[p.id];
    const tab = state.mapTab;
    const card = (title, text, btn) => `<div class="mp-card"><span class="mp-t">${title}</span><b>${text}</b>${btn || ""}</div>`;
    const btn = (attr, label, on = false) => `<button class="mp-btn ${on ? "on" : ""}" ${attr}>${label}</button>`;
    let body = "";
    if (tab === "ideal") {
      if (!r) body = `<p class="mp-empty">날씨를 불러오면 조건이 나옵니다.</p>`;
      else {
        const curve = curveOf(p.type), ok = curve.filter((x) => x[1] === 1);
        body = card("가장 좋은 시간", `${r.from}~${r.to}시, 점수 ${r.score}점`, btn(`data-hourset="${r.from}" data-hourkey="best"`, state.hourPin === "best" ? "현재 시각으로 돌아가기" : "그 시각 지도 보기", state.hourPin === "best"))
          + card(r.water ? "알맞은 수온" : "알맞은 기온", r.water ? `지금 표층 ${num(r.water.surface)}℃, 송어 활성은 10~16℃` : `${num(r.temp)}℃, ${p.type}낚시 알맞은 범위 ${ok[0][0]}~${ok[ok.length - 1][0]}℃`, btn("data-wind-toggle", state.windOn ? "바람 흐름 숨기기" : "바람 흐름 보기", state.windOn))
          + card("조과 기록", catchSummary(p), btn("data-bubbles", state.bubbles ? "조과 크기 숨기기" : "지도에 조과 크기 보기", state.bubbles))
          + card("기록상 입질 시간", r.prof ? `${r.prof.peak}시대에 가장 많이 잡힘, 조과 ${r.prof.total}수 기록` : "조과 시각 기록이 없습니다", r.prof ? btn(`data-hourset="${r.prof.peak}" data-hourkey="peak"`, state.hourPin === "peak" ? "현재 시각으로 돌아가기" : "그 시각 지도 보기", state.hourPin === "peak") : "")
          + `<div class="mp-rows">${[["바람", READ.wind(r)], ["강수", READ.rain(r)], ["기압", READ.press(r)], ...(p.type === "바다" ? [["물때", tideHint(state.date)]] : []), ...(r.wave != null ? [["파고", READ.wave(r)]] : []), ["위성 지도", state.satellite ? "켜짐" : "꺼짐"]].map(([k, x]) => `<div><span>${k}</span><b>${esc(x)}</b></div>`).join("")}</div>`;
      }
    } else {
      const seasonal = p.trips.filter((t) => seasonGap(t.trip.date, state.date) <= 30);
      body = (seasonal.length ? `<p class="mp-t">${fmtShort(state.date)} 앞뒤 30일의 조행기 ${seasonal.length}건</p><div class="mp-trips">${seasonal.slice(0, 8).map((t, i) => tripCard(t, i)).join("")}</div>` : `<p class="mp-empty">선택한 날짜 앞뒤 30일 안에 이곳에 간 기록이 없습니다.</p>`)
        + catchPanel(p).replace('style="grid-column:span 12"', "");
    }
    $("#mapPanel").innerHTML = `
      <header class="mp-head"><button class="icon-btn" data-panel-toggle aria-label="낚시터 정보 접기" title="왼쪽으로 접기">${icon("chevL")}</button><div><h2>${esc(p.name)}</h2><p>${esc(p.type)}낚시 · ${r ? `${r.score}점` : "점수 없음"} · ${fmtShort(state.date)}</p></div></header>
      <div class="seg"><button data-maptab="season" class="${tab === "season" ? "on" : ""}">이맘때</button><button data-maptab="ideal" class="${tab === "ideal" ? "on" : ""}">좋은 조건</button></div>
      <p class="mp-label">지도에 보일 낚시 종류</p>
      <div class="mp-chips">${["", ...TYPES].map((t) => `<button class="${state.mapType === t ? "on" : ""}" data-maptype="${t}">${t || "전체"}</button>`).join("")}</div>
      ${body}
      <div class="mp-info"><p>${esc(p.address)}</p><p>위치 정확도: ${esc(p.accuracy)}${pinOverrides[p.id] ? ` (${p.lat}, ${p.lon})` : ""}</p>
        <div class="pin-actions"><button class="chip" data-pick="1">${state.picking ? "위치 지정 취소" : "지도에서 위치 지정"}</button>${pinOverrides[p.id] ? '<button class="chip" data-unpin="1">원래 위치로</button>' : ""}${p.id === "덕봉" ? '<a class="chip" href="research/deokbong3d.html" target="_blank" rel="noopener">덕봉 3D 자리 분석</a>' : ""}${p.id === "한터" ? '<a class="chip" href="research/hanteo3d.html" target="_blank" rel="noopener">한터 3D 자리 분석</a>' : ""}${p.id === "장광" ? '<a class="chip" href="research/jangkwang3d.html" target="_blank" rel="noopener">장광 3D 자리 분석</a>' : ""}</div></div>`;
  }

  const docBtn = (pg, i = 0, cls = "", sub = "") => `<button class="doc ${cls}" style="--i:${i}" data-open="${pg.id}"><b>${esc(pg.title)}</b><span>${esc(sub || `${pg.section} · 수정 ${pg.modified}`)}</span></button>`;
  const tripCard = (pg, i = 0, extra = "") => {
    const t = pg.trip;
    const facts = [t.catch != null && `조과 ${t.catch}수`, t.hours && `시간 ${t.hours}`, t.weather && `날씨: ${t.weather}`, t.temp && `기온: ${t.temp}`, t.technique && `기법: ${t.technique}`].filter(Boolean);
    return `<button class="trip" style="--i:${i}" data-open="${pg.id}">
      <span class="when">${fmtDate(t.date)}<span class="badge">${esc(pg.place)}</span>${t.other ? '<span class="badge">다른 사람 기록</span>' : ""}</span>
      <b>${esc(t.note || "조행기")}</b>${facts.length ? `<p>${esc(facts.join(" · "))}</p>` : ""}${extra}</button>`;
  };

  // Catch by hour at one place, summed over the trips whose catch times were recorded.
  function catchPanel(p) {
    // one fishing type only: 지곡 has both trout and crucian carp days, and those counts don't average
    const own = p.trips.filter((t) => !t.trip.other && t.trip.catch != null && t.fishing === p.type);
    if (!own.length) return "";
    const counts = own.map((t) => t.trip.catch);
    const best = own.find((t) => t.trip.catch === Math.max(...counts));
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    const stats = `<div class="catch-stats">
      <div class="stat"><strong>${counts.length}</strong><span>조과가 기록된 출조</span></div>
      <div class="stat"><strong>${Math.round(avg)}<small>수</small></strong><span>평균 조과</span></div>
      <div class="stat"><strong>${best.trip.catch}<small>수</small></strong><span>최고 조과, ${fmtShort(best.trip.date)} ${best.trip.date.slice(0, 4)}</span></div></div>`;
    const timed = own.filter((t) => t.trip.hourly);
    let bars = "";
    if (timed.length) {
      const sum = Array(24).fill(0);
      timed.forEach((t) => t.trip.hourly.forEach((v, h) => { sum[h] += v; }));
      const used = sum.flatMap((v, h) => (v ? [h] : []));
      const from = Math.min(...used), to = Math.max(...used), top = Math.max(...sum);
      const cols = [];
      for (let h = from; h <= to; h++) {
        cols.push(`<div class="hb" title="${h}시대 ${sum[h]}수"><span class="hb-val">${sum[h] === top ? top : ""}</span><span class="hb-track"><span class="hb-fill fill-${p.type}" style="height:${sum[h] / top * 100}%;animation-delay:${(h - from) * 30}ms"></span></span><span class="hb-h">${h}시</span></div>`);
      }
      const total = sum.reduce((a, b) => a + b, 0);
      bars = `<p class="sub">시간대별 조과: 출조 ${timed.length}회에서 시각이 기록된 ${total}수의 합계입니다.</p><div class="hour-bars" role="img" aria-label="시간대별 조과, 최대 ${sum.indexOf(top)}시대 ${top}수">${cols.join("")}</div>`;
    }
    return `<div class="panel" style="grid-column:span 12"><h2>${esc(p.id)} ${p.type} 조과 기록</h2>${stats}${bars}</div>`;
  }

  function renderDossier() {
    const p = placeById[state.place];
    const guides = PAGES.filter((x) => x.guide && x.place === p.id);
    const versioned = guides.filter((g) => g.version).sort((a, b) => b.version.localeCompare(a.version));
    const others = guides.filter((g) => !g.version);
    const mentioned = PAGES.filter((x) => x.mentions?.[p.id] && !x.trip && !x.guide).sort((a, b) => b.mentions[p.id] - a.mentions[p.id]);
    const essentials = PAGES.filter((x) => placeTypes(p).includes(x.fishing) && x.essential != null).sort((a, b) => a.essential - b.essential || a.order - b.order);
    const seasonal = p.trips.filter((t) => seasonGap(t.trip.date, state.date) <= 30);

    let guideHtml = "";
    if (versioned.length) {
      guideHtml += docBtn(versioned[0], 0, "lead", `최신판 · ${versioned[0].version} 수정`);
    }
    guideHtml += others.map((g, i) => docBtn(g, i + 1)).join("");
    guideHtml += mentioned.slice(0, 8).map((g, i) => docBtn(g, i + 2, "", `${p.id} ${g.mentions[p.id]}회 언급 · ${g.section}`)).join("");
    if (versioned.length > 1) {
      guideHtml += `<details class="older"><summary>이전 버전 ${versioned.length - 1}개</summary>${versioned.slice(1).map((g) => docBtn(g, 0, "", `${g.version} 판`)).join("")}</details>`;
    }
    if (!guideHtml) guideHtml = `<p class="notice">이 장소의 공략법 문서는 아직 없습니다. 아래 공통 자료와 조행기를 참고하세요.</p>`;

    const seasonalHtml = seasonal.length
      ? `<div class="trip-grid">${seasonal.map((t, i) => tripCard(t, i)).join("")}</div>`
      : `<p class="notice">선택한 날짜 앞뒤 30일 안에 이곳에 간 기록이 없습니다.${p.trips.length ? " 전체 기록은 아래에 있습니다." : ""}</p>`;
    const restTrips = p.trips.filter((t) => !seasonal.includes(t));

    $("#records").innerHTML = `${catchPanel(p)}<div class="panel" style="grid-column:span 12" id="similarPanel"><h2>비슷한 날씨의 지난 출조</h2><p class="sub">선택한 날의 기온, 바람, 강수와 가까운 순입니다. 과거 값은 재분석 자료입니다.</p><div id="similarBody"><div class="skeleton"></div></div></div>`;
    $("#dossier").innerHTML = `
      <div class="panel"><h2>${esc(p.id)} 공략법</h2><p class="sub">이 장소를 다루는 문서입니다. 언급 횟수가 많은 순으로 보여줍니다.</p>${guideHtml}</div>
      <div class="panel wide"><h2>이맘때의 조행기</h2><p class="sub">${fmtShort(state.date)} 앞뒤 30일 안에 ${esc(p.id)}에 다녀온 기록 ${seasonal.length}건</p>${seasonalHtml}</div>
      <div class="panel"><h2>출조 전에 읽기</h2><p class="sub">${placeTypes(p).join("·")}낚시 공통 자료</p><div>${essentials.slice(0, 10).map((d, i) => docBtn(d, i, "", d.section)).join("") || '<p class="notice">공통 자료가 없습니다.</p>'}</div></div>
      ${restTrips.length ? `<div class="panel wide" style="grid-column:span 12"><h2>${esc(p.id)} 나머지 기록 ${restTrips.length}건</h2><p class="sub">최근 순</p><div class="trip-grid">${restTrips.map((t, i) => tripCard(t, Math.min(i, 12))).join("")}</div></div>` : ""}`;
  }

  async function renderSimilar() {
    const body = $("#similarBody");
    if (!body) return;
    const p = placeById[state.place];
    const w = state.weather?.data[p.id];
    if (!p.trips.length || !w || !hasPin(p)) { body.innerHTML = `<p class="notice">비교할 기록이나 위치 정보가 없습니다.</p>`; return; }
    const token = `${p.id}|${state.date}`;
    try {
      const days = await fetchTripDays(p);
      if (token !== `${state.place}|${state.date}`) return;
      const temps = fin(w.temp);
      const target = { temp: temps.reduce((a, b) => a + b, 0) / temps.length, wind: Math.max(...fin(w.wind)), rain: fin(w.precip).reduce((a, b) => a + b, 0) };
      const scored = p.trips.filter((t) => days[t.trip.date]?.temp != null).map((t) => {
        const d = days[t.trip.date];
        return { t, d, score: Math.abs(d.temp - target.temp) / 5 + Math.abs(d.wind - target.wind) / 3 + Math.abs(d.rain - target.rain) / 5 };
      }).sort((a, b) => a.score - b.score).slice(0, 4);
      if (!scored.length) { body.innerHTML = `<p class="notice">비교할 과거 날씨 값이 아직 없습니다.</p>`; return; }
      body.innerHTML = `<p class="sub">이날 기준: 평균 ${num(target.temp)}°C · 최대 풍속 ${num(target.wind)}m/s · 강수 ${num(target.rain)}mm</p><div class="trip-grid">${scored.map(({ t, d }, i) => tripCard(t, i,
        `<span class="match"><span>평균 ${num(d.temp)}°C</span><span>풍속 ${num(d.wind)}m/s</span><span>강수 ${num(d.rain)}mm</span></span>`)).join("")}</div>`;
    } catch (e) {
      body.innerHTML = `<p class="notice">과거 날씨를 불러오지 못했습니다(${esc(e.message)}).</p>`;
    }
  }

  const cacheW = {};
  let loadToken = 0;
  async function loadAll() {
    const token = ++loadToken;
    const p = placeById[state.place];
    quickDates();
    renderPlaceChips();
    renderDossier();
    updateMapNote();
    state.weather = cacheW[state.date] || null;
    state.marine = null;
    computeScores();
    renderBrief();
    $("#charts").innerHTML = state.weather ? "" : `<div class="skeleton" style="grid-column:span 12;height:180px"></div>`;
    try {
      if (!state.weather) {
        const w = await fetchWeather(state.date);
        // saved values must not outlive the outage
        if (!w.savedAt) cacheW[state.date] = w;
        if (token !== loadToken) return;
        state.weather = w;
      }
      if (p.type === "바다" && hasPin(p)) {
        try { state.marine = await fetchMarine(p, state.date); } catch { state.marine = null; }
        if (token !== loadToken) return;
      }
      state.wxAt = new Date();
      renderWxBtn();
      computeScores();
      renderBrief();
      renderCharts();
      updatePins();
      refreshWindField();
      renderSimilar();
    } catch (e) {
      if (token !== loadToken) return;
      state.scores = {};
      renderWxBtn();
      renderBrief(e.message);
      $("#charts").innerHTML = "";
      const sim = $("#similarBody");
      if (sim) sim.innerHTML = `<p class="notice">날씨를 불러오지 못해 비교할 수 없습니다.</p>`;
    }
    if (hasPin(p)) fetchOutlook(p).then((days) => {
      if (token !== loadToken) return;
      state.outlookAll = days;
      state.outlook = days.filter((d) => d.date >= TODAY).map((d) => ({ date: d.date, r: scorePlace(p, d.w, null, d.date) }));
      renderDays();
      if (waterSeries(p)) { renderBrief(); renderCharts(); }
    }).catch(() => { state.outlook = null; state.outlookAll = null; renderDays(); });
    else { state.outlook = null; state.outlookAll = null; renderDays(); }
  }

  function selectPlace(id, fly = true) {
    state.place = id;
    state.picking = false;
    store.set("place", id);
    const p = placeById[id];
    if (map && fly && hasPin(p) && state.view === "map") map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), PLACE_ZOOM), { duration: REDUCED ? 0 : .9 });
    updatePins();
    loadAll();
  }
  function selectDate(date) {
    if (!date) return;
    state.date = date;
    $("#dToday")?.classList.toggle("on", date === TODAY);
    $("#dateInput").value = date;
    if (date !== TODAY) setHour(7);
    $$(".day").forEach((d) => d.classList.toggle("on", d.dataset.date === date));
    focusStripDay();
    loadAll();
  }

  // Statistics cards for the log, in the spirit of an angler's season summary.
  const PALETTE = ["#6fa8ff", "#3fd6a8", "#f2b33d", "#ef6a5b", "#a38bff", "#4fc6e0", "#ff9e5e", "#9ad05b", "#e46fb0", "#8f9bb3"];
  function logStats(own) {
    const withC = own.filter((t) => t.trip.catch != null);
    const sumOf = (a) => a.reduce((s, t) => s + t.trip.catch, 0);
    const total = sumOf(withC), avg = withC.length ? total / withC.length : 0;
    const hi = withC.filter((t) => t.trip.catch >= 10), lo = withC.filter((t) => t.trip.catch < 10);
    const sorted = [...withC].sort((a, b) => b.trip.catch - a.trip.catch || b.trip.date.localeCompare(a.trip.date));
    const days = new Set(own.map((t) => t.trip.date)).size;
    const caught = withC.filter((t) => t.trip.catch > 0).length, skunk = withC.filter((t) => t.trip.catch === 0).length;
    const pct = withC.length ? caught / withC.length * 100 : 0;
    const byPlace = {};
    own.forEach((t) => { byPlace[t.place] = (byPlace[t.place] || 0) + 1; });
    const places = Object.entries(byPlace).sort((a, b) => b[1] - a[1]);
    const card = (cls, title, sub, ic, body) => `<div class="scard ${cls}"><div class="sc-top"><div><h3>${title}</h3><p>${sub}</p></div><span class="sc-ic">${icon(ic)}</span></div>${body}</div>`;
    const big = (v, c, unit = "") => `<strong class="big ${c}">${v}${unit ? `<small>${unit}</small>` : ""}</strong>`;
    const rows = (list, c) => `<div class="sc-rows">${list.map(([k, v]) => `<div><span>${k}</span><b class="${c}">${v}</b></div>`).join("")}</div>`;
    const best = (t, c, label) => !t ? `<p class="sc-foot">기록이 없습니다.</p>` : `${big(t.trip.catch, c, "수")}<button class="sc-name" data-open="${t.id}">${esc(t.place)}</button>
      <ul class="sc-facts"><li>${icon("pin")}${esc(placeById[t.place]?.name || t.place)}</li><li>${icon("calendar")}${fmtDate(t.trip.date)}</li><li>${icon("trend")}${esc(t.trip.technique || "기법 기록 없음")}</li><li>${icon("target")}${esc(t.trip.weather || t.trip.hours || label)}</li></ul>`;
    // donut of trips by place
    // trips per place as horizontal bars: names stay readable and lengths compare at a glance
    const maxN = places.length ? places[0][1] : 1;
    const barRow = ([id, n]) => { const tp = placeById[id]?.type || ""; return `<li><button data-logplace="${esc(id)}" class="${state.log.place === id ? "on" : ""}"><span class="pb-n">${esc(id)}</span><span class="pb-t"><i class="fill-${tp}" style="width:${n / maxN * 100}%"></i></span><b class="mono">${n}</b><small class="mono">${Math.round(n / own.length * 100)}%</small></button></li>`; };
    const donut = `<div class="pbars-key">${TYPES.map((t) => `<span><i class="fill-${t}"></i>${t}</span>`).join("")}</div>
      <ol class="pbars">${places.slice(0, 10).map(barRow).join("")}</ol>
      ${places.length > 10 ? `<details class="pbars-more"><summary>나머지 ${places.length - 10}곳 보기</summary><ol class="pbars">${places.slice(10).map(barRow).join("")}</ol></details>` : ""}`;
    return `<div class="stats">
      ${card("t-blue", "총 조과", "조과를 적은 출조의 합계", "fish", `${big(total.toLocaleString(), "c-blue", "수")}<p class="sc-foot">${withC.length}회 출조 기록</p>`)}
      ${card("t-violet", "출조당 평균", "한 번 나가서 잡은 수", "chart", `${big(avg.toFixed(1), "c-violet", "수")}<p class="sc-foot">조과 기록이 있는 출조 기준</p>`)}
      ${card("t-mint", "많이 잡은 날과 적게 잡은 날", "10수를 기준으로 나눔", "activity", rows([["10수 이상", `${hi.length}회 · 평균 ${Math.round(hi.reduce((s, t) => s + t.trip.catch, 0) / (hi.length || 1))}수`], ["10수 미만", `${lo.length}회 · 평균 ${(lo.reduce((s, t) => s + t.trip.catch, 0) / (lo.length || 1)).toFixed(1)}수`]], "c-mint"))}
      ${card("t-violet", "낚시 종류별 출조", "내 조행기 기준", "waves", rows(TYPES.map((tp) => [tp, `${own.filter((t) => t.fishing === tp).length}회`]), "c-violet"))}
      ${card("t-yellow", "최고 조과", "하루에 가장 많이 잡은 날", "trophy", best(sorted[0], "c-yellow", "최고 기록"))}
      ${card("t-orange", "2위 조과", "두 번째로 많이 잡은 날", "medal", best(sorted[1], "c-orange", "2위 기록"))}
      ${card("t-plain wide pbar-card", "낚시터별 출조", `${places.length}곳, 많이 간 순서. 누르면 그 낚시터 기록만 봅니다`, "chart", donut)}
      ${card("t-blue", "출조 일수", "물가에 나간 날", "calendar", `${big(days, "c-blue", "일")}<p class="sc-foot">조행기 ${own.length}건</p>`)}
      ${card("t-mint", "조과 있던 날", "한 마리 이상 잡은 날", "check", `${big(caught, "c-mint", "회")}<div class="sc-barrow"><div class="sc-bar"><i style="width:${pct}%"></i></div><span class="mono c-mint">${pct.toFixed(1)}%</span></div>`)}
      ${card("t-red", "꽝 친 날", "한 마리도 못 잡은 날", "xcircle", `${big(skunk, "c-red", "회")}<p class="sc-foot">${skunk ? "다음엔 시간대를 바꿔 보세요" : "아직 없습니다"}</p>`)}
      ${card("t-violet", "하루 최다", "개인 최고 기록", "trophy", `${big(sorted[0] ? sorted[0].trip.catch : 0, "c-violet", "수")}<p class="sc-foot">${sorted[0] ? `${esc(sorted[0].place)}, ${fmtShort(sorted[0].trip.date)} ${sorted[0].trip.date.slice(0, 4)}` : "기록 없음"}</p>`)}
    </div>`;
  }

  /* ---------- log view ---------- */
  function renderLog() {
    const { type, place, month } = state.log;
    const base = allTrips.filter((t) => (!type || t.fishing === type) && (!state.log.year || t.trip.date.startsWith(state.log.year)));
    const list = base.filter((t) => (!place || t.place === place) && (!month || t.trip.date.startsWith(month)));
    const years = [...new Set(allTrips.map((t) => t.trip.date.slice(0, 4)))].sort();
    const counts = {};
    base.filter((t) => !place || t.place === place).forEach((t) => { const k = t.trip.date.slice(0, 7); counts[k] = (counts[k] || 0) + 1; });
    const maxC = Math.max(1, ...Object.values(counts));
    const level = (n) => (n === 0 ? 0 : Math.max(1, Math.ceil(n / maxC * 4)));
    const months = Array.from({ length: 12 }, (_, i) => pad(i + 1));
    const heat = `<div class="heat"><span></span>${months.map((m) => `<span class="h">${+m}<i>월</i></span>`).join("")}` + years.map((y, yi) => `<span class="y">${y}</span>` + months.map((m, mi) => {
      const k = `${y}-${m}`, n = counts[k] || 0, lv = level(n);
      return `<button class="cell ${month === k ? "on" : ""}" ${n ? "" : "disabled"} data-month="${k}" title="${y}년 ${+m}월 ${n}회" aria-label="${y}년 ${+m}월 ${n}회" style="--i:${yi * 12 + mi};background:var(--heat-${lv});color:${lv >= 3 ? "var(--surface)" : "var(--ink)"}">${n || ""}</button>`;
    }).join("")).join("") + `</div>`;

    const byPlace = PLACES.map((p) => ({ p, n: p.trips.filter((t) => !t.trip.other && (!type || t.fishing === type)).length })).filter((x) => x.n).sort((a, b) => b.n - a.n);
    const maxP = Math.max(1, ...byPlace.map((x) => x.n));
    const bars = `<div class="bars" style="--rows:${Math.ceil(byPlace.length / 2)}">${byPlace.map(({ p, n }, i) => `<button class="bar-row ${place === p.id ? "on" : ""}" data-logplace="${esc(p.id)}"><span>${esc(p.id)}</span><span class="bar-track"><span class="bar-fill fill-${type || p.type}" style="width:${n / maxP * 100}%;animation-delay:${i * 40}ms"></span></span><span>${n}</span></button>`).join("")}</div>`;

    const monthly = months.map((m) => TYPES.map((tp) => allTrips.filter((t) => t.fishing === tp && t.trip.date.slice(5, 7) === m && (!type || tp === type)).length));
    const maxM = Math.max(1, ...monthly.map((r) => r.reduce((a, b) => a + b, 0)));
    const W = 560, H = 190, L0 = 26, B0 = 22, bw = (W - L0) / 12 - 6;
    const bar = monthly.map((row, i) => {
      let y = H - B0;
      const x = L0 + i * ((W - L0) / 12) + 3;
      const segs = row.map((v, ti) => {
        if (!v) return "";
        const h = v / maxM * (H - B0 - 12);
        y -= h;
        return `<rect class="bar-in" style="animation-delay:${i * 30}ms" x="${x}" y="${y + 1}" width="${bw}" height="${Math.max(0, h - 2)}" rx="2" fill="var(--s${ti + 1})"><title>${+months[i]}월 ${TYPES[ti]} ${v}회</title></rect>`;
      }).join("");
      const total = row.reduce((a, b) => a + b, 0);
      return segs + (total ? `<text x="${x + bw / 2}" y="${y - 3}" text-anchor="middle" font-size="11" fill="var(--ink-2)">${total}</text>` : "") + `<text x="${x + bw / 2}" y="${H - 7}" text-anchor="middle" font-size="11" fill="var(--muted)">${+months[i]}월</text>`;
    }).join("");
    const season = `<div class="month-legend">${TYPES.map((t) => `<span><i class="dot ${t}"></i> ${t}</span>`).join("")}</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="월별 출조 횟수"><line x1="${L0}" x2="${W}" y1="${H - B0}" y2="${H - B0}" stroke="var(--axis)"/>${bar}</svg>
      <details class="table-view"><summary>표로 보기</summary><table class="num-table"><tr><th>월</th>${TYPES.map((t) => `<th>${t}</th>`).join("")}</tr>${monthly.map((r, i) => `<tr><td>${i + 1}월</td>${r.map((v) => `<td>${v}</td>`).join("")}</tr>`).join("")}</table></details>`;

    const groups = {};
    list.forEach((t) => { (groups[t.trip.date.slice(0, 4)] ||= []).push(t); });
    const river = Object.keys(groups).sort().reverse().map((y) => `<div class="river-year">${y}년 <small style="font-weight:500;font-size:13px;color:var(--ink-2)">${groups[y].length}건</small></div><div class="trip-grid">${groups[y].map((t, i) => tripCard(t, Math.min(i, 10))).join("")}</div>`).join("");

    // the headline numbers describe the same trips as the list below, so every filter moves them too
    const own = list.filter((t) => !t.trip.other);
    const tally = {};
    own.forEach((t) => { tally[t.place] = (tally[t.place] || 0) + 1; });
    const topId = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
    const filters = [state.log.place && `${state.log.place}`, state.log.month && state.log.month.replace("-", "년 ") + "월"].filter(Boolean);

    $("#view-log").innerHTML = `
      <div class="page-head"><div><h1>기록</h1><p>${state.log.year ? `${state.log.year}년` : "전체 기간"}${type ? ` ${type}낚시` : ""} 낚시 통계</p></div>
        <label class="ph-tool">연도 <select id="logYear"><option value="">전체</option>${years.slice().reverse().map((y) => `<option value="${y}" ${state.log.year === y ? "selected" : ""}>${y}</option>`).join("")}</select></label></div>
      ${logStats(own)}
      <div class="filter-row">
        <button class="chip ${!type ? "on" : ""}" data-logtype="">전체</button>
        ${TYPES.map((t) => `<button class="chip ${type === t ? "on" : ""}" data-logtype="${t}"><i class="dot ${t}"></i> ${t}</button>`).join("")}
        ${filters.length ? `<button class="chip" data-logclear="1">${esc(filters.join(" · "))} 해제 ✕</button>` : ""}
      </div>
      <div class="log-grid">
        <div class="panel" style="grid-column:span 12"><h2>언제 나갔나</h2><p class="sub">달을 누르면 그 달의 기록만 봅니다.</p>${heat}</div>
        <div class="panel" style="grid-column:span 6"><h2>계절의 패턴</h2><p class="sub">전체 연도를 합친 월별 출조 횟수입니다.</p>${season}</div>
        <div class="panel" style="grid-column:span 6"><h2>어디로 나갔나</h2><p class="sub">장소를 누르면 기록을 추립니다. 다른 사람의 기록은 뺐습니다.</p>${bars}</div>
      </div>
      <div class="panel" style="grid-column:span 12"><h2>기록 ${list.length}건</h2><div class="river">${river || '<p class="notice">조건에 맞는 기록이 없습니다.</p>'}</div></div>`;
    $$(".stat [data-to]", $("#view-log")).forEach(countUp);
  }

  /* ---------- library ---------- */
  function renderLibrary() {
    // nothing selected means every source
    const pool = state.sources.length ? PAGES.filter((p) => state.sources.includes(p.source)) : PAGES;
    const sections = [...new Set(pool.map((p) => p.section))];
    if (!sections.includes(state.shelf)) state.shelf = sections[0];
    const color = { 민물: "var(--s1)", 송어: "var(--s2)", 바다: "var(--s3)" };
    const shelves = sections.map((s, i) => {
      const pp = pool.filter((p) => p.section === s);
      const label = s.replace(/^[\d.\-\s]+/, "").replace("취미생활(바다낚시)", "바다낚시");
      const latest = pp.map((p) => p.modified).sort().pop();
      return `<button class="shelf ${state.shelf === s ? "on" : ""}" data-shelf="${esc(s)}" style="--n:${pp.length};--i:${i};--c:${color[pp[0].fishing]}"><small>${pp[0].fishing}</small><b>${esc(label)}</b><strong>${pp.length}</strong> <small style="display:inline">페이지</small><small>최근 수정 ${esc(latest)}</small></button>`;
    }).join("");
    const sources = (window.FISH.sources || []).map((s, i) => `<button class="source-card ${state.sources.includes(s.name) ? "on" : ""}" style="--i:${i}" data-source="${esc(s.name)}" aria-pressed="${state.sources.includes(s.name)}"><b>${esc(s.name)}</b><span>대시보드 반영: ${esc(s.reflected)}</span><span>원본 최종 수정: ${esc(s.latest)} · ${esc(s.detail)}</span></button>`).join("");
    const tree = pool.filter((p) => p.section === state.shelf).sort((a, b) => a.order - b.order).map((p, i) =>
      `<button class="doc" style="--lv:${p.level};--wt:${p.level === 1 ? 700 : 500};--i:${Math.min(i, 14)}" data-open="${p.id}"><b>${esc(p.title)}</b><span>수정 ${p.modified}${p.images ? ` · 이미지 ${p.images}장` : ""}</span></button>`).join("");
    $("#view-library").innerHTML = `<div class="hero-line"><h1>자료 탐색</h1>
        <div class="stat"><strong>${pool.length}</strong><span>페이지</span></div>
        <div class="stat"><strong>${pool.reduce((a, p) => a + p.images, 0).toLocaleString()}</strong><span>이미지</span></div>
        <div class="stat"><strong>${(pool.reduce((a, p) => a + p.chars, 0) / 10000).toFixed(pool.length < 50 ? 1 : 0)}만</strong><span>글자</span></div></div>
      <p class="source-hint">자료를 눌러 그 내용만 볼 수 있습니다.<br>여러 개를 함께 고를 수도 있습니다.${state.sources.length ? ' <button class="chip" data-source-all="1">전체 보기</button>' : ""}</p>
      <div class="sources" aria-label="자료 출처와 반영일">${sources}</div>
      <div class="shelves">${shelves}</div><div class="tree">${tree}</div>`;
  }

  /* ---------- study notes (only on this PC, see site/private/notes.js) ---------- */
  // Season days count from Nov 1 and ignore the year, so measurements from different years share one axis.
  const SEASON_DAYS = [30, 31, 31, 28, 31, 30, 31];
  function seasonDay(iso) {
    const d = parseISO(iso), i = (d.getMonth() - 10 + 12) % 12;
    if (i >= SEASON_DAYS.length) return null;
    return SEASON_DAYS.slice(0, i).reduce((s, n) => s + n, 0) + Math.min(d.getDate(), SEASON_DAYS[i]) - 1;
  }
  function seasonLabel(day) {
    let left = day;
    for (let i = 0; i < SEASON_DAYS.length; i++) {
      if (left < SEASON_DAYS[i]) return `${(i + 10) % 12 + 1}월 ${left + 1}일`;
      left -= SEASON_DAYS[i];
    }
    return "";
  }

  // Least squares for y = a x^2 + b x + c, solved on the normal equations.
  function quadFit(xs, ys) {
    const pow = (k) => xs.reduce((s, x) => s + x ** k, 0);
    const m = [
      [pow(4), pow(3), pow(2), xs.reduce((s, x, i) => s + x * x * ys[i], 0)],
      [pow(3), pow(2), pow(1), xs.reduce((s, x, i) => s + x * ys[i], 0)],
      [pow(2), pow(1), xs.length, ys.reduce((s, y) => s + y, 0)],
    ];
    for (let i = 0; i < 3; i++) {
      let p = i;
      for (let r = i + 1; r < 3; r++) if (Math.abs(m[r][i]) > Math.abs(m[p][i])) p = r;
      [m[i], m[p]] = [m[p], m[i]];
      if (Math.abs(m[i][i]) < 1e-9) return null;
      for (let r = 0; r < 3; r++) {
        if (r === i) continue;
        const f = m[r][i] / m[i][i];
        for (let c = i; c < 4; c++) m[r][c] -= f * m[i][c];
      }
    }
    const [A, B, C] = [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
    const at = (x) => A * x * x + B * x + C;
    const mean = ys.reduce((s, y) => s + y, 0) / ys.length;
    const tot = ys.reduce((s, y) => s + (y - mean) ** 2, 0);
    const res = ys.reduce((s, y, i) => s + (y - at(xs[i])) ** 2, 0);
    return { a: A, b: B, c: C, r2: tot ? 1 - res / tot : 0, at };
  }

  function tempFit(rows) {
    const xs = rows.map((r) => seasonDay(r.date));
    const surface = quadFit(xs, rows.map((r) => r.surface));
    const bottom = quadFit(xs, rows.map((r) => r.bottom));
    return surface && bottom ? { surface, bottom, n: rows.length, min: Math.min(...xs), max: Math.max(...xs) } : null;
  }

  // Water temperature for the briefing: the place's own curve when it has one, otherwise the pooled curve.
  // Measurements live in the private notes, so this stays empty on the public site.
  function waterEstimate(p, iso) {
    const all = window.FISH_NOTES?.temperatures;
    if (!all || !placeTypes(p).includes("송어")) return null;
    const day = seasonDay(iso);
    if (day === null) return null;
    const own = all.filter((r) => r.place === p.id);
    const hasOwn = new Set(own.map((r) => r.date)).size >= 4;
    const fit = tempFit(hasOwn ? own : all);
    if (!fit) return null;
    return { surface: fit.surface.at(day), bottom: fit.bottom.at(day), own: hasOwn, outside: day < fit.min || day > fit.max };
  }

  function fitFormula(f) {
    const term = (v, digits, tail) => `${v < 0 ? "−" : "+"} ${Math.abs(v).toFixed(digits)}${tail}`;
    return `T = ${f.a < 0 ? "−" : ""}${Math.abs(f.a).toFixed(5)}d² ${term(f.b, 3, "d")} ${term(f.c, 2, "")}`;
  }

  // Today, tomorrow and the coming weekend; on a Sunday, Saturday means the next one.
  function fitQuickDates() {
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const after = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
    const dow = new Date().getDay();
    return [
      ["오늘", after(0)],
      ["내일", after(1)],
      ["이번토요일", after((6 - dow + 7) % 7)],
      ["일요일", after((7 - dow) % 7)],
    ].map(([label, d]) => ({ label, iso: iso(d), short: `${d.getMonth() + 1}/${d.getDate()}` }));
  }

  function fitResult(fit, iso) {
    const day = iso ? seasonDay(iso) : null;
    if (day === null) return `<p class="fit-warn">날짜를 11월 1일부터 5월 31일 사이로 넣어 주세요. 그 밖의 기간은 측정값이 없어 계산하지 않습니다.</p>`;
    const outside = day < fit.min || day > fit.max;
    return `<div class="fit-values"><span>표층 <b>${num(fit.surface.at(day))}℃</b></span><span>바닥 <b>${num(fit.bottom.at(day))}℃</b></span></div>
      ${outside ? `<p class="fit-warn">측정 기간(${seasonLabel(fit.min)}~${seasonLabel(fit.max)}) 밖이라 곡선을 연장한 값입니다. 믿을 만하지 않습니다.</p>` : ""}`;
  }

  function tempChart(rows, trips, colorOf, fit, fitColor) {
    // Places the season from November to May on one axis, whichever year the point came from.
    const W = 900, H = 300, L0 = 38, R0 = 12, T0 = 14, B0 = 46;
    const start = [10, 1], months = ["11월", "12월", "1월", "2월", "3월", "4월", "5월"];
    const pos = (iso) => {
      const d = parseISO(iso);
      const i = (d.getMonth() - start[0] + 12) % 12;
      return i + (d.getDate() - 1) / 31;
    };
    const X = (v) => L0 + (W - L0 - R0) * (v / 7);
    const Y = (v) => T0 + (H - T0 - B0) * (1 - v / 25);
    const grid = [0, 5, 10, 15, 20, 25].map((v) => `<line x1="${L0}" x2="${W - R0}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v ? "var(--grid)" : "var(--axis)"}"/><text x="${L0 - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="12" fill="var(--muted)">${v}</text>`).join("");
    const axis = months.map((m, i) => `<text x="${X(i + .5)}" y="${H - 28}" text-anchor="middle" font-size="12" fill="var(--muted)">${m}</text>`).join("");
    const label = (r) => `${r.place} · ${r.date} ${r.time} · 표층 ${num(r.surface)}℃ · 바닥 ${num(r.bottom)}℃${r.note ? ` · ${r.note}` : ""}`;
    const dots = rows.map((r, i) => {
      const x = X(pos(r.date)) + (i % 3) * 1.5, tip = esc(label(r));
      return `<g class="temp-point" data-tip="${tip}" tabindex="0"><circle cx="${x}" cy="${Y(r.surface)}" r="5.5" fill="${colorOf(r.place)}" stroke="var(--surface)" stroke-width="2"/><rect x="${x - 5}" y="${Y(r.bottom) - 5}" width="10" height="10" rx="2" fill="${colorOf(r.place)}" stroke="var(--surface)" stroke-width="2"/></g>`;
    }).join("");
    const marks = trips.filter((t) => pos(t.trip.date) < 7).map((t) => {
      const x = X(pos(t.trip.date));
      const tip = esc(`내 출조 · ${t.place} · ${t.trip.date}${t.trip.catch != null ? ` · 조과 ${t.trip.catch}수` : ""}`);
      return `<g class="temp-point" data-tip="${tip}" tabindex="0"><path d="M${x} ${H - 18}l6 10h-12z" fill="${colorOf(t.place)}"/></g>`;
    }).join("");
    let curves = "";
    if (fit) {
      const line = (f, dash) => {
        const pts = [];
        for (let d = fit.min; d <= fit.max; d += 2) {
          let left = d, i = 0;
          while (left >= SEASON_DAYS[i]) left -= SEASON_DAYS[i++];
          pts.push(`${X(i + left / SEASON_DAYS[i]).toFixed(1)} ${Y(Math.max(0, Math.min(25, f.at(d)))).toFixed(1)}`);
        }
        return `<path d="M${pts.join("L")}" fill="none" stroke="${fitColor}" stroke-width="2" ${dash ? 'stroke-dasharray="6 5"' : ""} opacity=".75"/>`;
      };
      curves = line(fit.surface, false) + line(fit.bottom, true);
    }
    return `<svg viewBox="0 0 ${W} ${H}" class="temp-chart" role="img" aria-label="계절별 수온 실측값">${grid}${axis}${curves}${dots}${marks}</svg>`;
  }

  // 베타는 테마 버튼을 빠르게 12번 눌러 켭니다. PC 전용 파일은 이 PC에서 열 때만 불러옵니다.
  const CAN_LOAD_PRIVATE = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
  let IS_BETA = false;
  try { IS_BETA = localStorage.getItem("fishBeta") === "2"; } catch (e) { /* 저장을 못 읽으면 공개판 */ }

  function notesTabs() {
    const tabs = [["study", "수집 자료"], ["model", "덕봉 3D"], ["hanteo", "한터 3D"], ["jangkwang", "장광 3D"], ["summary", "3D 정리·문헌"], ["video", "영상 가이드"], ...(IS_BETA ? [["book", "북가이드"], ["versions", "버전 기록"]] : [])];
    if (tabs.length < 2) return "";
    return `<div class="notes-tabs" role="tablist">${tabs.map(([id, label]) => `<button role="tab" aria-selected="${state.notes.tab === id}" class="${state.notes.tab === id ? "on" : ""}" data-notes-tab="${id}">${label}</button>`).join("")}</div>`;
  }

  // Mouse wheel zooms around the pointer (1x to 8x); when zoomed in, dragging moves the picture.
  function zoomable(img) {
    if (img.dataset.zoomable) return img;
    img.dataset.zoomable = "1";
    let s = 1, x = 0, y = 0, drag = null;
    const apply = () => { img.style.transform = `translate(${x}px, ${y}px) scale(${s})`; img.style.cursor = s > 1 ? (drag ? "grabbing" : "grab") : ""; };
    img.resetZoom = () => { s = 1; x = 0; y = 0; apply(); };
    img.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = img.getBoundingClientRect();
      const ns = Math.min(8, Math.max(1, s * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      const qx = (e.clientX - (r.left + r.width / 2)) / s, qy = (e.clientY - (r.top + r.height / 2)) / s;
      x += (s - ns) * qx; y += (s - ns) * qy; s = ns;
      if (s === 1) { x = 0; y = 0; }
      apply();
    }, { passive: false });
    img.addEventListener("pointerdown", (e) => {
      if (s === 1) return;
      e.preventDefault();
      drag = { px: e.clientX, py: e.clientY, x, y, moved: false };
      img.setPointerCapture(e.pointerId);
      apply();
    });
    img.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      x = drag.x + dx; y = drag.y + dy; apply();
    });
    const end = () => { if (drag?.moved) img.dataset.dragged = Date.now(); drag = null; apply(); };
    img.addEventListener("pointerup", end);
    img.addEventListener("pointercancel", end);
    return img;
  }
  const justDragged = (img) => img && Date.now() - (+img.dataset.dragged || 0) < 350;
  function showFigure(src, page) {
    let box = $("#figDialog");
    if (!box) {
      box = document.createElement("dialog");
      box.id = "figDialog";
      box.className = "fig-dialog";
      box.addEventListener("click", (e) => { if (!e.target.closest("a") && !justDragged($("img", box))) box.close(); });
      document.body.append(box);
    }
    const pdf = window.FISH_BOOK_GUIDE.pdf;
    box.innerHTML = `<div class="zoom-frame"><img src="${esc(src)}" alt="원본 ${esc(page)}쪽 그림"></div><p><a href="${esc(pdf)}#page=${esc(page)}" target="_blank" rel="noopener noreferrer">원본 ${esc(page)}쪽 열기</a> · 마우스 휠로 확대·축소, 확대한 뒤 끌어서 이동 · 그림을 누르면 닫힙니다</p>`;
    zoomable($("img", box));
    box.showModal();
  }

  const YOUTUBE_ICON = '<svg class="yt-icon" viewBox="0 0 28 20" aria-hidden="true"><rect width="28" height="20" rx="5" fill="#f00"/><path d="M11 5.5v9l8-4.5z" fill="#fff"/></svg>';

  const notesTag = () => (IS_BETA ? "비공개 자료 포함" : "공개 자료");

  function notesFrame(body) {
    $("#view-notes").innerHTML = `
      <div class="hero-line"><h1>연구 노트</h1><div class="stat"><span class="private-tag">${notesTag()}</span></div></div>
      ${notesTabs()}
      <div class="panel">${body}</div>`;
  }

  const MODELS = {
    deokbong: { src: "research/deokbong3d.html", title: "덕봉저수지 3D 모델", sub: "저수지 구조를 돌려 보며 날씨와 시각에 따른 추천 자리와 송어 예상 분포를 봅니다." },
    hanteo: { src: "research/hanteo3d.html", title: "한터 송어낚시터 3D 모델", sub: "한터 송어터(서쪽·동쪽·남쪽 부교 아래 그물 안)를 돌려 보며 날씨와 시각에 따른 추천 자리와 송어 예상 분포를 봅니다. 바닥 높낮이는 최고 6m로 추정한 값이고, 계산 방법은 덕봉 3D와 같습니다." },
    jangkwang: { src: "research/jangkwang3d.html", title: "장광 송어낚시터 3D 모델", sub: "장광 송어터(북쪽·동쪽 부교 아래 그물 안)를 돌려 보며 날씨와 시각에 따른 추천 자리와 송어 예상 분포를 봅니다. 바닥 높낮이는 최고 3.5m, 남쪽 물가 7m까지 약 1m, 계곡 유입구에서 하류로 이어지는 물골로 추정한 값이고, 계산 방법은 덕봉 3D와 같습니다." },
  };
  function renderModel(key = "deokbong") {
    const m = MODELS[key];
    $("#view-notes").innerHTML = `
      <div class="hero-line"><h1>연구 노트</h1><div class="stat"><span class="private-tag">${notesTag()}</span></div></div>
      ${notesTabs()}
      <div class="panel"><p class="sub">${m.sub} 값은 모두 가설입니다. <a href="${m.src}" target="_blank">새 창으로 크게 보기</a></p>
        <iframe class="model-frame" src="${m.src}" title="${m.title}"></iframe>
      </div>`;
  }

  function renderChapterGuide(g) {
    const c = g.chapters[state.notes.chapters[state.notes.tab] || 0] || g.chapters[0];
    const chip = (x) => `<button class="chip ${x === c ? "on" : ""}" data-guide-chapter="${g.chapters.indexOf(x)}"${x.icon ? ` aria-label="${esc(x.short)}" title="${esc(x.short)}"` : ""}>${x.icon === "youtube" ? YOUTUBE_ICON : esc(x.short || x.title.split(".")[0])}</button>`;
    const groups = [...new Set(g.chapters.map((x) => x.group))];
    $("#view-notes").innerHTML = `
      <div class="hero-line"><h1>연구 노트</h1><div class="stat"><span class="private-tag">${notesTag()}</span></div></div>
      ${notesTabs()}
      <div class="panel"><h2>${esc(g.title)}</h2><p class="sub">${esc(g.sub)}</p>
        ${groups.map((name) => `<div class="filter-row guide-chapters">${name ? `<span class="guide-group">${esc(name)}</span>` : ""}${g.chapters.filter((x) => x.group === name).map(chip).join("")}</div>`).join("")}
        <article class="guide-body"><h2>${esc(c.title)}</h2>${c.html}</article>
      </div>`;
  }

  // 수온 실측의 펼침 상태는 다시 그려도 유지합니다.
  document.addEventListener("toggle", (e) => { if (e.target.id === "tempFold") state.notes.tempOpen = e.target.open; }, true);

  function renderNotes() {
    if (!IS_BETA && ["book", "versions"].includes(state.notes.tab)) state.notes.tab = "summary";
    if (state.notes.tab === "versions") { notesFrame(`<h2 class="ver-title">버전 기록 <button class="ver-public" data-to-public>공개전환</button></h2><p class="sub">현재 v${esc(window.FISH_VERSIONS[0].version)} 베타 · 자료 빌드 ${esc(window.FISH.built)}</p>${versionListHtml()}`); return; }
    const missing = { book: !window.FISH_BOOK_GUIDE }[state.notes.tab];
    if (missing) { notesFrame('<h2>이 PC에서만 열리는 자료입니다</h2><p class="sub">이 자료는 공개 사이트에 올리지 않았습니다. 자료가 있는 PC에서 열어 주세요.</p>'); return; }
    if (window.FISH_VIDEO_GUIDE && state.notes.tab === "video") { renderChapterGuide(window.FISH_VIDEO_GUIDE); return; }
    if (window.FISH_BOOK_GUIDE && state.notes.tab === "book") { renderChapterGuide(window.FISH_BOOK_GUIDE); return; }
    if (state.notes.tab === "model") { renderModel(); return; }
    if (state.notes.tab === "hanteo") { renderModel("hanteo"); return; }
    if (state.notes.tab === "jangkwang") { renderModel("jangkwang"); return; }
    if (state.notes.tab === "summary") {
      const d = window.FISH_DEOKBONG_GUIDE, r = window.FISH_RESEARCH_GUIDE;
      renderChapterGuide({ title: "3D 정리와 문헌", sub: `${d.sub} ${r.sub}`, chapters: [...d.chapters, ...r.chapters] });
      return;
    }
    // 공개판은 공개 자료만, 이 PC의 베타는 비공개 자료까지 합쳐 보여 줍니다.
    const n = { ...window.FISH_COLLECTED_DATA, ...(window.FISH_NOTES || {}) };
    const places = [...new Set(n.temperatures.map((r) => r.place))];
    const placeColors = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"];
    const colorOf = (p) => placeColors[places.indexOf(p) % placeColors.length];
    const rows = [...n.temperatures].sort((a, b) => places.indexOf(a.place) - places.indexOf(b.place) || (a.date + a.time).localeCompare(b.date + b.time));
    // A curve needs enough separate days; a place with only a few measurements gets none of its own.
    const fitPlaces = places.filter((p) => new Set(n.temperatures.filter((r) => r.place === p).map((r) => r.date)).size >= 4);
    const fitTargets = [...fitPlaces, "전체"];
    if (!fitTargets.includes(state.notes.fitTarget)) state.notes.fitTarget = fitTargets[0];
    const fitRows = state.notes.fitTarget === "전체" ? n.temperatures : n.temperatures.filter((r) => r.place === state.notes.fitTarget);
    const fit = tempFit(fitRows);
    const fitColor = state.notes.fitTarget === "전체" ? "var(--ink-2)" : colorOf(state.notes.fitTarget);
    const quickDates = fitQuickDates();
    if (!state.notes.fitDate) state.notes.fitDate = quickDates[0].iso;
    state.notes.fitNow = fit;
    const trips = places.flatMap((p) => (placeById[p] ? placeById[p].trips.filter((t) => !t.trip.other).map((t) => ({ ...t, place: p })) : []));
    const done = store.get("notesChecklist", []);
    const month = n.jangwangMonths ? n.jangwangMonths.find((m) => m.month === state.notes.month) || n.jangwangMonths[0] : null;
    const measured = month ? n.temperatures.filter((r) => r.place === "장광" && parseISO(r.date).getMonth() + 1 === month.month) : [];
    const allT = measured.flatMap((r) => [r.surface, r.bottom]);
    const jangwangTrips = month ? placeById["장광"].trips.filter((t) => parseISO(t.trip.date).getMonth() + 1 === month.month) : [];

    $("#view-notes").innerHTML = `
      <div class="hero-line"><h1>연구 노트</h1><div class="stat"><span class="private-tag">${notesTag()}</span></div></div>
      ${notesTabs()}
      <div class="notes-grid">
        <details class="panel notes-wide temp-fold" id="tempFold" ${state.notes.tempOpen ? "open" : ""}><summary><h2>수온 실측</h2></summary><p class="sub">수집한 실측값입니다. 측정 연도가 달라 계절 흐름만 참고하세요.</p>
          <div class="month-legend">${places.map((p) => `<span><i class="dot" style="background:${colorOf(p)}"></i> ${esc(p)}</span>`).join("")}</div>
          <div class="month-legend"><span>● 표층</span><span>■ 바닥</span>${trips.length ? "<span>▲ 내 출조</span>" : ""}${fit ? "<span>━ 표층 곡선</span><span>╍ 바닥 곡선</span>" : ""}</div>
          ${tempChart(rows, trips, colorOf, fit, fitColor)}
          <p class="temp-readout" id="tempReadout">점에 포인터를 올리거나 눌러 값을 확인하세요.</p>
          ${fit ? `<div class="fit-box">
            <h3 class="notes-sub">2차 곡선과 예상 수온</h3>
            <div class="filter-row">${fitTargets.map((t) => `<button class="chip ${t === state.notes.fitTarget ? "on" : ""}" data-fit-target="${esc(t)}">${esc(t)}</button>`).join("")}</div>
            <div class="fit-grid">
              <div>
                <p class="fit-formula"><b>표층</b> ${fitFormula(fit.surface)}<span>R² = ${fit.surface.r2.toFixed(3)}</span></p>
                <p class="fit-formula"><b>바닥</b> ${fitFormula(fit.bottom)}<span>R² = ${fit.bottom.r2.toFixed(3)}</span></p>
                <p class="sub">d는 11월 1일부터 지난 일수(11월 1일 = 0)입니다. 측정값 ${fit.n}개, 기간 ${seasonLabel(fit.min)}~${seasonLabel(fit.max)}.</p>
              </div>
              <div>
                <div class="fit-date-row"><label class="fit-date">날짜 <input type="date" id="fitDate" value="${esc(state.notes.fitDate)}"></label>
                <div class="fit-quick">${quickDates.map((q) => `<button class="chip ${q.iso === state.notes.fitDate ? "on" : ""}" data-fit-quick="${q.iso}">${q.label}<small>${q.short}</small></button>`).join("")}</div></div>
                <div id="fitResult">${fitResult(fit, state.notes.fitDate)}</div>
              </div>
            </div>
            <p class="sub">연도와 측정 시각을 구분하지 않고 맞춘 곡선입니다. R²는 이미 잰 값에 얼마나 맞는지를 나타낼 뿐, 예측 정확도를 보장하지 않습니다.</p>
          </div>` : ""}
          <details class="table-view"><summary>표로 보기</summary><table class="num-table"><tr><th>장소</th><th>날짜</th><th>시각</th><th>표층</th><th>바닥</th><th>상황</th></tr>${rows.map((r) => `<tr><td class="left">${esc(r.place)}</td><td>${r.date}</td><td>${r.time}</td><td>${num(r.surface)}℃</td><td>${num(r.bottom)}℃</td><td class="left">${esc(r.note || "")}</td></tr>`).join("")}</table></details>
          <ul class="notes-list">${n.temperatureFindings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
        </details>

        <div class="panel"><h2>안 물릴 때 체크리스트</h2><p class="sub">한 번에 하나씩 위에서부터 바꿔 봅니다.</p>
          <div class="check-list">${n.checklist.map((c, i) => `<label class="check-item"><input type="checkbox" data-check="${i}" ${done.includes(i) ? "checked" : ""}><span><b>${i + 1}. ${esc(c.title)}</b>${esc(c.body)}<small>${esc(c.source)}</small></span></label>`).join("")}</div>
          <button class="chip" data-check-reset="1">체크 지우기</button>
        </div>

        <div class="panel"><h2>상황별 메모</h2><p class="sub">관리터에 쓸 만한 일반 내용입니다.</p>
          <table class="notes-table">${n.situations.map(([a, b]) => `<tr><th>${esc(a)}</th><td>${esc(b)}</td></tr>`).join("")}</table>
          <h3 class="notes-sub">그대로 믿으면 안 되는 부분</h3>
          <ul class="notes-list">${n.cautions.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
        </div>

        ${month ? `<div class="panel notes-wide"><h2>장광 시간대별 운용</h2><p class="sub">ChatGPT로 정리한 표를 요약한 참고 자료입니다. 작성자도 맞지 않는 부분이 있다고 밝혔습니다.</p>
          <div class="filter-row">${n.jangwangMonths.map((m) => `<button class="chip ${m.month === month.month ? "on" : ""}" data-notes-month="${m.month}">${m.label}</button>`).join("")}</div>
          <div class="month-facts">
            <div class="tile" style="--i:0"><span>표의 예상 수온</span><strong>${esc(month.water)}</strong></div>
            <div class="tile" style="--i:1"><span>실측 범위</span><strong>${allT.length ? `${Math.min(...allT)}~${Math.max(...allT)}℃` : "자료 없음"}</strong>${allT.length ? `<span>측정 ${measured.length}회</span>` : ""}</div>
            <div class="tile" style="--i:2"><span>내 장광 출조</span><strong>${jangwangTrips.length}회</strong>${jangwangTrips.length ? "" : "<span>이 달 기록 없음</span>"}</div>
          </div>
          <p class="month-note">${esc(month.note)}</p>
          <div class="table-wrap"><table class="notes-table pattern"><tr><th>시간대</th><th>송어 상태</th><th>운용</th><th>색상</th></tr>${n.jangwangPattern.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table></div>
          ${jangwangTrips.length ? `<h3 class="notes-sub">이 달의 내 기록</h3><div class="trip-grid">${jangwangTrips.map((t, i) => tripCard(t, i)).join("")}</div>` : ""}
        </div>` : ""}

        <div class="panel"><h2>캐스팅</h2><p class="sub">루어 무게에 따라 던지는 방법을 나눕니다.</p>
          ${n.casting.map((c) => `<div class="cast-item"><b>${esc(c.title)}</b><p>${esc(c.body)}</p></div>`).join("")}
          <h3 class="notes-sub">정확도 연습</h3>
          <ul class="notes-list">${n.castingPractice.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
          <h3 class="notes-sub">참고 영상</h3>
          <ul class="notes-list">${n.videos.map((v) => `<li><a href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">${esc(v.title)}</a></li>`).join("")}</ul>
        </div>

        ${window.FISH_NOTES ? "" : window.FISH_COLLECTED.chapters.filter((c) => c.short !== "캐스팅 영상").map((c) => `<div class="panel"><h2>${esc(c.title)}</h2>${c.html}</div>`).join("")}
        ${(n.guides || []).map((g) => `<div class="panel notes-wide"><h2>${esc(g.title)}</h2><p class="sub">${esc(g.sub)}</p>
          ${g.blocks.map((b) => `<h3 class="notes-sub">${esc(b.heading)}</h3>${b.rows
            ? `<div class="table-wrap"><table class="notes-table pattern"><tr>${b.head.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table></div>`
            : `<ul class="notes-list">${b.list.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`}`).join("")}
        </div>`).join("")}
      </div>`;
  }

  // Public guides load everywhere. Private files are only tried in the beta (this PC),
  // so the public site never even asks for them.
  function loadNotes(initialView) {
    const load = (src) => new Promise((done) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => done(true);
      s.onerror = () => done(false);
      document.head.append(s);
    });
    const refresh = () => { if (!$("#view-notes").hidden) renderNotes(); };
    (async () => {
      if (IS_BETA && CAN_LOAD_PRIVATE && await load("private/notes.js") && window.FISH_NOTES) renderBrief();
      await Promise.all(["research_guide", "deokbong_guide", "video_guide", "collected_guide", "collected_data"].map((name) => load(`research/${name}.js`)));
      if (window.FISH_NOTES || window.FISH_RESEARCH_GUIDE) {
        $('.tabs [data-go="notes"]').hidden = false;
        moveInk();
        let openHistory = false;
        try { openHistory = IS_BETA && localStorage.getItem("fishBetaOpen") === "1"; localStorage.removeItem("fishBetaOpen"); } catch (e) { /* 저장을 못 읽으면 그대로 */ }
        if (openHistory) { state.notes.tab = "versions"; go("notes", false); }
        else if (initialView === "notes") go("notes", false);
      }
      if (IS_BETA && CAN_LOAD_PRIVATE) load("private/book_guide.js").then(refresh);
    })();
  }

  /* ---------- reader ---------- */
  let openId = null;
  async function openPage(id) {
    const pg = PAGES.find((p) => p.id === id);
    if (!pg) return;
    openId = id;
    const dr = $("#drawer");
    const siblings = PAGES.filter((p) => p.section === pg.section).sort((a, b) => a.order - b.order);
    const idx = siblings.indexOf(pg);
    const prev = siblings[idx - 1], next = siblings[idx + 1];
    dr.innerHTML = `<div class="drawer-head"><div><h2>${esc(pg.title)}</h2><p>${esc(pg.section)} · 작성 ${pg.created} · 수정 ${pg.modified}</p></div><button class="icon-btn" data-close aria-label="닫기">✕</button></div>
      <div class="drawer-body"><div class="skeleton" style="height:300px"></div></div>
      <div class="drawer-foot"><button ${prev ? `data-open="${prev.id}"` : "disabled"}>${prev ? "← " + esc(prev.title) : ""}</button><button ${next ? `data-open="${next.id}"` : "disabled"}>${next ? esc(next.title) + " →" : ""}</button></div>`;
    dr.classList.add("open");
    dr.setAttribute("aria-hidden", "false");
    $("#drawerBack").hidden = false;
    $("[data-close]", dr).focus();
    try {
      await loadScript("html");
      if (openId !== id) return;
      $(".drawer-body", dr).innerHTML = window.FISH_HTML[id] || '<p class="notice">내용이 없는 페이지입니다.</p>';
      $(".drawer-body", dr).scrollTop = 0;
    } catch {
      $(".drawer-body", dr).innerHTML = '<p class="notice">본문 파일을 불러오지 못했습니다. site 폴더 안의 data 폴더를 확인해 주세요.</p>';
    }
  }
  const versionListHtml = () => `<div class="ver-list">${window.FISH_VERSIONS.map((v, i) => `<div class="ver-item ${i === 0 ? "current" : ""}" style="--i:${i}">
        <div class="ver-head"><b>v${esc(v.version)}</b><span>${esc(v.date)}${i === 0 ? " · 현재 버전" : ""}</span></div>
        <h3>${esc(v.title)}</h3><ul>${v.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>`).join("")}</div>`;
  function openVersions() {
    openId = "versions";
    const dr = $("#drawer");
    const list = window.FISH_VERSIONS;
    dr.innerHTML = `<div class="drawer-head"><div><h2 class="ver-title">버전 기록 <button class="ver-public" data-to-public>공개전환</button></h2><p>현재 v${esc(list[0].version)}${IS_BETA ? " 베타" : ""} · 자료 빌드 ${esc(window.FISH.built)}</p></div><button class="icon-btn" data-close aria-label="닫기">✕</button></div>
      <div class="drawer-body">${versionListHtml()}</div>`;
    dr.classList.add("open");
    dr.setAttribute("aria-hidden", "false");
    dr.setAttribute("aria-label", "버전 기록");
    $("#drawerBack").hidden = false;
    $("[data-close]", dr).focus();
  }
  function closeDrawer() {
    openId = null;
    const dr = $("#drawer");
    dr.classList.remove("open");
    dr.setAttribute("aria-hidden", "true");
    $("#drawerBack").hidden = true;
  }

  /* ---------- search ---------- */
  let searchType = "";
  function openSearch() {
    $("#searchLayer").hidden = false;
    $("#searchInput").focus();
    loadScript("text").then(runSearch);
    $("#searchFilter").innerHTML = ["", ...TYPES].map((t) => `<button class="chip ${searchType === t ? "on" : ""}" data-stype="${t}">${t || "전체"}</button>`).join("");
    runSearch();
  }
  function snippet(text, terms) {
    const low = text.toLowerCase();
    let at = -1;
    for (const t of terms) { at = low.indexOf(t); if (at >= 0) break; }
    if (at < 0) return esc(text.slice(0, 90));
    const s = Math.max(0, at - 36);
    let out = esc(text.slice(s, at + 80));
    terms.forEach((t) => {
      const safe = esc(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(safe, "gi"), (m) => `<mark>${m}</mark>`);
    });
    return (s > 0 ? "… " : "") + out + " …";
  }
  function runSearch() {
    const q = $("#searchInput").value.trim().toLowerCase();
    const box = $("#searchResults");
    if (!q) { box.innerHTML = `<p class="search-count">예: 도로로, 고구마웜, 조류, 찌맞춤</p>`; return; }
    const texts = window.FISH_TEXT;
    if (!texts) { box.innerHTML = `<div class="skeleton"></div>`; return; }
    const terms = q.split(/\s+/);
    const hits = [];
    for (const p of PAGES) {
      if (searchType && p.fishing !== searchType) continue;
      const title = p.title.toLowerCase(), body = (texts[p.id] || "").toLowerCase();
      if (!terms.every((t) => title.includes(t) || body.includes(t))) continue;
      let score = 0;
      terms.forEach((t) => { if (title.includes(t)) score += 50; score += Math.min(20, body.split(t).length - 1); });
      hits.push({ p, score });
    }
    hits.sort((a, b) => b.score - a.score);
    box.innerHTML = `<p class="search-count">${hits.length}개 페이지</p>` + hits.slice(0, 60).map(({ p }) =>
      `<button class="doc" data-open="${p.id}" data-search-close="1"><b>${esc(p.title)}</b><span>${esc(p.section)}</span><span>${snippet(texts[p.id] || "", terms)}</span></button>`).join("");
  }

  /* ---------- navigation ---------- */
  function moveInk() {
    const on = $(".tabs button.on"), ink = $(".tab-ink");
    if (on) { ink.style.left = `${on.offsetLeft}px`; ink.style.width = `${on.offsetWidth}px`; }
  }
  let slideDir = "";
  function go(view, push = true) {
    if (view === "library" && !IS_BETA) view = "plan";   // 자료 탐색은 베타에서만 엽니다.
    const views = ["home", "plan", "map", "log", ...(IS_BETA ? ["library"] : []), ...(window.FISH_NOTES || window.FISH_RESEARCH_GUIDE ? ["notes"] : [])];
    if (!views.includes(view)) view = "plan";
    state.view = view;
    ["home", "plan", "map", "log", "library", "notes"].forEach((v) => { $(`#view-${v}`).hidden = v !== view; });
    document.body.dataset.view = view;
    const sec = $(`#view-${view}`);
    sec.classList.remove("slide-next", "slide-prev");
    sec.style.animation = "none"; void sec.offsetWidth; sec.style.animation = "";
    if (slideDir) { sec.classList.add(`slide-${slideDir}`); slideDir = ""; }   // 옆으로 쓸어 넘긴 방향에서 들어옵니다.
    $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.go === view));
    moveInk();
    if (view === "home") renderHome();
    if (view === "log") renderLog();
    if (view === "library") renderLibrary();
    if (view === "notes") renderNotes();
    if (view === "map" && map) {
      map.invalidateSize();
      const p = placeById[state.place];
      if (!mapFitted) { mapFitted = true; if (hasPin(p)) map.setView([p.lat, p.lon], 11); else fitAll(); }
      else if (hasPin(p) && !map.getBounds().contains([p.lat, p.lon])) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 11));
      refreshWindField();
    }
    if (push) history.replaceState(null, "", `#${view}`);
    window.scrollTo({ top: 0 });
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("button,img,[data-close]");
    if (e.target.closest("a")) return;
    const bg = e.target;
    // a gallery image sits inside its button, so look for the button from whatever was clicked
    const fig = bg.closest("[data-fig-src]");
    if (fig) { showFigure(fig.dataset.figSrc, fig.dataset.figPage); return; }
    if (bg.id === "drawerBack") return closeDrawer();
    if (bg.id === "searchLayer") { $("#searchLayer").hidden = true; return; }
    if (bg.closest("#lightbox")) { if (!justDragged($("#lightbox img"))) $("#lightbox").hidden = true; return; }
    if (!t) return;
    if (t.tagName === "IMG" && t.closest(".drawer-body")) {
      const lb = zoomable($("#lightbox img"));
      lb.src = t.src; lb.resetZoom(); $("#lightbox").hidden = false; return;
    }
    const d = t.dataset;
    if (d.go) go(d.go);
    else if (d.pick) setPicking(!state.picking);
    else if (d.unpin) resetPin(placeById[state.place]);
    else if (d.place) { $("#placePick").open = false; selectPlace(d.place, state.view === "map"); }
    else if (d.type) {
      const pool = PLACES.filter((x) => x.type === d.type && hasPin(x));
      const pick = pool.sort((a, b) => (state.scores?.[b.id]?.score ?? -1) - (state.scores?.[a.id]?.score ?? -1) || b.trips.length - a.trips.length)[0];
      if (pick) selectPlace(pick.id, state.view === "map");
    }
    else if (d.alertClose) { state.alertClosed[d.alertClose] = true; renderBrief(); }
    else if (d.maptab) { state.mapTab = d.maptab; renderMapPanel(); }
    else if (d.maptype !== undefined) { state.mapType = d.maptype; updatePins(); drawBubbles(); renderMapPanel(); }
    else if (d.hourset !== undefined) {
      // a second press turns it off and puts the map back on the current hour
      stopPlay();
      if (state.hourPin === d.hourkey) { state.hourPin = null; setHour(new Date().getHours()); }
      else { state.hourPin = d.hourkey; setHour(+d.hourset); }
      renderMapPanel();
    }
    else if (d.panelToggle !== undefined) {
      state.panelOff = !state.panelOff;
      $(".mapview").classList.toggle("panel-off", state.panelOff);
      $("#mpOpen").hidden = !state.panelOff;
      if (map) setTimeout(() => map.invalidateSize(), 320);
    }
    else if (d.welcome !== undefined) showWelcome();
    else if (d.photoNext) { state.photoIdx = state.photoIdx || {}; state.photoIdx[d.photoNext] = (state.photoIdx[d.photoNext] || 0) + 1; renderHome(); }
    else if (d.homeFocus !== undefined) { homeFocus = d.homeFocus; renderHome(); }
    else if (d.homeOpen) { selectPlace(d.homeOpen, false); go("plan"); }
    else if (d.bubbles !== undefined) { state.bubbles = !state.bubbles; drawBubbles(); renderMapPanel(); }
    else if (d.windToggle !== undefined) { state.windOn = !state.windOn; $("#windCanvas").hidden = !state.windOn; if (state.windOn) refreshWindField(); renderMapPanel(); }
    else if (d.jump) { if (state.view !== "plan") go("plan"); $(`#${d.jump}`)?.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" }); }
    else if (d.date) selectDate(d.date);
    else if (d.open) { if (d.searchClose) $("#searchLayer").hidden = true; openPage(d.open); }
    else if (d.close !== undefined) closeDrawer();
    else if (d.logtype !== undefined) { state.log.type = d.logtype || null; state.log.place = null; renderLog(); }
    else if (d.logplace) { state.log.place = state.log.place === d.logplace ? null : d.logplace; renderLog(); }
    else if (d.month) { state.log.month = state.log.month === d.month ? null : d.month; renderLog(); }
    else if (d.logclear) { state.log.place = state.log.month = null; renderLog(); }
    else if (d.shelf) { state.shelf = d.shelf; renderLibrary(); }
    else if (d.sourceAll) { state.sources = []; renderLibrary(); }
    else if (d.fitQuick) { setFitDate(d.fitQuick); }
    else if (d.fitTarget) { state.notes.fitTarget = d.fitTarget; renderNotes(); }
    else if (d.notesTab) { state.notes.tab = d.notesTab; renderNotes(); window.scrollTo({ top: 0 }); }
    else if (d.guideChapter !== undefined) { state.notes.chapters[state.notes.tab] = +d.guideChapter; renderNotes(); window.scrollTo({ top: 0 }); }
    else if (d.notesMonth) { state.notes.month = +d.notesMonth; renderNotes(); }
    else if (d.checkReset) { store.set("notesChecklist", []); renderNotes(); }
    else if (d.source) {
      state.sources = state.sources.includes(d.source) ? state.sources.filter((s) => s !== d.source) : [...state.sources, d.source];
      renderLibrary();
    }
    else if (d.stype !== undefined) { searchType = d.stype; openSearch(); }
  });
  function setFitDate(iso) {
    state.notes.fitDate = iso;
    $("#fitDate").value = iso;
    $("#fitResult").innerHTML = fitResult(state.notes.fitNow, iso);
    $$("[data-fit-quick]").forEach((b) => b.classList.toggle("on", b.dataset.fitQuick === iso));
  }
  $("#view-notes").addEventListener("input", (e) => {
    if (e.target.id === "fitDate") setFitDate(e.target.value);
  });
  $("#view-notes").addEventListener("change", (e) => {
    if (e.target.dataset.check === undefined) return;
    const i = +e.target.dataset.check;
    const done = store.get("notesChecklist", []).filter((x) => x !== i);
    if (e.target.checked) done.push(i);
    store.set("notesChecklist", done);
  });
  ["pointerover", "focusin", "click"].forEach((type) => $("#view-notes").addEventListener(type, (e) => {
    const point = e.target.closest?.(".temp-point");
    if (point) $("#tempReadout").textContent = point.dataset.tip;
  }));
  $("#dateInput").addEventListener("change", (e) => {
    // the calendar disables earlier dates, but a typed date can still fall outside the range
    const d = e.target.value;
    if (d >= WEATHER_MIN) selectDate(d);
    else e.target.value = state.date;
  });
  $("#hourRange").addEventListener("input", (e) => { stopPlay(); setHour(+e.target.value); if (state.hourPin) { state.hourPin = null; renderMapPanel(); } });
  document.addEventListener("change", (e) => { if (e.target.id === "logYear") { state.log.year = e.target.value || null; renderLog(); } });
  $("#playBtn").addEventListener("click", togglePlay);
  $("#mapAll").addEventListener("click", fitAll);
  $("#mapSat").addEventListener("click", toggleSatellite);
  $("#toTop").addEventListener("click", () => window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" }));
  addEventListener("scroll", () => $("#toTop").classList.toggle("show", window.scrollY > 400), { passive: true });
  $("#searchOpen").addEventListener("click", openSearch);
  // 일반 상태에서는 자료 탐색과 자료 검색을 보여 주지 않습니다.
  if (!IS_BETA) { $('.tabs [data-go="library"]').hidden = true; $("#searchOpen").hidden = true; }
  $("#verBtn").innerHTML = `<span class="ver-long">Version </span><span class="ver-short">v</span>${esc(window.FISH_VERSIONS[0].version)}${IS_BETA ? " Beta" : ""}`;
  // 일반 상태의 버전 버튼은 숫자만 보여 줍니다. 베타에서는 한 번 누르면 기록이 열립니다.
  if (!IS_BETA) { $("#verBtn").removeAttribute("title"); $("#verBtn").classList.add("ver-plain"); }
  $("#searchClose").addEventListener("click", () => { $("#searchLayer").hidden = true; });
  $("#searchInput").addEventListener("input", runSearch);
  // 이스터에그: 버전 버튼을 5초 안에 12번 누르면 베타와 일반 상태가 바뀝니다.
  // 베타에서 기록을 바로 열면 창이 버튼을 가리므로, 잠시 더 누르지 않을 때만 엽니다.
  const eggTimes = [];
  let verOpenTimer = null;
  $("#verBtn").addEventListener("click", () => {
    clearTimeout(verOpenTimer);
    const now = Date.now();
    eggTimes.push(now);
    if (eggTimes.length > 12) eggTimes.shift();
    if (eggTimes.length < 12 || now - eggTimes[0] > 5000) {
      if (IS_BETA) verOpenTimer = setTimeout(openVersions, 500);
      return;
    }
    eggTimes.length = 0;
    if (IS_BETA) setBeta(false); else askBetaCode();
  });
  // 베타 암호: 숫자 네 자리. 화면을 가리는 용도이며 비공개 자료의 보호 수단은 아닙니다.
  const BETA_CODE = 68969863;
  const codeOf = (text) => {
    let x = 2166136261;
    for (const ch of "fish-beta:" + text) { x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619); }
    return x >>> 0;
  };
  function askBetaCode() {
    const box = document.createElement("dialog");
    box.className = "code-dialog";
    box.innerHTML = '<h2>베타 암호</h2><input id="betaCode" type="text" inputmode="numeric" maxlength="4" autocomplete="off" aria-label="베타 암호 숫자 네 자리"><p id="betaCodeMsg">숫자 네 자리를 넣어 주세요.</p><button type="button" id="betaCodeCancel">취소</button>';
    document.body.append(box);
    const input = $("#betaCode", box);
    box.addEventListener("close", () => box.remove());
    $("#betaCodeCancel", box).addEventListener("click", () => box.close());
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 4);
      if (input.value.length < 4) return;
      if (codeOf(input.value) === BETA_CODE) { box.close(); setBeta(true); return; }
      $("#betaCodeMsg", box).textContent = "암호가 맞지 않습니다.";
      input.value = "";
    });
    box.showModal();
    input.focus();
  }
  function setBeta(next) {
    try {
      if (next) { localStorage.setItem("fishBeta", "2"); localStorage.setItem("fishBetaOpen", "1"); } else localStorage.removeItem("fishBeta");
    } catch (e) { return; }
    const toast = document.createElement("div");
    toast.className = "egg-toast";
    toast.textContent = next ? "베타를 켭니다" : "일반 상태로 돌아갑니다";
    document.body.append(toast);
    setTimeout(() => location.reload(), next ? 1600 : 800);
  }
  document.addEventListener("click", (e) => { if (e.target.closest("[data-to-public]")) setBeta(false); });
  $("#themeBtn").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("theme2", next);
    if (state.view === "plan") { renderCharts(); renderBrief(); }
  });
  document.addEventListener("keydown", (e) => {
    if (IS_BETA && e.key === "/" && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); openSearch(); }
    if (e.key === "Escape") {
      if (!$("#lightbox").hidden) $("#lightbox").hidden = true;
      else if (!$("#searchLayer").hidden) $("#searchLayer").hidden = true;
      else if (openId) closeDrawer();
    }
  });
  addEventListener("resize", moveInk);
  addEventListener("hashchange", () => go(location.hash.slice(1), false));

  /* ---------- start ---------- */
  // Phone turned sideways: lay the page out at a PC width (1400 px) and let the browser shrink it to the
  // screen, so it looks like the PC dashboard. Upright phones keep the phone layout.
  (function landscapeAsDesktop() {
    const vp = $('meta[name="viewport"]');
    if (!vp) return;
    const PHONE = "width=device-width, initial-scale=1";
    const FIT = .95;   // a little smaller than the screen so nothing touches the right edge
    const deskAt = (k) => `width=1400, initial-scale=${k.toFixed(3)}, minimum-scale=${k.toFixed(3)}`;
    const isPhone = () => matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) <= 600;
    const landscape = () => matchMedia("(orientation: landscape)").matches;
    // the width actually visible, in CSS px at zoom 1 (notches and browser bars already left out)
    const visible = () => (window.visualViewport ? visualViewport.width * visualViewport.scale : innerWidth);
    const set = (c) => { if (vp.getAttribute("content") !== c) vp.setAttribute("content", c); };
    const fit = () => {
      if (!(isPhone() && landscape())) return;
      const guess = Math.max(screen.width, screen.height) / 1400 * FIT;
      const k = Math.min(guess, visible() / 1400 * FIT);
      set(deskAt(k));
    };
    const apply = () => {
      if (isPhone() && landscape()) {
        set(deskAt(Math.max(screen.width, screen.height) / 1400 * FIT));
        // measure again once the browser has settled into landscape (bars, notch) and correct the zoom
        [250, 700, 1500].forEach((t) => setTimeout(fit, t));
      } else set(PHONE);
    };
    apply();
    matchMedia("(orientation: landscape)").addEventListener?.("change", apply);
    addEventListener("orientationchange", () => setTimeout(apply, 150));
    document.addEventListener("fullscreenchange", () => setTimeout(apply, 300));
  })();
  fillIcons();
  $("#playBtn").innerHTML = icon("play");
  // v2.0.3: dark is the default look; light stays one tap away.
  document.documentElement.dataset.theme = store.get("theme2", "dark");
  updateClock();
  setInterval(updateClock, 30000);
  // The columns of 지금 fill the window below the top bar; the bar's height changes when it wraps.
  const setTopH = () => document.documentElement.style.setProperty("--topH", `${$(".top").offsetHeight}px`);
  setTopH();
  new ResizeObserver(setTopH).observe($(".top"));
  $("#wxBtn").addEventListener("click", refreshWeather);
  // Date shortcuts, both counted from the date on screen: › one day on; » the next Saturday after it,
  // and if the date on screen is already a Saturday, the Sunday after it (so pressing twice gives Sat, then Sun).
  $("#dNext").addEventListener("click", () => selectDate(addDays(state.date, 1)));
  $("#dToday").addEventListener("click", () => selectDate(TODAY));
  $("#dWeekend").addEventListener("click", () => {
    const wd = parseISO(state.date).getDay();
    selectDate(addDays(state.date, wd === 6 ? 1 : 6 - wd));
  });
  // Phone view: the same page in a 390 px wide frame, so the phone layout can be checked on a PC.
  // Inside the frame the button is hidden, so frames never nest.
  if (window.self !== window.top) document.documentElement.classList.add("in-phone");
  // One button: the phone icon opens the phone frame, and while it is open the same button shows a monitor
  // and brings the PC layout back. Escape or a click outside the phone also closes it.
  let phoneLayer = null;
  function setPhoneBtn() {
    const b = $("#phoneBtn"), on = !!phoneLayer;
    b.innerHTML = icon(on ? "monitor" : "phone");
    b.classList.toggle("on", on);
    b.title = on ? "PC 화면으로 돌아가기" : "휴대폰 화면으로 보기";
    b.setAttribute("aria-label", b.title);
    b.setAttribute("aria-pressed", String(on));
  }
  const onPhoneKey = (e) => { if (e.key === "Escape") togglePhoneView(false); };
  function togglePhoneView(want = !phoneLayer) {
    if (!want && phoneLayer) { phoneLayer.remove(); phoneLayer = null; document.removeEventListener("keydown", onPhoneKey); }
    else if (want && !phoneLayer) {
      phoneLayer = document.createElement("div");
      phoneLayer.className = "phone-layer";
      phoneLayer.innerHTML = `<div class="phone-dev"><div class="phone-bar"><span>휴대폰 보기 · 390 × 844</span><span>왼쪽 ${icon("monitor")} 버튼으로 PC 화면</span></div><iframe src="${location.pathname}${location.hash || "#plan"}" title="휴대폰 화면 미리보기"></iframe></div>`;
      phoneLayer.addEventListener("click", (e) => { if (e.target === phoneLayer) togglePhoneView(false); });
      document.addEventListener("keydown", onPhoneKey);
      document.body.append(phoneLayer);
    }
    setPhoneBtn();
  }
  setPhoneBtn();
  $("#phoneBtn").addEventListener("click", () => togglePhoneView());
  // Rotate button (phones): turns the screen between landscape and portrait where the browser allows it
  // (Android Chrome and similar, in full screen); elsewhere it asks the user to turn the phone.
  function toast(text) {
    const t = document.createElement("div");
    t.className = "egg-toast";
    t.textContent = text;
    document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  }
  // Rotate view (phones): the PC dashboard, laid out 1400 px wide inside a frame, turned 90 degrees and
  // scaled so it fills the upright screen; turn the phone sideways to read it. Works in every browser
  // because it needs no permission to rotate the screen. Pressing the button again (here or inside the
  // frame) or turning the phone to landscape closes it.
  let rotLayer = null;
  function sizeRot() {
    if (!rotLayer) return;
    const vw = innerWidth, vh = innerHeight;                 // upright screen
    const s = vh / 1400, h = Math.round(vw / s);            // landscape width = vh, height = vw
    const box = $(".rot-box", rotLayer);
    box.style.width = "1400px";
    box.style.height = `${h}px`;
    box.style.transform = `translate(${vw}px, 0) rotate(90deg) scale(${s})`;
  }
  function closeRot() {
    if (!rotLayer) return;
    rotLayer.remove(); rotLayer = null;
    document.documentElement.classList.remove("rot-on");
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }
  window.__closeRot = closeRot;
  function openRot() {
    rotLayer = document.createElement("div");
    rotLayer.className = "rot-layer";
    rotLayer.innerHTML = `<div class="rot-box"><iframe src="${location.pathname}${location.hash || "#plan"}" title="가로 대시보드"></iframe></div>`;
    document.body.append(rotLayer);
    document.documentElement.classList.add("rot-on");
    sizeRot();
    // full screen gives the dashboard the whole screen; the size is set first so it never waits on this
    document.documentElement.requestFullscreen?.({ navigationUI: "hide" })?.catch(() => {});
    setTimeout(sizeRot, 400);
  }
  addEventListener("resize", sizeRot);
  document.addEventListener("fullscreenchange", () => setTimeout(sizeRot, 100));
  matchMedia("(orientation: landscape)").addEventListener?.("change", (e) => { if (e.matches && rotLayer) closeRot(); });
  $("#rotateBtn").addEventListener("click", async () => {
    // inside the frame: the same button closes the rotated view
    if (window.self !== window.top && window.parent.__closeRot) { window.parent.__closeRot(); return; }
    if (rotLayer) { closeRot(); return; }
    if (matchMedia("(orientation: landscape)").matches) { toast("가로로 들고 있어 이미 대시보드 화면입니다. 세로로 돌리면 휴대폰 화면이 됩니다."); return; }
    openRot();
  });
  // coming back to the tab after half an hour fetches the weather again
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.wxAt && Date.now() - state.wxAt > 30 * 60e3) refreshWeather(); });
  setInterval(() => { if (!document.hidden && state.wxAt && Date.now() - state.wxAt > 30 * 60e3) refreshWeather(); }, 5 * 60e3);
  $("#dateInput").value = state.date;
  $("#dateInput").min = WEATHER_MIN;
  $("#dateRange").textContent = `예보: ${FORECAST_END.replaceAll("-", ".")}까지, 이후는 최근 3년 평균`;
  $("#hourRange").value = state.hour;
  $("#hourLabel").textContent = `${pad(state.hour)}:00`;
  initMap();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => { /* the site still works online without it */ });
  }
  // Big numbers shrink on their own when they would not fit their box (e.g. "100" in a narrow
  // phone card), so they never wrap onto a second line or spill out.
  const FIT_SEL = ".kpis strong, .stats .big, .stat strong, .hs-best b, .dn-c b";
  let fitQueued = false;
  const fitNumbers = () => {
    fitQueued = false;
    document.querySelectorAll(FIT_SEL).forEach((el) => {
      el.style.fontSize = "";
      const room = el.clientWidth;
      if (!room) return;
      const need = el.scrollWidth;
      if (need > room) {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        el.style.fontSize = Math.max(14, Math.floor(fs * room / need * 0.98)) + "px";
      }
    });
  };
  const queueFit = () => { if (!fitQueued) { fitQueued = true; requestAnimationFrame(fitNumbers); } };
  new MutationObserver(queueFit).observe(document.querySelector("main"), { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("resize", queueFit);
  if (document.fonts?.ready) document.fonts.ready.then(queueFit);
  // 열 때는 언제나 홈: 물고기 로고를 누른 것처럼 환영 화면을 잠깐 보여 준 뒤 홈으로 갑니다.
  // 3D 페이지의 '연구 노트' 링크(#notes)로 연 경우만 연구 노트로 바로 갑니다.
  const startHash = location.hash.slice(1);
  if (startHash === "notes") go("notes", false); else { go("home"); showWelcome(); }
  loadNotes(startHash);
  loadAll().then(fillWelcome, () => {});
  // 휴대폰: 화면을 옆으로 쓸면 그 방향으로 메뉴가 넘어갑니다 (홈 → 지금 → 지도 → 기록 → 자료 → 연구).
  // 지도, 옆으로 스크롤되는 줄, 입력칸, 3D 화면 위에서는 원래 동작을 그대로 둡니다.
  (() => {
    const TOUCH = matchMedia("(max-width: 720px), (pointer: coarse)");
    let sx = 0, sy = 0, t0 = 0, armed = false;
    const blocked = (el) => {
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        if (e.matches && e.matches(".leaflet-container, input, select, textarea, iframe, dialog, .welcome, .lightbox, .drawer")) return true;
        const cs = getComputedStyle(e);
        if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && e.scrollWidth > e.clientWidth + 4) return true;
      }
      return false;
    };
    document.addEventListener("touchstart", (e) => {
      armed = TOUCH.matches && e.touches.length === 1 && !blocked(e.target);
      if (!armed) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; t0 = Date.now();
    }, { passive: true });
    document.addEventListener("touchend", (e) => {
      if (!armed) return;
      armed = false;
      const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6 || Date.now() - t0 > 700) return;
      const order = [...document.querySelectorAll(".tabs [data-go]")].filter((b) => !b.hidden).map((b) => b.dataset.go), i = order.indexOf(state.view);
      const next = i < 0 ? null : order[i + (dx < 0 ? 1 : -1)];
      if (!next) return;
      slideDir = dx < 0 ? "next" : "prev";
      go(next);
      window.scrollTo({ left: 0, top: 0 });   // 넘긴 뒤 가로 위치를 늘 처음으로
    }, { passive: true });
  })();
  if (document.fonts?.ready) document.fonts.ready.then(moveInk);
})();
