/* Map Center Finder — UI logic.
 *
 * The "centre of mass" is computed on the sphere: every city becomes a unit
 * vector, the vectors are averaged, and the mean is projected back onto the
 * surface.  That avoids the artefacts of averaging latitude/longitude pairs
 * near the poles or across the antimeridian.
 */

const EARTH_RADIUS_M = 6371008.8;
const DEBOUNCE_MS = 350;

const el = {
  cities: document.getElementById('cities'),
  addCity: document.getElementById('add-city'),
  spread: document.getElementById('spread'),
  spreadOut: document.getElementById('spread-out'),
  find: document.getElementById('find'),
  result: document.getElementById('result'),
  resultPlace: document.getElementById('result-place'),
  resultCoords: document.getElementById('result-coords'),
  resultDistances: document.getElementById('result-distances'),
  zoomCenter: document.getElementById('zoom-center'),
  zoomAll: document.getElementById('zoom-all'),
  status: document.getElementById('status'),
};

const rows = [];
let nextRowId = 1;
let solution = null; // { lat, lon, radius, cities }

/* ---------------------------------------------------------------- map ---- */

const map = L.map('map', { worldCopyJump: true }).setView([25, 10], 2);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const cityLayer = L.layerGroup().addTo(map);
const centerLayer = L.layerGroup().addTo(map);

function cityIcon(index) {
  return L.divIcon({
    className: '',
    html: `<div class="badge" style="background:#ff8c42;color:#1a1004;border:2px solid #fff;border-radius:50%;
           width:26px;height:26px;display:grid;place-items:center;font:600 12px system-ui;
           box-shadow:0 2px 6px rgba(0,0,0,.5)">${index + 1}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

const centerIcon = L.divIcon({
  className: 'center-pin',
  html: '<div style="font:700 26px/1 system-ui;color:#ff8c42;text-shadow:0 0 6px #000">&#10041;</div>',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

/* ------------------------------------------------------------ geometry ---- */

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

function centerOfMass(points) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    const lat = toRad(p.lat);
    const lon = toRad(p.lon);
    const cosLat = Math.cos(lat);
    x += cosLat * Math.cos(lon);
    y += cosLat * Math.sin(lon);
    z += Math.sin(lat);
  }
  const n = points.length;
  x /= n;
  y /= n;
  z /= n;
  const hyp = Math.hypot(x, y);
  if (hyp < 1e-12 && Math.abs(z) < 1e-12) return null; // perfectly balanced, undefined centre
  return { lat: toDeg(Math.atan2(z, hyp)), lon: toDeg(Math.atan2(y, x)) };
}

function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  if (meters < 100000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000).toLocaleString()} km`;
}

/* ----------------------------------------------------------- city rows ---- */

function addRow(initialValue = '') {
  const row = {
    id: nextRowId++,
    place: null,
    timer: null,
    controller: null,
    node: document.createElement('div'),
  };

  row.node.className = 'city';
  row.node.innerHTML = `
    <span class="badge"></span>
    <input type="text" placeholder="City or address" autocomplete="off" spellcheck="false">
    <button class="remove" title="Remove">&times;</button>`;

  row.input = row.node.querySelector('input');
  row.removeBtn = row.node.querySelector('.remove');
  row.input.value = initialValue;

  row.input.addEventListener('input', () => {
    row.place = null;
    row.node.classList.remove('resolved');
    refreshControls();
    scheduleSuggest(row);
  });

  row.input.addEventListener('keydown', (event) => {
    const list = row.node.querySelector('.suggestions');
    if (event.key === 'Escape') {
      closeSuggestions(row);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const active = list && list.querySelector('button.active');
      if (active) active.click();
      else resolveFirstMatch(row);
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && list) {
      event.preventDefault();
      moveActive(list, event.key === 'ArrowDown' ? 1 : -1);
    }
  });

  row.input.addEventListener('blur', () => setTimeout(() => closeSuggestions(row), 150));

  row.removeBtn.addEventListener('click', () => {
    if (rows.length <= 2) return;
    rows.splice(rows.indexOf(row), 1);
    row.node.remove();
    renumber();
    refreshControls();
    drawCities();
  });

  rows.push(row);
  el.cities.appendChild(row.node);
  renumber();
  refreshControls();
  return row;
}

function renumber() {
  rows.forEach((row, index) => {
    row.node.querySelector('.badge').textContent = String(index + 1);
    row.removeBtn.disabled = rows.length <= 2;
  });
}

function resolvedPlaces() {
  return rows.filter((row) => row.place).map((row) => row.place);
}

function refreshControls() {
  el.find.disabled = resolvedPlaces().length < 2;
}

/* -------------------------------------------------------- geocoding UI ---- */

function scheduleSuggest(row) {
  clearTimeout(row.timer);
  const query = row.input.value.trim();
  if (query.length < 2) {
    closeSuggestions(row);
    return;
  }
  row.timer = setTimeout(() => suggest(row, query), DEBOUNCE_MS);
}

async function geocode(row, query, limit) {
  if (row.controller) row.controller.abort();
  row.controller = new AbortController();
  const url = `/api/geocode?q=${encodeURIComponent(query)}&limit=${limit}`;
  const response = await fetch(url, { signal: row.controller.signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `request failed (${response.status})`);
  return data.results || [];
}

async function suggest(row, query) {
  try {
    const results = await geocode(row, query, 5);
    if (row.input.value.trim() !== query) return;
    showSuggestions(row, results);
    setStatus('');
  } catch (error) {
    if (error.name !== 'AbortError') setStatus(error.message, true);
  }
}

async function resolveFirstMatch(row) {
  const query = row.input.value.trim();
  if (!query) return;
  setStatus(`Looking up "${query}"…`);
  try {
    const results = await geocode(row, query, 1);
    if (!results.length) {
      setStatus(`No match for "${query}".`, true);
      return;
    }
    selectPlace(row, results[0]);
    setStatus('');
  } catch (error) {
    if (error.name !== 'AbortError') setStatus(error.message, true);
  }
}

function showSuggestions(row, results) {
  closeSuggestions(row);
  if (!results.length) return;
  const list = document.createElement('div');
  list.className = 'suggestions';
  for (const place of results) {
    const button = document.createElement('button');
    button.type = 'button';
    const rest = place.name.split(',').slice(1).join(',').trim();
    button.innerHTML = `<span class="s-main"></span><span class="s-sub"></span>`;
    button.querySelector('.s-main').textContent = place.short_name;
    button.querySelector('.s-sub').textContent = rest || `${place.lat.toFixed(3)}, ${place.lon.toFixed(3)}`;
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      selectPlace(row, place);
      closeSuggestions(row);
    });
    list.appendChild(button);
  }
  row.node.appendChild(list);
}

function closeSuggestions(row) {
  const list = row.node.querySelector('.suggestions');
  if (list) list.remove();
}

function moveActive(list, delta) {
  const items = [...list.querySelectorAll('button')];
  const current = items.findIndex((item) => item.classList.contains('active'));
  const next = (current + delta + items.length + (current === -1 ? 1 : 0)) % items.length;
  items.forEach((item) => item.classList.remove('active'));
  items[next].classList.add('active');
  items[next].scrollIntoView({ block: 'nearest' });
}

function selectPlace(row, place) {
  row.place = place;
  row.input.value = place.short_name;
  row.input.title = place.name;
  row.node.classList.add('resolved');
  refreshControls();
  drawCities();
}

/* ------------------------------------------------------------- drawing ---- */

function drawCities() {
  cityLayer.clearLayers();
  const places = resolvedPlaces();
  places.forEach((place, index) => {
    L.marker([place.lat, place.lon], { icon: cityIcon(index) })
      .bindTooltip(place.short_name, { direction: 'top', offset: [0, -14] })
      .addTo(cityLayer);
  });
  if (!solution && places.length) fitAll();
}

function currentRadius(center, places) {
  const mean = places.reduce((sum, p) => sum + haversine(center, p), 0) / places.length;
  const radius = (mean * Number(el.spread.value)) / 100;
  return Math.max(radius, 250); // keep the circle visible even for near-identical cities
}

function drawSolution() {
  centerLayer.clearLayers();
  if (!solution) return;
  const center = [solution.lat, solution.lon];
  L.circle(center, {
    radius: solution.radius,
    color: '#ff8c42',
    weight: 2,
    fillColor: '#ff8c42',
    fillOpacity: 0.15,
  }).addTo(centerLayer);
  L.circle(center, { radius: solution.radius / 12, color: '#ff8c42', weight: 1, fillOpacity: 0.35 }).addTo(centerLayer);
  L.marker(center, { icon: centerIcon, zIndexOffset: 1000 })
    .bindTooltip('Centre of mass', { direction: 'top', offset: [0, -14] })
    .addTo(centerLayer);
  el.spreadOut.textContent = `r = ${formatDistance(solution.radius)}`;
}

function fitCenter() {
  if (!solution) return;
  // toBounds() is computed from the radius alone, so it works before layout too.
  const bounds = L.latLng(solution.lat, solution.lon).toBounds(solution.radius * 2.4);
  map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
}

function fitAll() {
  const points = resolvedPlaces().map((p) => [p.lat, p.lon]);
  if (solution) points.push([solution.lat, solution.lon]);
  if (!points.length) return;
  map.fitBounds(L.latLngBounds(points), { padding: [70, 70], maxZoom: 13 });
}

function renderResult(places) {
  el.resultCoords.textContent = `${solution.lat.toFixed(5)}, ${solution.lon.toFixed(5)}`;
  el.resultDistances.innerHTML = '';
  places.forEach((place) => {
    const li = document.createElement('li');
    const name = document.createElement('em');
    name.textContent = place.short_name;
    name.style.fontStyle = 'normal';
    const value = document.createElement('span');
    value.textContent = formatDistance(haversine(solution, place));
    li.append(name, value);
    el.resultDistances.appendChild(li);
  });
  el.result.hidden = false;
}

async function describeCenter() {
  el.resultPlace.textContent = 'Locating…';
  try {
    const response = await fetch(`/api/reverse?lat=${solution.lat}&lon=${solution.lon}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'reverse lookup failed');
    el.resultPlace.textContent = data.result ? data.result.name : 'Open water / unnamed area';
  } catch (error) {
    el.resultPlace.textContent = '—';
    setStatus(error.message, true);
  }
}

/* ------------------------------------------------------------- actions ---- */

function findCenter() {
  const places = resolvedPlaces();
  if (places.length < 2) return;
  const center = centerOfMass(places);
  if (!center) {
    setStatus('These cities cancel out exactly — the centre is undefined.', true);
    return;
  }
  solution = { ...center, radius: currentRadius(center, places), cities: places };
  drawSolution();
  renderResult(places);
  fitCenter();
  setStatus('');
  describeCenter();
}

function setStatus(message, isError = false) {
  el.status.textContent = message;
  el.status.classList.toggle('error', Boolean(message) && isError);
}

el.addCity.addEventListener('click', () => addRow().input.focus());
el.find.addEventListener('click', findCenter);
el.zoomCenter.addEventListener('click', fitCenter);
el.zoomAll.addEventListener('click', fitAll);

el.spread.addEventListener('input', () => {
  if (!solution) {
    el.spreadOut.textContent = `${el.spread.value}%`;
    return;
  }
  solution.radius = currentRadius(solution, solution.cities);
  drawSolution();
});

el.spread.addEventListener('change', () => {
  if (solution) fitCenter();
});

/* ------------------------------------------------------------ bootstrap ---- */

async function preload(names) {
  el.cities.innerHTML = '';
  rows.length = 0;
  names.forEach((name) => addRow(name));
  setStatus('Looking up cities…');
  for (const row of rows) {
    await resolveFirstMatch(row); // sequential: the proxy allows one lookup per second
  }
  if (resolvedPlaces().length >= 2) findCenter();
}

const preloadNames = (new URLSearchParams(location.search).get('cities') || '')
  .split('|')
  .map((name) => name.trim())
  .filter(Boolean);

if (preloadNames.length >= 2) {
  preload(preloadNames);
} else {
  preloadNames.forEach((name) => addRow(name));
  while (rows.length < 2) addRow();
  rows[0].input.focus();
}

el.spreadOut.textContent = `${el.spread.value}%`;
