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
    similar: null,
    playing: null,
    picking: false,
    satellite: store.get("satellite", false) === true,
    log: { type: null, place: null, month: null },
    shelf: PAGES[0].section,
    sources: [],
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
  const WEATHER_MIN = "1940-01-02";
  const WEATHER_MAX = addDays(TODAY, 15);
  const weatherMode = (date) => (diffDays(date, TODAY) < -85 ? "archive" : "forecast");
  const MODE_LABEL = {
    forecast: (d) => (d < TODAY ? "최근 실황 모델 값" : "예보"),
    archive: () => "과거 재분석 값",
  };

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
  async function fetchWeather(date) {
    const located = PLACES.filter(hasPin);
    const mode = weatherMode(date);
    const rows = mode === "forecast"
      ? await fetchRange("api.open-meteo.com", "forecast", located, date, ",precipitation_probability")
      : await fetchRange("archive-api.open-meteo.com", "archive", located, date);
    const out = {};
    located.forEach((p, i) => { out[p.id] = rows[i]; });
    return { date, mode, data: out };
  }
  async function fetchMarine(place, date) {
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${place.lat}&longitude=${place.lon}&hourly=wave_height,sea_level_height_msl&timezone=${TZ}&start_date=${date}&end_date=${date}`;
    const j = await getJSON(url);
    return { wave: j.hourly.wave_height, sea: j.hourly.sea_level_height_msl };
  }
  async function fetchStrip(place) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&wind_speed_unit=ms&timezone=${TZ}&forecast_days=16`;
    return (await getJSON(url)).daily;
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
  function countUp(el) {
    const target = parseFloat(el.dataset.to);
    if (Number.isNaN(target) || REDUCED) return;
    const digits = +el.dataset.d || 0;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 650);
      el.textContent = (target * (1 - Math.pow(1 - k, 3))).toFixed(digits);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------- charts ---------- */
  const charts = [];
  function makeChart(el, cfg) {
    // the same height and margins on every chart keep the plot areas level across a row
    const H = 170;
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
      if (cfg.bars) {
        const s = cfg.series[0];
        const bw = Math.max(2, (width - m.l - m.r) / n - 2);
        s.values.forEach((v, i) => {
          if (!v) return;
          const y = Y(v), h = Y(lo) - y, r = Math.min(4, h, bw / 2);
          parts.push(`<path class="${animate ? "bar-in" : ""}" style="animation-delay:${i * 18}ms" fill="${s.color}" d="M${X(i) - bw / 2} ${Y(lo)}V${y + r}Q${X(i) - bw / 2} ${y} ${X(i) - bw / 2 + r} ${y}H${X(i) + bw / 2 - r}Q${X(i) + bw / 2} ${y} ${X(i) + bw / 2} ${y + r}V${Y(lo)}Z"/>`);
        });
        if (!fin(s.values).some((v) => v > 0)) parts.push(`<text x="${(width + m.l) / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="var(--muted)">이날 강수 없음</text>`);
      } else {
        cfg.series.forEach((s) => {
          let d = "", pen = false;
          s.values.forEach((v, i) => {
            if (v == null) { pen = false; return; }
            d += `${pen ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`; pen = true;
          });
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

  function chartShell(host, title, i, legend = "") {
    const el = document.createElement("div");
    el.className = "chart";
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
    const accent = "var(--s1)";
    const sun = { sunrise: w.sunrise, sunset: w.sunset };
    let i = 0;
    charts.push(makeChart(chartShell(host, "기온", i++), {
      ...sun, title: "기온", unit: "°C", digits: 1, minSpan: 4,
      series: [{ label: "기온", color: accent, values: w.temp }],
      note: (h) => (w.code ? WX(w.code[h])[1] : "평균값"),
    }));
    charts.push(makeChart(chartShell(host, "바람", i++, `<div class="legend"><span><i style="background:${accent}"></i>풍속</span><span><i class="dash"></i>돌풍</span></div>`), {
      ...sun, title: "바람", unit: "m/s", digits: 1, zero: true, minTop: 5,
      series: [{ label: "풍속", color: accent, values: w.wind }, { label: "돌풍", color: "var(--muted)", values: w.gust, dash: true }],
      arrows: w.dir,
      note: (h) => (w.dir[h] == null ? "" : `${compass(w.dir[h])}풍`),
    }));
    charts.push(makeChart(chartShell(host, "강수량", i++), {
      ...sun, title: "강수량", unit: "mm", digits: 1, zero: true, minTop: 2, bars: true,
      series: [{ label: "강수량", color: accent, values: w.precip }],
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
        charts.push(makeChart(chartShell(host, "파고 (모델 참고값)", i++), {
          ...sun, title: "파고", unit: "m", digits: 1, zero: true, minTop: 1,
          series: [{ label: "파고", color: accent, values: mr.wave }],
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
    } else {
      const el = chartShell(host, "시간별 메모", i++);
      $(".chart-now", el).remove();
      el.insertAdjacentHTML("beforeend", `<p class="notice">그래프 위에서 포인터를 움직이면 지도의 풍향과 기온이 같은 시각으로 함께 바뀝니다. 음영은 일출 전과 일몰 후입니다.</p>`);
    }
  }

  /* ---------- hour ---------- */
  function setHour(h, fromChart) {
    if (h === state.hour && fromChart) return;
    state.hour = h;
    $("#hourRange").value = h;
    $("#hourLabel").textContent = `${pad(h)}:00`;
    charts.forEach((c) => c.update(h));
    updatePins();
    refreshWindField();
  }
  function stopPlay() {
    if (state.playing) { clearInterval(state.playing); state.playing = null; $("#playBtn").textContent = "▶"; }
  }
  function togglePlay() {
    if (state.playing) return stopPlay();
    $("#playBtn").textContent = "❚❚";
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
    if (on) $(".map-card").scrollIntoView({ block: "center", behavior: REDUCED ? "auto" : "smooth" });
  }
  function initMap() {
    if (!window.L) {
      $("#map").innerHTML = '<p class="state-msg">지도 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하세요. 노트 자료는 그대로 볼 수 있습니다.</p>';
      return;
    }
    map = L.map("map", { zoomControl: true, attributionControl: true, scrollWheelZoom: true }).setView([36.9, 127], 9);
    map.zoomControl.setPosition("topleft");
    setTiles();
    PLACES.filter(hasPin).forEach(addMarker);
    fitAll();
    map.on("click", (e) => {
      const p = placeById[state.place];
      if (state.picking || !hasPin(p)) movePin(p, e.latlng.lat, e.latlng.lng);
    });
    map.on("moveend zoomend", refreshWindField);
    map.on("movestart zoomstart", () => clearCanvas());
  }
  function fitAll() {
    if (!map) return;
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
      $("b", el).textContent = w?.temp[h] == null ? "–" : `${Math.round(w.temp[h])}°`;
      $("span", el).textContent = id === state.place && w?.wind[h] != null ? `${id} ${w.wind[h].toFixed(1)}m/s` : id;
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
    if (state.view !== "plan" || document.hidden || !field.length) return;
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
  function renderPlaceChips() {
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
  function renderStrip(daily) {
    const el = $("#dayStrip");
    if (!daily) { el.innerHTML = ""; return; }
    el.innerHTML = daily.time.map((t, i) => {
      const d = parseISO(t), wk = d.getDay();
      return `<button class="day ${t === state.date ? "on" : ""}" style="--i:${i}" data-date="${t}" title="${WX(daily.weather_code[i])[1]}">
        <span class="d ${wk === 0 || wk === 6 ? "weekend" : ""}">${t === TODAY ? "오늘" : fmtShort(t)}</span>
        <span class="ic" aria-hidden="true">${WX(daily.weather_code[i])[0]}</span>
        <div class="t">${Math.round(daily.temperature_2m_min[i])}° / ${Math.round(daily.temperature_2m_max[i])}°</div>
        <div class="w">바람 ${num(daily.wind_speed_10m_max[i])}</div>
        <div class="w">비 ${num(daily.precipitation_sum[i])}mm</div></button>`;
    }).join("");
    focusStripDay();
  }

  function renderBrief(err) {
    const p = placeById[state.place];
    const w = state.weather?.data[p.id];
    // the most severe code of the day, which is how the daily cards above are coded too
    const dayWx = w?.code && fin(w.code).length ? WX(Math.max(...fin(w.code))) : null;
    const head = `<div class="card brief-head"><div class="brief-title"><h2>${esc(p.name)}</h2>${dayWx ? `<span class="brief-wx" title="${dayWx[1]}"><i aria-hidden="true">${dayWx[0]}</i>${dayWx[1]}</span>` : ""}</div><p>${esc(p.address)}</p>
      <p class="pin-fix">위치 정확도: ${esc(p.accuracy)}${pinOverrides[p.id] ? ` (${p.lat}, ${p.lon})` : ""}</p>
      <div class="pin-actions"><button class="chip" data-pick="1">${state.picking ? "위치 지정 취소" : "지도에서 위치 지정"}</button>${pinOverrides[p.id] ? '<button class="chip" data-unpin="1">원래 위치로</button>' : ""}</div>
      ${w ? `<span class="source-tag">${fmtDate(state.date)} · ${MODE_LABEL[state.weather.mode](state.date)}</span>` : ""}</div>`;
    if (!hasPin(p)) {
      $("#brief").innerHTML = head + `<div class="card notice">이 낚시터의 주소를 찾지 못해 날씨를 조회할 수 없습니다. 지도에서 낚시터 위치를 클릭하면 저장되고 날씨가 바로 나옵니다.</div>`;
      return;
    }
    if (err) {
      $("#brief").innerHTML = head + `<div class="card notice">날씨 정보를 불러오지 못했습니다(${esc(err)}). 인터넷 연결을 확인한 뒤 날짜를 다시 선택해 주세요. 아래 공략법과 조행기는 그대로 볼 수 있습니다.</div>`;
      return;
    }
    if (!w) {
      $("#brief").innerHTML = head + `<div class="tiles">${[0, 1, 2, 3].map(() => `<div class="skeleton"></div>`).join("")}</div>`;
      return;
    }
    const temps = fin(w.temp), winds = fin(w.wind), gusts = fin(w.gust);
    const rain = fin(w.precip).reduce((a, b) => a + b, 0);
    const maxProb = w.prob ? Math.max(...fin(w.prob)) : null;
    const tile = (i, label, val, d, unit, extra = "") => `<div class="tile" style="--i:${i}"><span>${label}</span><strong data-to="${val}" data-d="${d}">${Number(val).toFixed(d)}</strong><small>${unit}</small>${extra ? `<span>${extra}</span>` : ""}</div>`;
    const maxWindIdx = w.wind.indexOf(Math.max(...winds));
    $("#brief").innerHTML = head + `<div class="tiles">
      ${tile(0, "최고 기온", Math.max(...temps), 0, "°C", `최저 ${Math.round(Math.min(...temps))}°C`)}
      ${tile(1, "최대 풍속", Math.max(...winds), 1, "m/s", `${pad(maxWindIdx)}시 · ${compass(w.dir[maxWindIdx] ?? 0)}풍`)}
      ${tile(2, "강수 합계", rain, 1, "mm", maxProb != null ? `최대 확률 ${maxProb}%` : "확률 자료 없음")}
      ${tile(3, "최대 돌풍", Math.max(...gusts), 1, "m/s", w.sunrise ? `일출 ${w.sunrise} · 일몰 ${w.sunset}` : "")}
    </div>
    ${p.type === "바다" ? `<div class="card notice">해상 값은 모델 참고치입니다. 출항 판단은 기상청 특보와 물때표로 다시 확인하세요.</div>` : ""}
`;
    $$("[data-to]", $("#brief")).forEach(countUp);
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

    $("#dossier").innerHTML = `
      <div class="panel"><h2>${esc(p.id)} 공략법</h2><p class="sub">이 장소를 다루는 문서입니다. 언급 횟수가 많은 순으로 보여줍니다.</p>${guideHtml}</div>
      <div class="panel wide"><h2>이맘때의 조행기</h2><p class="sub">${fmtShort(state.date)} 앞뒤 30일 안에 ${esc(p.id)}에 다녀온 기록 ${seasonal.length}건</p>${seasonalHtml}</div>
      <div class="panel wide" id="similarPanel"><h2>비슷한 날씨의 지난 출조</h2><p class="sub">선택한 날의 기온, 바람, 강수와 가까운 순입니다. 과거 값은 재분석 자료입니다.</p><div id="similarBody"><div class="skeleton"></div></div></div>
      <div class="panel"><h2>출조 전에 읽기</h2><p class="sub">${placeTypes(p).join("·")}낚시 공통 자료</p><div>${essentials.slice(0, 10).map((d, i) => docBtn(d, i, "", d.section)).join("") || '<p class="notice">공통 자료가 없습니다.</p>'}</div></div>
      ${catchPanel(p)}
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
    renderBrief();
    $("#charts").innerHTML = state.weather ? "" : `<div class="skeleton" style="grid-column:span 12;height:180px"></div>`;
    try {
      if (!state.weather) {
        const w = await fetchWeather(state.date);
        cacheW[state.date] = w;
        if (token !== loadToken) return;
        state.weather = w;
      }
      if (p.type === "바다" && hasPin(p)) {
        try { state.marine = await fetchMarine(p, state.date); } catch { state.marine = null; }
        if (token !== loadToken) return;
      }
      renderBrief();
      renderCharts();
      updatePins();
      refreshWindField();
      renderSimilar();
    } catch (e) {
      if (token !== loadToken) return;
      renderBrief(e.message);
      $("#charts").innerHTML = "";
      const sim = $("#similarBody");
      if (sim) sim.innerHTML = `<p class="notice">날씨를 불러오지 못해 비교할 수 없습니다.</p>`;
    }
    if (hasPin(p)) fetchStrip(p).then((d) => { if (token === loadToken) renderStrip(d); }).catch(() => renderStrip(null));
    else renderStrip(null);
  }

  function selectPlace(id, fly = true) {
    state.place = id;
    state.picking = false;
    store.set("place", id);
    const p = placeById[id];
    if (map && fly && hasPin(p)) map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), PLACE_ZOOM), { duration: REDUCED ? 0 : .9 });
    updatePins();
    loadAll();
  }
  function selectDate(date) {
    if (!date) return;
    state.date = date;
    $("#dateInput").value = date;
    if (date !== TODAY) setHour(7);
    $$(".day").forEach((d) => d.classList.toggle("on", d.dataset.date === date));
    focusStripDay();
    loadAll();
  }

  /* ---------- log view ---------- */
  function renderLog() {
    const { type, place, month } = state.log;
    const base = allTrips.filter((t) => !type || t.fishing === type);
    const list = base.filter((t) => (!place || t.place === place) && (!month || t.trip.date.startsWith(month)));
    const years = [...new Set(allTrips.map((t) => t.trip.date.slice(0, 4)))].sort();
    const counts = {};
    base.filter((t) => !place || t.place === place).forEach((t) => { const k = t.trip.date.slice(0, 7); counts[k] = (counts[k] || 0) + 1; });
    const maxC = Math.max(1, ...Object.values(counts));
    const level = (n) => (n === 0 ? 0 : Math.max(1, Math.ceil(n / maxC * 4)));
    const months = Array.from({ length: 12 }, (_, i) => pad(i + 1));
    const heat = `<div class="heat"><span></span>${months.map((m) => `<span class="h">${+m}월</span>`).join("")}` + years.map((y, yi) => `<span class="y">${y}</span>` + months.map((m, mi) => {
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
      <div class="hero-line"><h1>출조 기록</h1>
        <div class="stat"><strong data-to="${own.length}">${own.length}</strong><span>내 조행기</span></div>
        <div class="stat"><strong data-to="${new Set(own.map((t) => t.place)).size}">${new Set(own.map((t) => t.place)).size}</strong><span>다녀온 장소</span></div>
        <div class="stat"><strong>${topId ? esc(topId) : "–"}</strong><span>가장 많이 간 곳${topId ? ` (${tally[topId]}건)` : ""}</span></div>
        <div class="stat"><strong>${own[0] ? fmtShort(own[0].trip.date) : "–"}</strong><span>${own[0] ? `최근 출조, ${own[0].trip.date.slice(0, 4)}년 ${esc(own[0].place)}` : "최근 출조"}</span></div>
      </div>
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
      <p class="source-hint">자료를 눌러 그 내용만 볼 수 있습니다. 여러 개를 함께 고를 수도 있습니다.${state.sources.length ? ' <button class="chip" data-source-all="1">전체 보기</button>' : ""}</p>
      <div class="sources" aria-label="자료 출처와 반영일">${sources}</div>
      <div class="shelves">${shelves}</div><div class="tree">${tree}</div>`;
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
  function openVersions() {
    openId = "versions";
    const dr = $("#drawer");
    const list = window.FISH_VERSIONS;
    dr.innerHTML = `<div class="drawer-head"><div><h2>버전 기록</h2><p>현재 v${esc(list[0].version)} · 자료 빌드 ${esc(window.FISH.built)}</p></div><button class="icon-btn" data-close aria-label="닫기">✕</button></div>
      <div class="drawer-body"><div class="ver-list">${list.map((v, i) => `<div class="ver-item ${i === 0 ? "current" : ""}" style="--i:${i}">
        <div class="ver-head"><b>v${esc(v.version)}</b><span>${esc(v.date)}${i === 0 ? " · 현재 버전" : ""}</span></div>
        <h3>${esc(v.title)}</h3><ul>${v.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>`).join("")}</div></div>`;
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
  function go(view, push = true) {
    if (!["plan", "log", "library"].includes(view)) view = "plan";
    state.view = view;
    ["plan", "log", "library"].forEach((v) => { $(`#view-${v}`).hidden = v !== view; });
    const sec = $(`#view-${view}`);
    sec.style.animation = "none"; void sec.offsetWidth; sec.style.animation = "";
    $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.go === view));
    moveInk();
    if (view === "log") renderLog();
    if (view === "library") renderLibrary();
    if (view === "plan" && map) { map.invalidateSize(); refreshWindField(); }
    if (push) history.replaceState(null, "", `#${view}`);
    window.scrollTo({ top: 0 });
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("button,img,[data-close]");
    const bg = e.target;
    if (bg.id === "drawerBack") return closeDrawer();
    if (bg.id === "searchLayer") { $("#searchLayer").hidden = true; return; }
    if (bg.closest("#lightbox")) { $("#lightbox").hidden = true; return; }
    if (!t) return;
    if (t.tagName === "IMG" && t.closest(".drawer-body")) {
      $("#lightbox img").src = t.src; $("#lightbox").hidden = false; return;
    }
    const d = t.dataset;
    if (d.go) go(d.go);
    else if (d.pick) setPicking(!state.picking);
    else if (d.unpin) resetPin(placeById[state.place]);
    else if (d.place) selectPlace(d.place);
    else if (d.date) selectDate(d.date);
    else if (d.open) { if (d.searchClose) $("#searchLayer").hidden = true; openPage(d.open); }
    else if (d.close !== undefined) closeDrawer();
    else if (d.logtype !== undefined) { state.log.type = d.logtype || null; state.log.place = null; renderLog(); }
    else if (d.logplace) { state.log.place = state.log.place === d.logplace ? null : d.logplace; renderLog(); }
    else if (d.month) { state.log.month = state.log.month === d.month ? null : d.month; renderLog(); }
    else if (d.logclear) { state.log.place = state.log.month = null; renderLog(); }
    else if (d.shelf) { state.shelf = d.shelf; renderLibrary(); }
    else if (d.sourceAll) { state.sources = []; renderLibrary(); }
    else if (d.source) {
      state.sources = state.sources.includes(d.source) ? state.sources.filter((s) => s !== d.source) : [...state.sources, d.source];
      renderLibrary();
    }
    else if (d.stype !== undefined) { searchType = d.stype; openSearch(); }
  });
  $("#dateInput").addEventListener("change", (e) => {
    // the calendar disables other dates, but a typed date can still fall outside the range
    const d = e.target.value;
    if (d >= WEATHER_MIN && d <= WEATHER_MAX) selectDate(d);
    else e.target.value = state.date;
  });
  $("#hourRange").addEventListener("input", (e) => { stopPlay(); setHour(+e.target.value); });
  $("#playBtn").addEventListener("click", togglePlay);
  $("#mapAll").addEventListener("click", fitAll);
  $("#mapSat").addEventListener("click", toggleSatellite);
  $("#toTop").addEventListener("click", () => window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" }));
  addEventListener("scroll", () => $("#toTop").classList.toggle("show", window.scrollY > 400), { passive: true });
  $("#searchOpen").addEventListener("click", openSearch);
  $("#verBtn").textContent = `Version ${window.FISH_VERSIONS[0].version}`;
  $("#verBtn").addEventListener("click", openVersions);
  $("#searchClose").addEventListener("click", () => { $("#searchLayer").hidden = true; });
  $("#searchInput").addEventListener("input", runSearch);
  $("#themeBtn").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
    if (state.view === "plan") renderCharts();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); openSearch(); }
    if (e.key === "Escape") {
      if (!$("#lightbox").hidden) $("#lightbox").hidden = true;
      else if (!$("#searchLayer").hidden) $("#searchLayer").hidden = true;
      else if (openId) closeDrawer();
    }
  });
  addEventListener("resize", moveInk);
  addEventListener("hashchange", () => go(location.hash.slice(1), false));

  /* ---------- start ---------- */
  const savedTheme = store.get("theme", null);
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $("#dateInput").value = state.date;
  $("#dateInput").min = WEATHER_MIN;
  $("#dateInput").max = WEATHER_MAX;
  $("#dateRange").textContent = `날씨 제공: ${WEATHER_MAX.replaceAll("-", ".")}까지`;
  $("#hourRange").value = state.hour;
  $("#hourLabel").textContent = `${pad(state.hour)}:00`;
  initMap();
  go(location.hash.slice(1) || "plan", false);
  loadAll();
  if (document.fonts?.ready) document.fonts.ready.then(moveInk);
})();
