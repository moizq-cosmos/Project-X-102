/**
 * Project X-102 — app.js
 * NASA-IPAC Observational Gateway
 * Real IRSA SIA2 data: spherex_dr1 + spherex_qr3 ONLY (never spherex_qr2)
 */

"use strict";

// ─── API Base ────────────────────────────────────────────────────────────────
// Dynamically resolves backend endpoint across local dev ports, Live Server, and production.
const API_BASE = (() => {
  if (typeof window === "undefined" || !window.location) return "http://127.0.0.1:8000";
  if (window.__API_BASE__) return window.__API_BASE__;
  try {
    const stored = localStorage.getItem("astro_api_base");
    if (stored) return stored;
  } catch (_) {}

  const { protocol, hostname, port } = window.location;
  // Direct file opening or non-http
  if (protocol === "file:" || !protocol.startsWith("http")) return "http://127.0.0.1:8000";

  // Running locally
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    // If running on a static dev port (Live Server 5500, Vite 5173, etc.), target FastAPI on 8000
    if (port && port !== "8000") {
      return `http://${hostname}:8000`;
    }
    return "";
  }

  // Running on Render or remote production host (same origin)
  return "";
})();

// ─── Application State ───────────────────────────────────────────────────────
const state = {
  targetName: "WISE 0855",
  ra: 133.7951,
  dec: -7.2451,
  radiusDeg: 0.05,
  maxFrames: 50,
  selectedBand: "SPHEREx-D3",
  colormap: "inferno",
  sizeArcsec: 100,
  showTracks: true,
  observations: [],
  currentEpochIdx: 0,
  epochA: null,   // { index, obs }
  epochB: null,   // { index, obs }
  blinkInterval: null,
  blinkSpeed: 500,
  imgCacheA: null,  // base64 data_url for P2 diff
  imgCacheB: null,
  errorCounter: 0,
};

// ─── Target Catalog Proper Motions ───────────────────────────────────────────
const TARGET_PROPER_MOTIONS = {
  "barnard's star": {
    pm_ra: -798.58, pm_dec: 10328.12, total: 10359.0, pa: 355.6, ra0: 269.4521, dec0: 4.6934,
    signature: 'High Proper Motion (10.36"/yr)',
    type: "astrometric"
  },
  "barnards star": {
    pm_ra: -798.58, pm_dec: 10328.12, total: 10359.0, pa: 355.6, ra0: 269.4521, dec0: 4.6934,
    signature: 'High Proper Motion (10.36"/yr)',
    type: "astrometric"
  },
  "wise 0855": {
    pm_ra: -8123.7, pm_dec: 673.2, total: 8151.6, pa: 274.7, ra0: 133.7951, dec0: -7.2451,
    signature: 'High Proper Motion (8.15"/yr)',
    type: "astrometric"
  },
  "wise0855": {
    pm_ra: -8123.7, pm_dec: 673.2, total: 8151.6, pa: 274.7, ra0: 133.7951, dec0: -7.2451,
    signature: 'High Proper Motion (8.15"/yr)',
    type: "astrometric"
  },
  "epsilon indi b": {
    pm_ra: 3960.9, pm_dec: -2539.2, total: 4704.0, pa: 122.7, ra0: 331.0771, dec0: -56.7825,
    signature: 'High Proper Motion (4.70"/yr)',
    type: "astrometric"
  },
  "rw aurigae": {
    pm_ra: 4.9, pm_dec: -21.8, total: 22.3, pa: 167.3, ra0: 76.9565, dec0: 30.4014,
    signature: 'Accretion Dipper / Brightness Variable (0.022"/yr proper motion — sub-pixel static position; inspect flux/Diff View for dimming events)',
    type: "photometric"
  },
  "r draconis": {
    pm_ra: -6.2, pm_dec: 12.4, total: 13.9, pa: 333.4, ra0: 248.1633, dec0: 66.7556,
    signature: 'Mira Long-Period Variable (~245d period, 0.014"/yr proper motion — sub-pixel static position; inspect brightness change)',
    type: "photometric"
  },
};

function getTargetProperMotion() {
  const name = (state.targetName || "").trim().toLowerCase();
  for (const [k, v] of Object.entries(TARGET_PROPER_MOTIONS)) {
    if (name.includes(k) || k.includes(name)) return v;
  }
  for (const v of Object.values(TARGET_PROPER_MOTIONS)) {
    if (Math.abs(state.ra - v.ra0) < 0.25 && Math.abs(state.dec - v.dec0) < 0.25) {
      return v;
    }
  }
  return null;
}

function updateTrackingTelemetry(obs) {
  const pm = getTargetProperMotion();
  const firstObs = state.observations && state.observations.length > 0 ? state.observations[0] : obs;
  const currentObs = obs || (state.observations && state.observations.length > 0 ? state.observations[state.currentEpochIdx || 0] : null);
  const mjd = currentObs?.mjd != null ? Number(currentObs.mjd) : 60800.0;
  // Elapsed time since J2000.0 (MJD 51544.5) in years
  const dt_yr = (mjd - 51544.5) / 365.25;

  // Relative shift compared to Epoch 0 in years
  const mjd0 = firstObs?.mjd != null ? Number(firstObs.mjd) : mjd;
  const dt_rel_yr = (mjd - mjd0) / 365.25;

  const ra0 = pm ? pm.ra0 : state.ra;
  const dec0 = pm ? pm.dec0 : state.dec;

  let expRa = ra0;
  let expDec = dec0;
  let totalShiftArcsec = 0.0;
  let pxShift = 0.0;
  let shiftRaRelArcsec = 0.0;
  let shiftDecRelArcsec = 0.0;

  if (pm) {
    const cosDec = Math.cos((dec0 * Math.PI) / 180.0);
    const dRaDeg = cosDec !== 0 ? (pm.pm_ra * dt_yr) / (1000.0 * 3600.0 * cosDec) : 0;
    const dDecDeg = (pm.pm_dec * dt_yr) / (1000.0 * 3600.0);
    expRa = ra0 + dRaDeg;
    expDec = dec0 + dDecDeg;

    shiftRaRelArcsec = (pm.pm_ra * dt_rel_yr) / 1000.0;
    shiftDecRelArcsec = (pm.pm_dec * dt_rel_yr) / 1000.0;
    totalShiftArcsec = Math.abs((pm.total * dt_rel_yr) / 1000.0);
    pxShift = totalShiftArcsec / 6.15; // 6.15 arcsec / pixel for SPHEREx

    setText("track-pa", `PA: ${pm.pa.toFixed(1)}°`);
    setText("track-pm", `μ_α: ${pm.pm_ra >= 0 ? "+" : ""}${pm.pm_ra.toFixed(1)} | μ_δ: ${pm.pm_dec >= 0 ? "+" : ""}${pm.pm_dec.toFixed(1)} mas/yr`);
    setText("track-total", `μ_tot: ${pm.total.toFixed(1)} mas/yr`);
    setText("track-exp-ra", `${expRa.toFixed(5)}°`);
    setText("track-exp-dec", `${expDec >= 0 ? "+" : ""}${expDec.toFixed(5)}°`);
    setText("track-shift-arcsec", `Δθ: ${totalShiftArcsec.toFixed(3)}"`);
    setText("track-shift-px", `Δpx: ${pxShift.toFixed(2)} px`);
  } else {
    setText("track-pa", "PA: —°");
    setText("track-pm", "μ_α: 0.0 | μ_δ: 0.0 mas/yr");
    setText("track-total", "μ_tot: 0.0 mas/yr");
    setText("track-exp-ra", `${state.ra.toFixed(5)}°`);
    setText("track-exp-dec", `${state.dec >= 0 ? "+" : ""}${state.dec.toFixed(5)}°`);
    setText("track-shift-arcsec", "Δθ: 0.000\"");
    setText("track-shift-px", "Δpx: 0.00 px");
  }

  // Update Status Badge and Signature
  const isStationary = pm ? (pm.type === "photometric" || pxShift < 0.05) : false;
  const badgeEl = document.getElementById("track-badge");
  const sigEl = document.getElementById("track-signature");

  if (badgeEl) {
    if (isStationary) {
      badgeEl.className = "track-badge photometric";
      badgeEl.textContent = "Stationary Astrometry (Photometric Variable)";
    } else {
      badgeEl.className = "track-badge astrometric";
      badgeEl.textContent = "High Proper Motion";
    }
  }

  if (sigEl) {
    sigEl.textContent = pm?.signature || "Astrometric coordinate tracking active across observation baseline.";
  }

  // Draw overlay vector and markers
  const overlay = document.getElementById("tracking-overlay");
  const line = document.getElementById("pm-vector-line");
  const epochMarker = document.getElementById("pm-epoch-marker");
  const originMarker = document.getElementById("pm-origin-marker");
  const label = document.getElementById("pm-marker-label");

  if (overlay && state.showTracks) {
    const boxSize = state.sizeArcsec || 100.0;
    const center = 50.0; // SVG viewBox center (50, 50)

    // North-Up (+Dec is UP -> SVG y decreases)
    // East-Left (+RA is LEFT -> SVG x decreases)
    const markerX = center - (shiftRaRelArcsec / boxSize) * 100.0;
    const markerY = center - (shiftDecRelArcsec / boxSize) * 100.0;

    if (isStationary) {
      if (line) line.style.display = "none";
      if (epochMarker) {
        epochMarker.setAttribute("cx", center.toFixed(2));
        epochMarker.setAttribute("cy", center.toFixed(2));
        epochMarker.style.display = "";
      }
      if (originMarker) {
        originMarker.setAttribute("cx", center.toFixed(2));
        originMarker.setAttribute("cy", center.toFixed(2));
        originMarker.style.display = "";
      }
      if (label) {
        label.textContent = "Static (<0.05 px)";
        label.setAttribute("x", "52");
        label.setAttribute("y", "48");
        label.style.display = "";
      }
    } else {
      // Projected 1-year track vector line if target has proper motion
      if (pm && pm.total > 0) {
        const track1yrRaArcsec = pm.pm_ra / 1000.0;
        const track1yrDecArcsec = pm.pm_dec / 1000.0;
        const trackEndX = center - (track1yrRaArcsec / boxSize) * 100.0;
        const trackEndY = center - (track1yrDecArcsec / boxSize) * 100.0;

        if (line) {
          line.setAttribute("x1", center.toFixed(2));
          line.setAttribute("y1", center.toFixed(2));
          line.setAttribute("x2", trackEndX.toFixed(2));
          line.setAttribute("y2", trackEndY.toFixed(2));
          line.style.display = "";
        }
      } else if (line) {
        line.style.display = "none";
      }

      if (epochMarker) {
        epochMarker.setAttribute("cx", markerX.toFixed(2));
        epochMarker.setAttribute("cy", markerY.toFixed(2));
        epochMarker.style.display = "";
      }
      if (originMarker) {
        originMarker.setAttribute("cx", center.toFixed(2));
        originMarker.setAttribute("cy", center.toFixed(2));
        originMarker.style.display = "";
      }
      if (label) {
        if (pm && totalShiftArcsec > 0.01) {
          label.setAttribute("x", (markerX + 2.5).toFixed(2));
          label.setAttribute("y", (markerY - 2.5).toFixed(2));
          label.textContent = `Δθ: ${totalShiftArcsec.toFixed(2)}" (${pxShift.toFixed(1)}px)`;
          label.style.display = "";
        } else {
          label.style.display = "none";
        }
      }
    }
  }
}

// ─── URL Query Parameter Synchronization ──────────────────────────────────────

function parseUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const target = params.get("target");
  const ra = parseFloat(params.get("ra"));
  const dec = parseFloat(params.get("dec"));
  const band = params.get("band");

  if (target) {
    state.targetName = target;
    const targetIn = document.getElementById("target-in");
    if (targetIn) targetIn.value = target;
  }
  if (!isNaN(ra)) state.ra = ra;
  if (!isNaN(dec)) state.dec = dec;
  if (band) {
    state.selectedBand = band;
    const bandSel = document.getElementById("band-sel");
    if (bandSel) bandSel.value = band;
  }
  updateCoordInputs();
}

function syncUrlParams() {
  const params = new URLSearchParams();
  if (state.targetName) params.set("target", state.targetName);
  params.set("ra", state.ra.toFixed(4));
  params.set("dec", state.dec.toFixed(4));
  if (state.selectedBand) params.set("band", state.selectedBand);

  const newUrl = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState({}, "", newUrl);
}

function getVisibleObservations() {
  if (!state.selectedBand || state.selectedBand === "ALL") {
    return state.observations;
  }
  const filtered = state.observations.filter(o => o.wavelength_band === state.selectedBand);
  return filtered.length > 0 ? filtered : state.observations;
}

// ─── Error Banners ────────────────────────────────────────────────────────────

function showErrorBanner(statusCode, message, endpoint) {
  const errs = document.getElementById("errs");
  const id = `err-${++state.errorCounter}`;
  const cls = statusCode === 504 ? "t504" : statusCode === 502 ? "t502" : statusCode === 422 ? "t422" : "t0";

  const banner = document.createElement("div");
  banner.className = `err-banner ${cls}`;
  banner.id = id;
  banner.innerHTML = `
    <span class="err-code">${statusCode || "ERR"}</span>
    <span class="err-endpoint">${endpoint || ""}</span>
    <span class="err-msg">${escHtml(message || "Unknown error")}</span>
    <button class="err-dismiss" onclick="dismissBanner('${id}')">✕</button>
  `;
  errs.appendChild(banner);

  // Auto-dismiss after 12s
  setTimeout(() => dismissBanner(id), 12000);
}

function dismissBanner(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Generic Fetch Wrapper ────────────────────────────────────────────────────

async function apiFetch(url, options = {}) {
  const fetchOpts = { ...options };
  if (fetchOpts.signal && !(fetchOpts.signal instanceof AbortSignal)) {
    delete fetchOpts.signal;
  }
  let resp;
  try {
    resp = await fetch(url, fetchOpts);
  } catch (netErr) {
    if (netErr.name === "AbortError" || fetchOpts.signal?.aborted) {
      throw netErr;
    }
    showErrorBanner(0, `Network error: ${netErr.message}`, url.replace(API_BASE, ""));
    throw netErr;
  }

  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const json = await resp.json();
      detail = json.detail || json.message || JSON.stringify(json);
    } catch (_) {}
    if (resp.status !== 422) {
      showErrorBanner(resp.status, detail, url.replace(API_BASE, ""));
    }
    const err = new Error(detail);
    err.status = resp.status;
    throw err;
  }
  return resp;
}

// ─── Health Probe ─────────────────────────────────────────────────────────────

async function probeHealth() {
  const dot = document.getElementById("dot");
  const txt = document.getElementById("status-txt");
  if (!dot || !txt) return;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(`${API_BASE}/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    dot.className = "dot online";
    txt.textContent = "Online: Project X-102 (DR1 & QR3)";
  } catch (err) {
    console.warn("Health probe notice:", err);
    dot.className = "dot offline";
    if (err.name === "AbortError") {
      txt.textContent = "API Connecting (Waking up...)";
    } else {
      txt.textContent = "API Offline (Check port 8000)";
    }
  }
}

// ─── Query Controller & Observation Loader ───────────────────────────────────

let queryAbortController = null;

async function runQuery() {
  if (queryAbortController) {
    queryAbortController.abort();
  }
  queryAbortController = new AbortController();
  const signal = queryAbortController.signal;

  const queryRa = state.ra;
  const queryDec = state.dec;
  const { radiusDeg, maxFrames } = state;
  const url = `${API_BASE}/observations?ra=${queryRa}&dec=${queryDec}&radius_deg=${radiusDeg}&max_frames=${maxFrames}`;

  setLoadingState(true);

  try {
    const resp = await apiFetch(url, { signal });
    const data = await resp.json();

    if (signal.aborted) return;

    // Scope query coordinates directly onto each observation record
    const rawObs = Array.isArray(data.observations) ? data.observations : [];
    state.observations = rawObs.map(obs => ({
      ...obs,
      ra: obs.ra != null ? Number(obs.ra) : queryRa,
      dec: obs.dec != null ? Number(obs.dec) : queryDec,
    }));

    updateObsStats(data);

    if (state.observations.length === 0) {
      showEmpty(true);
    } else {
      showEmpty(false);
      renderTimeline();
      renderTable();
      autoSelectDefaultEpochs();
      await loadEpoch(0, signal);
      const activeTab = document.querySelector(".tab-btn.active")?.dataset.tab;
      if (activeTab === "compare" || activeTab === "diff") {
        await loadComparison(signal);
        if (activeTab === "diff") await computeDiff(signal);
      }
    }
    syncUrlParams();
  } catch (err) {
    if (err.name === "AbortError" || signal.aborted) {
      return;
    }
    showEmpty(true);
  } finally {
    if (!signal.aborted) {
      setLoadingState(false);
    }
  }
}

// Backward-compatible alias
const loadObservations = runQuery;

function setLoadingState(loading) {
  const btn = document.getElementById("btn-resolve");
  if (btn) btn.disabled = loading;
}

function showEmpty(isEmpty) {
  const emptyEl = document.getElementById("empty-state");
  const dashboard = document.getElementById("dashboard");
  const statsEl = document.getElementById("obs-stats");

  if (isEmpty) {
    emptyEl.style.display = "";
    dashboard.style.display = "none";
    if (state.observations.length === 0) statsEl.style.display = "none";
  } else {
    emptyEl.style.display = "none";
    dashboard.style.display = "";
    statsEl.style.display = "";
  }
}

// ─── Unified Baseline Span Calculation ─────────────────────────────────────────
function computeObservationsBaselineDays(obsArray) {
  const list = obsArray || state.observations || [];
  if (!Array.isArray(list) || list.length < 2) return 0.0;
  const mjds = list.map(o => Number(o.mjd)).filter(m => !isNaN(m) && m > 0);
  if (mjds.length < 2) return 0.0;
  const minMjd = Math.min(...mjds);
  const maxMjd = Math.max(...mjds);
  return parseFloat((maxMjd - minMjd).toFixed(2));
}

function updateObsStats(data) {
  const obs = state.observations;
  const dr1Count = obs.filter(o => o.collection === "spherex_dr1").length;
  const qr3Count = obs.filter(o => o.collection === "spherex_qr3").length;
  const baselineDays = computeObservationsBaselineDays(obs);
  state.baselineDays = baselineDays;

  setText("stat-total", `${obs.length} observations`);
  setText("stat-dr1", `DR1: ${dr1Count}`);
  setText("stat-qr3", `QR3: ${qr3Count}`);
  setText("stat-status", `Baseline: ${baselineDays} days`);

  const cachedEl = document.getElementById("stat-cached");
  if (cachedEl) {
    cachedEl.style.display = data.cached ? "" : "none";
  }

  const btnZip = document.getElementById("btn-download-zip");
  if (btnZip) btnZip.disabled = obs.length === 0;
  const btnZipTab = document.getElementById("btn-download-zip-tab");
  if (btnZipTab) btnZipTab.disabled = obs.length === 0;
}

// ─── Timeline Scrubber (P0) ───────────────────────────────────────────────────

function renderTimeline() {
  const container = document.getElementById("timeline-epochs");
  container.innerHTML = "";

  const visible = getVisibleObservations();
  visible.forEach((obs, i) => {
    const tick = document.createElement("div");
    tick.className = `epoch-tick ${obs.collection === "spherex_dr1" ? "dr1" : "qr3"}`;
    tick.title = `${obs.obs_date || obs.mjd || "?"} | ${obs.wavelength_band || "?"} | ${obs.collection}`;
    tick.addEventListener("click", () => loadEpoch(i));
    container.appendChild(tick);
  });

  updateEpochCounter(0);
}

function setActiveEpoch(idx) {
  const ticks = document.querySelectorAll(".epoch-tick");
  ticks.forEach((t, i) => t.classList.toggle("active", i === idx));
  updateEpochCounter(idx);
}

function updateEpochCounter(idx) {
  const n = getVisibleObservations().length;
  setText("epoch-counter", n > 0 ? `Epoch ${idx + 1} of ${n}` : "Epoch — of —");
}

// ─── Load & Display a Single Epoch ───────────────────────────────────────────

async function loadEpoch(idx, signal = null) {
  const visible = getVisibleObservations();
  const obs = visible[idx];
  if (!obs) return;

  state.currentEpochIdx = idx;
  setActiveEpoch(idx);
  updateMetaPills(obs);
  updateTrackingTelemetry(obs);
  highlightTableRow(idx);
  await loadCutout(obs, signal);
}

function updateMetaPills(obs) {
  if (!obs) return;
  setText("pill-obs-id", `obs_id: ${obs.obs_id || "—"}`);
  setText("pill-date", `date: ${obs.obs_date || obs.mjd || "—"}`);
  setText("pill-band", `band: ${obs.wavelength_band || "—"}`);
  setText("pill-coll", `collection: ${obs.collection || "—"}`);
  const wlMin = obs.em_min_um != null ? obs.em_min_um.toFixed(4) : "—";
  const wlMax = obs.em_max_um != null ? obs.em_max_um.toFixed(4) : "—";
  setText("pill-wl", `λ: ${wlMin}–${wlMax} μm`);
}

// ─── Cutout In-Memory Cache & Silent Prefetch ──────────────────────────────────
const cutoutClientCache = new Map();

function prefetchEpochCutouts(currentIdx) {
  const visible = getVisibleObservations();
  if (!visible || visible.length <= 1) return;

  const nextIndices = [currentIdx + 1, currentIdx + 2];
  for (const nextIdx of nextIndices) {
    if (nextIdx >= visible.length) continue;
    const nextObs = visible[nextIdx];
    if (!nextObs || !nextObs.access_url) continue;

    const targetRa = nextObs.ra != null ? nextObs.ra : state.ra;
    const targetDec = nextObs.dec != null ? nextObs.dec : state.dec;
    const cacheKey = `${nextObs.access_url}:${targetRa}:${targetDec}:${state.sizeArcsec}:${state.colormap}`;
    if (cutoutClientCache.has(cacheKey)) continue;

    const params = new URLSearchParams({
      access_url: nextObs.access_url,
      obs_id: nextObs.obs_id || "",
      ra: targetRa,
      dec: targetDec,
      size_arcsec: state.sizeArcsec,
      colormap: state.colormap,
    });

    fetch(`${API_BASE}/cutout?${params}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.data_url) {
          cutoutClientCache.set(cacheKey, data);
          const preloadImg = new Image();
          preloadImg.src = data.data_url;
        }
      })
      .catch(() => {});
  }
}

async function loadCutout(obs, signalOrEvent = null) {
  const img = document.getElementById("cutout-img");
  if (!obs || !obs.access_url) {
    if (img) img.removeAttribute("src");
    return;
  }

  const signal = (signalOrEvent instanceof AbortSignal)
    ? signalOrEvent
    : (queryAbortController?.signal instanceof AbortSignal ? queryAbortController.signal : undefined);

  // Use scoped coordinates directly from obs to prevent target-mismatch race condition
  const targetRa = obs.ra != null ? obs.ra : state.ra;
  const targetDec = obs.dec != null ? obs.dec : state.dec;
  const cacheKey = `${obs.access_url}:${targetRa}:${targetDec}:${state.sizeArcsec}:${state.colormap}`;

  const cachedData = cutoutClientCache.get(cacheKey);
  if (cachedData && cachedData.data_url) {
    img.src = cachedData.data_url;
    img.style.opacity = "1";
    const loader = document.getElementById("img-loader");
    if (loader) loader.classList.add("hidden");
    state.errorCounter = 0;
    prefetchEpochCutouts(state.currentEpochIdx);
    return;
  }

  const loader = document.getElementById("img-loader");
  if (loader) loader.classList.remove("hidden");
  img.style.opacity = "0.3";

  const params = new URLSearchParams({
    access_url: obs.access_url,
    obs_id: obs.obs_id || "",
    ra: targetRa,
    dec: targetDec,
    size_arcsec: state.sizeArcsec,
    colormap: state.colormap,
  });

  const timeoutCtrl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtrl.abort(), 6000);
  const effectiveSignal = signal
    ? (AbortSignal.any ? AbortSignal.any([signal, timeoutCtrl.signal]) : signal)
    : timeoutCtrl.signal;

  try {
    const resp = await apiFetch(`${API_BASE}/cutout?${params}`, { signal: effectiveSignal });
    const data = await resp.json();
    if (data.data_url) {
      cutoutClientCache.set(cacheKey, data);
      img.src = data.data_url;
      img.style.opacity = "1";
      prefetchEpochCutouts(state.currentEpochIdx);
    } else {
      img.removeAttribute("src");
      img.style.opacity = "1";
    }
  } catch (err) {
    if (err.name === "AbortError" || (signal && signal.aborted)) {
      return;
    }
    if (err.status === 422) {
      console.warn("Cutout 422 (edge-clipped), displaying notice...");
      if (img) img.removeAttribute("src");
      setText("pill-obs-id", `obs_id: ${obs.obs_id || "—"} (Edge-Clipped)`);
      if (state.blinkInterval) {
        const visible = getVisibleObservations();
        if (visible.length > 1) {
          const next = (state.currentEpochIdx + 1) % visible.length;
          loadEpoch(next, signal);
        }
      }
      return;
    }
    img.removeAttribute("src");
    img.style.opacity = "1";
  } finally {
    clearTimeout(timeoutId);
    if (loader) {
      loader.classList.add("hidden");
    }
  }
}

// ─── Blink Player Controls (P0) ───────────────────────────────────────────────

function startBlink() {
  if (state.blinkInterval) return;
  const visible = getVisibleObservations();
  const n = visible.length;
  if (n < 2) return;

  state.blinkInterval = setInterval(() => {
    const next = (state.currentEpochIdx + 1) % n;
    loadEpoch(next);
  }, state.blinkSpeed);

  setText("btn-play", "⏸ Pause");
}

function stopBlink() {
  if (state.blinkInterval) {
    clearInterval(state.blinkInterval);
    state.blinkInterval = null;
  }
  setText("btn-play", "▶ Play");
}

function toggleBlink() {
  if (state.blinkInterval) {
    stopBlink();
  } else {
    startBlink();
  }
}

// ─── Observation Table ─────────────────────────────────────────────────────────

function renderTable() {
  const tbody = document.getElementById("obs-tbody");
  tbody.innerHTML = "";

  const visible = getVisibleObservations();
  visible.forEach((obs, i) => {
    const tr = document.createElement("tr");
    tr.id = `obs-row-${i}`;
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td style="text-align:center;white-space:nowrap">
        <button class="btn-epoch-sel btn-sel-a" data-idx="${i}" title="Set as Epoch A">[A]</button>
        <button class="btn-epoch-sel btn-sel-b" data-idx="${i}" title="Set as Epoch B">[B]</button>
      </td>
      <td>${obs.obs_date || "—"}</td>
      <td>${obs.mjd != null ? Number(obs.mjd).toFixed(3) : "—"}</td>
      <td><span class="coll-badge ${obs.collection === "spherex_dr1" ? "dr1" : "qr3"}">${obs.collection || "—"}</span></td>
      <td>${obs.wavelength_band || "—"}</td>
      <td>${obs.em_min_um != null ? obs.em_min_um.toFixed(4) : "—"}</td>
      <td>${obs.detector || "—"}</td>
      <td>${obs.ra != null ? Number(obs.ra).toFixed(4) : "—"}</td>
      <td>${obs.dec != null ? Number(obs.dec).toFixed(4) : "—"}</td>
    `;

    // Row normal click: preview cutout in main viewer
    // Shift+Click: toggle Epoch A/B selection
    tr.addEventListener("click", (e) => {
      if (e.shiftKey) {
        e.preventDefault();
        toggleEpochAB(i);
      } else {
        loadEpoch(i);
      }
    });

    // Right-click: toggle Epoch A/B selection
    tr.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      toggleEpochAB(i);
    });

    // Explicit [A] button click
    const btnA = tr.querySelector(".btn-sel-a");
    if (btnA) {
      btnA.addEventListener("click", (e) => {
        e.stopPropagation();
        setAsEpochA(i);
      });
    }

    // Explicit [B] button click
    const btnB = tr.querySelector(".btn-sel-b");
    if (btnB) {
      btnB.addEventListener("click", (e) => {
        e.stopPropagation();
        setAsEpochB(i);
      });
    }

    tr.title = "Click to preview cutout • Shift+Click / Right-Click / [A] [B] buttons to select comparison epochs";
    tbody.appendChild(tr);
  });

  highlightEpochAB();
}

function highlightTableRow(idx) {
  document.querySelectorAll("#obs-tbody tr").forEach((tr, i) => {
    tr.classList.remove("active-row");
    if (i === idx) tr.classList.add("active-row");
  });
}

// ─── Default Epoch Auto-Selection ─────────────────────────────────────────────

function autoSelectDefaultEpochs() {
  const visible = getVisibleObservations();
  if (!visible || visible.length === 0) {
    state.epochA = null;
    state.epochB = null;
    highlightEpochAB();
    updateCompareLabels();
    setButtonStates();
    return;
  }

  // 1. Default Epoch A: first observation (earliest visit)
  state.epochA = { index: 0, obs: visible[0] };

  // 2. Default Epoch B: latest compatible observation in the same spectral band
  const bandA = visible[0].wavelength_band;
  let bIdx = -1;

  for (let i = visible.length - 1; i > 0; i--) {
    if (visible[i].wavelength_band === bandA) {
      bIdx = i;
      break;
    }
  }

  if (bIdx === -1 && visible.length > 1) {
    bIdx = visible.length - 1;
  }

  if (bIdx !== -1 && bIdx !== 0) {
    state.epochB = { index: bIdx, obs: visible[bIdx] };
  } else {
    state.epochB = null;
  }

  state.imgCacheA = null;
  state.imgCacheB = null;
  highlightEpochAB();
  updateCompareLabels();
  setButtonStates();
}

// ─── Epoch A/B Selection Controls ─────────────────────────────────────────────

function setAsEpochA(idx) {
  const obs = getVisibleObservations()[idx];
  if (!obs) return;

  if (state.epochA && state.epochA.index === idx) {
    state.epochA = null;
  } else {
    state.epochA = { index: idx, obs };
    if (state.epochB && state.epochB.index === idx) {
      state.epochB = null;
    }
  }

  state.imgCacheA = null;
  highlightEpochAB();
  updateCompareLabels();
  setButtonStates();
  onEpochSelectionChanged();
}

function setAsEpochB(idx) {
  const obs = getVisibleObservations()[idx];
  if (!obs) return;

  if (state.epochB && state.epochB.index === idx) {
    state.epochB = null;
  } else {
    state.epochB = { index: idx, obs };
    if (state.epochA && state.epochA.index === idx) {
      state.epochA = null;
    }
  }

  state.imgCacheB = null;
  highlightEpochAB();
  updateCompareLabels();
  setButtonStates();
  onEpochSelectionChanged();
}

function toggleEpochAB(idx) {
  const obs = getVisibleObservations()[idx];
  if (!obs) return;

  if (!state.epochA) {
    // Set A first
    state.epochA = { index: idx, obs };
    if (state.epochB && state.epochB.index === idx) {
      state.epochB = null;
    }
  } else if (!state.epochB) {
    // A is already set, B is not
    if (state.epochA.index === idx) {
      state.epochA = null;
    } else {
      state.epochB = { index: idx, obs };
    }
  } else {
    // Both A and B are currently set
    if (state.epochA.index === idx) {
      state.epochA = null;
    } else if (state.epochB.index === idx) {
      state.epochB = null;
    } else {
      // Toggle cycle: set A to the new epoch and clear B
      state.epochA = { index: idx, obs };
      state.epochB = null;
    }
  }

  state.imgCacheA = null;
  state.imgCacheB = null;
  highlightEpochAB();
  updateCompareLabels();
  setButtonStates();
  onEpochSelectionChanged();
}

function highlightEpochAB() {
  document.querySelectorAll("#obs-tbody tr").forEach((tr, i) => {
    tr.classList.remove("selected-a", "selected-b");
    if (state.epochA && state.epochA.index === i) tr.classList.add("selected-a");
    if (state.epochB && state.epochB.index === i) tr.classList.add("selected-b");
  });

  document.querySelectorAll(".btn-sel-a").forEach(btn => {
    const idx = parseInt(btn.dataset.idx, 10);
    btn.classList.toggle("active", Boolean(state.epochA && state.epochA.index === idx));
  });

  document.querySelectorAll(".btn-sel-b").forEach(btn => {
    const idx = parseInt(btn.dataset.idx, 10);
    btn.classList.toggle("active", Boolean(state.epochB && state.epochB.index === idx));
  });
}

function updateCompareLabels() {
  const aLabel = document.getElementById("cmp-a-label");
  const bLabel = document.getElementById("cmp-b-label");
  if (aLabel) aLabel.textContent = state.epochA ? `#${state.epochA.index + 1} — ${state.epochA.obs.obs_date || state.epochA.obs.mjd || "?"}` : "Not selected";
  if (bLabel) bLabel.textContent = state.epochB ? `#${state.epochB.index + 1} — ${state.epochB.obs.obs_date || state.epochB.obs.mjd || "?"}` : "Not selected";
}

function setButtonStates() {
  const bothSelected = Boolean(state.epochA && state.epochB);
  const btnCmp = document.getElementById("btn-load-compare");
  const btnDiff = document.getElementById("btn-compute-diff");
  if (btnCmp) btnCmp.disabled = !bothSelected;
  if (btnDiff) btnDiff.disabled = !bothSelected;
}

function onEpochSelectionChanged() {
  const activeTab = document.querySelector(".tab-btn.active")?.dataset.tab;
  const imgA = document.getElementById("cmp-img-a");
  const imgB = document.getElementById("cmp-img-b");
  const phA = document.getElementById("cmp-placeholder-a");
  const phB = document.getElementById("cmp-placeholder-b");

  if (!state.epochA || !state.epochB) {
    if (imgA) imgA.removeAttribute("src");
    if (imgB) imgB.removeAttribute("src");
    if (phA) {
      phA.style.display = "";
      phA.textContent = "Click Load Comparison to display cutout";
    }
    if (phB) {
      phB.style.display = "";
      phB.textContent = "Click Load Comparison to display cutout";
    }
    const diffCanvas = document.getElementById("diff-canvas");
    if (diffCanvas) {
      const ctx = diffCanvas.getContext("2d");
      ctx.clearRect(0, 0, diffCanvas.width, diffCanvas.height);
    }
    const diffPh = document.getElementById("diff-placeholder");
    if (diffPh) {
      diffPh.style.display = "";
      diffPh.textContent = "Select Epoch A & B in the comparison tab first.";
    }
    const banner = document.getElementById("diff-candidate-banner");
    if (banner) banner.style.display = "none";
    const statusEl = document.getElementById("diff-status");
    if (statusEl) statusEl.textContent = "";
  } else if (activeTab === "compare" || activeTab === "diff") {
    loadComparison().then(() => {
      if (activeTab === "diff") computeDiff();
    });
  }
}

// ─── P1: Side-by-Side Comparison ──────────────────────────────────────────────

async function loadComparison(signalOrEvent = null) {
  if (!state.epochA || !state.epochB) return;

  const signal = (signalOrEvent instanceof AbortSignal)
    ? signalOrEvent
    : (queryAbortController?.signal instanceof AbortSignal ? queryAbortController.signal : undefined);

  const imgA = document.getElementById("cmp-img-a");
  const imgB = document.getElementById("cmp-img-b");
  const phA = document.getElementById("cmp-placeholder-a");
  const phB = document.getElementById("cmp-placeholder-b");
  const metaA = document.getElementById("cmp-meta-a");
  const metaB = document.getElementById("cmp-meta-b");
  const btnCmp = document.getElementById("btn-load-compare");

  if (btnCmp) btnCmp.disabled = true;

  // Show loading in placeholders and remove image src so no broken image appears
  if (phA) {
    phA.style.display = "";
    phA.textContent = "Loading Epoch A cutout…";
  }
  if (phB) {
    phB.style.display = "";
    phB.textContent = "Loading Epoch B cutout…";
  }
  if (imgA) imgA.removeAttribute("src");
  if (imgB) imgB.removeAttribute("src");

  async function fetchCutoutDataUrl(obs) {
    if (!obs || !obs.access_url) return null;
    const targetRa = obs.ra != null ? obs.ra : state.ra;
    const targetDec = obs.dec != null ? obs.dec : state.dec;
    const cacheKey = `${obs.access_url}:${targetRa}:${targetDec}:${state.sizeArcsec}:${state.colormap}`;
    const cachedData = cutoutClientCache.get(cacheKey);
    if (cachedData?.data_url) return cachedData.data_url;

    const params = new URLSearchParams({
      access_url: obs.access_url,
      obs_id: obs.obs_id || "",
      ra: targetRa,
      dec: targetDec,
      size_arcsec: state.sizeArcsec,
      colormap: state.colormap,
    });
    try {
      const resp = await apiFetch(`${API_BASE}/cutout?${params}`, { signal });
      const data = await resp.json();
      if (data?.data_url) {
        cutoutClientCache.set(cacheKey, data);
      }
      return data.data_url || null;
    } catch (_) {
      return null;
    }
  }

  const [urlA, urlB] = await Promise.all([
    fetchCutoutDataUrl(state.epochA.obs),
    fetchCutoutDataUrl(state.epochB.obs),
  ]);

  if (urlA) {
    if (imgA) {
      imgA.crossOrigin = "anonymous";
      imgA.src = urlA;
    }
    state.imgCacheA = urlA;
    if (phA) phA.style.display = "none";
  } else {
    if (imgA) imgA.removeAttribute("src");
    if (phA) {
      phA.style.display = "";
      phA.textContent = "Epoch A cutout unavailable";
    }
  }

  if (urlB) {
    if (imgB) {
      imgB.crossOrigin = "anonymous";
      imgB.src = urlB;
    }
    state.imgCacheB = urlB;
    if (phB) phB.style.display = "none";
  } else {
    if (imgB) imgB.removeAttribute("src");
    if (phB) {
      phB.style.display = "";
      phB.textContent = "Epoch B cutout unavailable";
    }
  }

  renderMetaCard(metaA, state.epochA.obs, "Epoch A Metadata", "#34d399");
  renderMetaCard(metaB, state.epochB.obs, "Epoch B Metadata", "#f472b6");

  setButtonStates();
}

function renderMetaCard(container, obs, title, color) {
  if (!container || !obs) return;
  const fields = [
    ["obs_id", obs.obs_id],
    ["date", obs.obs_date || "—"],
    ["mjd", obs.mjd != null ? Number(obs.mjd).toFixed(3) : "—"],
    ["collection", obs.collection],
    ["band", obs.wavelength_band],
    ["λ min", obs.em_min_um != null ? `${obs.em_min_um.toFixed(4)} μm` : "—"],
    ["λ max", obs.em_max_um != null ? `${obs.em_max_um.toFixed(4)} μm` : "—"],
    ["detector", obs.detector || "—"],
    ["calib_level", obs.calib_level ?? "—"],
    ["quality", obs.quality_flags || "—"],
  ];

  container.innerHTML = `<div style="color:${color};font-weight:700;margin-bottom:6px;">${title}</div>` +
    fields.map(([k, v]) => `<div class="meta-row"><span class="meta-key">${k}</span><span class="meta-val">${escHtml(String(v ?? "—"))}</span></div>`).join("");
}

// ─── P2: Difference View ──────────────────────────────────────────────────────

function loadHtmlImage(src) {
  return new Promise((resolve, reject) => {
    if (!src) {
      return reject(new Error("Image data URL is missing"));
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (typeof img.decode === "function") {
        img.decode().then(() => resolve(img)).catch(() => resolve(img));
      } else {
        resolve(img);
      }
    };
    img.onerror = () => reject(new Error("Failed to decode cutout image"));
    img.src = src;
  });
}

// ─── Diff Computation (P2) ───────────────────────────────────────────────────
const diffClientCache = new Map();

async function computeDiff(signalOrEvent = null, forceRefresh = false) {
  if (!state.epochA || !state.epochB) {
    if (state.observations && state.observations.length > 0) {
      autoSelectDefaultEpochs();
    }
  }
  if (!state.epochA || !state.epochB) return;

  const signal = (signalOrEvent instanceof AbortSignal)
    ? signalOrEvent
    : (queryAbortController?.signal instanceof AbortSignal ? queryAbortController.signal : undefined);

  const statusEl = document.getElementById("diff-status");
  const bannerEl = document.getElementById("diff-candidate-banner");
  const canvas = document.getElementById("diff-canvas");
  const placeholder = document.getElementById("diff-placeholder");
  const btnDiff = document.getElementById("btn-compute-diff");
  const ctx = canvas.getContext("2d");

  const obsA = state.epochA.obs;
  const obsB = state.epochB.obs;

  const diffCacheKey = `${obsA.obs_id || "a"}:${obsB.obs_id || "b"}:${state.sizeArcsec}`;

  // Instant cache hit: render immediately without network request or spinner
  if (!forceRefresh && diffClientCache.has(diffCacheKey)) {
    const cached = diffClientCache.get(diffCacheKey);
    try {
      const img = await loadHtmlImage(cached.imgDataUrl);
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      if (placeholder) placeholder.style.display = "none";
      if (cached.maxDelta >= 2.0 || cached.rms >= 0.5) {
        bannerEl.style.display = "";
        statusEl.textContent = `Candidate for human review — not a confirmed discovery (RMS: ${cached.rms.toFixed(4)} DN, Peak Δ: ${cached.maxDelta.toFixed(4)} DN)`;
      } else {
        bannerEl.style.display = "none";
        statusEl.textContent = `Baseline aligned (RMS: ${cached.rms.toFixed(4)} DN) — Candidate residuals highlighted`;
      }
      setButtonStates();
      return;
    } catch (_) {}
  }

  if (btnDiff) btnDiff.disabled = true;
  statusEl.textContent = "Computing backend calibrated float32 FITS difference…";
  bannerEl.style.display = "none";
  if (placeholder) {
    placeholder.style.display = "";
    placeholder.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-dim);gap:12px;"><div class="loader-inner" style="width:36px;height:36px;border:3px solid rgba(0,217,255,0.2);border-top-color:var(--accent,#00d9ff);border-radius:50%;animation:spin 0.8s linear infinite;"></div><div>Computing backend calibrated float32 FITS difference…</div></div>';
  }

  const targetRa = obsA.ra != null ? obsA.ra : (obsB.ra != null ? obsB.ra : state.ra);
  const targetDec = obsA.dec != null ? obsA.dec : (obsB.dec != null ? obsB.dec : state.dec);

  const params = new URLSearchParams({
    obs_id_a: obsA.obs_id || "",
    obs_id_b: obsB.obs_id || "",
    ra: targetRa,
    dec: targetDec,
    size_arcsec: state.sizeArcsec,
  });
  if (obsA.access_url) params.set("access_url_a", obsA.access_url);
  if (obsB.access_url) params.set("access_url_b", obsB.access_url);

  const timeoutCtrl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtrl.abort(), 10000);
  const effectiveSignal = signal
    ? (AbortSignal.any ? AbortSignal.any([signal, timeoutCtrl.signal]) : signal)
    : timeoutCtrl.signal;

  try {
    const resp = await apiFetch(`${API_BASE}/diff?${params}`, { signal: effectiveSignal });
    const data = await resp.json();

    const imgDataUrl = data.data_url || (data.image_base64 ? `data:image/png;base64,${data.image_base64}` : null);
    if (!imgDataUrl) {
      throw new Error("No image data returned from /diff endpoint.");
    }

    const img = await loadHtmlImage(imgDataUrl);
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    if (placeholder) placeholder.style.display = "none";

    const rms = data.rms_dn != null ? Number(data.rms_dn) : 0.0;
    const maxDelta = data.max_delta != null ? Number(data.max_delta) : 0.0;

    diffClientCache.set(diffCacheKey, {
      imgDataUrl,
      rms,
      maxDelta,
    });

    if (maxDelta >= 2.0 || rms >= 0.5) {
      bannerEl.style.display = "";
      statusEl.textContent = `Candidate for human review — not a confirmed discovery (RMS: ${rms.toFixed(4)} DN, Peak Δ: ${maxDelta.toFixed(4)} DN)`;
    } else {
      bannerEl.style.display = "none";
      statusEl.textContent = `Baseline aligned (RMS: ${rms.toFixed(4)} DN) — Candidate residuals highlighted`;
    }

  } catch (err) {
    const isAbort = err.name === "AbortError" || (signal && signal.aborted);
    statusEl.textContent = isAbort ? "Diff computation timed out. Click to retry." : `Diff error: ${err.message}`;
    if (placeholder) {
      placeholder.style.display = "";
      placeholder.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-dim);gap:8px;"><div style="color:var(--accent,#00d9ff);font-weight:600;">${isAbort ? "Diff Request Timed Out" : "Diff Error"}</div><div style="font-size:12px;">${isAbort ? "Upstream archive was slow. Click below to retry instantly." : escapeHtml(err.message)}</div><button class="btn-sm" id="btn-diff-retry" style="margin-top:6px;cursor:pointer;">↻ Retry Diff</button></div>`;
      const retryBtn = document.getElementById("btn-diff-retry");
      if (retryBtn) retryBtn.onclick = () => computeDiff(null, true);
    }
  } finally {
    clearTimeout(timeoutId);
    setButtonStates();
    if (btnDiff) btnDiff.disabled = false;
  }
}

// ─── Tab Switching ─────────────────────────────────────────────────────────────

async function switchTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-pane").forEach(pane => {
    pane.classList.toggle("active", pane.id === `tab-${tabId}`);
  });

  // Automatically trigger comparison / diff whenever user switches tabs
  if (tabId === "compare") {
    if (!state.epochA || !state.epochB) {
      if (state.observations && state.observations.length > 0) {
        autoSelectDefaultEpochs();
      }
    }
    if (state.epochA && state.epochB) {
      await loadComparison();
    }
  } else if (tabId === "diff") {
    if (!state.epochA || !state.epochB) {
      if (state.observations && state.observations.length > 0) {
        autoSelectDefaultEpochs();
      }
    }
    if (state.epochA && state.epochB) {
      await computeDiff();
    }
  }
}

// ─── Target Resolution ────────────────────────────────────────────────────────

async function resolveTarget(nameOrCoords) {
  nameOrCoords = (nameOrCoords || "").trim();
  if (!nameOrCoords) return;

  state.targetName = nameOrCoords;

  // Try parsing as "RA,Dec" directly
  const direct = nameOrCoords.match(/^([+-]?\d+\.?\d*)\s*,\s*([+-]?\d+\.?\d*)$/);
  if (direct) {
    state.ra = parseFloat(direct[1]);
    state.dec = parseFloat(direct[2]);
    updateCoordInputs();
    syncUrlParams();
    await loadObservations();
    return;
  }

  // Try fetching from /telemetry?target=NAME for known targets
  try {
    const resp = await apiFetch(`${API_BASE}/telemetry?target=${encodeURIComponent(nameOrCoords)}`);
    const data = await resp.json();
    if (data.ra != null && data.dec != null) {
      state.ra = data.ra;
      state.dec = data.dec;
      updateCoordInputs();
      syncUrlParams();
      await loadObservations();
      return;
    }
  } catch (_) {}

  // Fall back to treating as free-form — just reuse current coords
  syncUrlParams();
  await loadObservations();
}

function updateCoordInputs() {
  const raIn = document.getElementById("ra-in");
  const decIn = document.getElementById("dec-in");
  if (raIn) raIn.value = state.ra;
  if (decIn) decIn.value = state.dec;
}

// ─── Export Multi-Epoch Archive (.ZIP) ────────────────────────────────────────

async function downloadEpochsZip() {
  const btn = document.getElementById("btn-download-zip");
  const btnTab = document.getElementById("btn-download-zip-tab");
  const buttons = [btn, btnTab].filter(Boolean);

  const originalTexts = buttons.map(b => b.innerHTML);
  buttons.forEach(b => {
    b.disabled = true;
    b.innerHTML = `<span class="spinner-inline" style="display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:4px"></span> Packaging ZIP...`;
  });

  try {
    const params = new URLSearchParams({
      ra: state.ra.toFixed(4),
      dec: state.dec.toFixed(4),
      radius: state.radiusDeg || 0.05,
      max_frames: state.maxFrames || 50,
      colormap: state.colormap || "inferno",
      size_arcsec: state.sizeArcsec || 100,
    });
    if (state.targetName) {
      params.set("target", state.targetName);
    }
    if (state.selectedBand && state.selectedBand !== "ALL") {
      params.set("band", state.selectedBand);
    }

    const exportUrl = `${API_BASE}/export-zip?${params.toString()}`;

    const response = await fetch(exportUrl);
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const errJson = await response.json();
        detail = errJson.detail || detail;
      } catch (_) {}
      throw new Error(detail);
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;

    const disposition = response.headers.get("Content-Disposition");
    let filename = `SPHEREx_${(state.targetName || "field").replace(/[^a-zA-Z0-9_\-]+/g, "_")}_epochs.zip`;
    if (disposition && disposition.includes("filename=")) {
      const match = disposition.match(/filename="?([^"]+)"?/);
      if (match && match[1]) filename = match[1];
    }

    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(downloadUrl);

    buttons.forEach(b => {
      b.innerHTML = `✓ Download Started!`;
    });
    setTimeout(() => {
      buttons.forEach((b, idx) => {
        b.innerHTML = originalTexts[idx];
        b.disabled = false;
      });
    }, 2500);
  } catch (err) {
    console.error("Export ZIP error:", err);
    showErrorBanner(500, `ZIP export failed: ${err.message}`, "/export-zip");
    buttons.forEach(b => {
      b.innerHTML = `⚠️ Export Failed`;
    });
    setTimeout(() => {
      buttons.forEach((b, idx) => {
        b.innerHTML = originalTexts[idx];
        b.disabled = false;
      });
    }, 3000);
  }
}

// ─── Event Listener Setup ─────────────────────────────────────────────────────

function setupEventListeners() {

  // Search form submit
  document.getElementById("search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = document.getElementById("target-in").value.trim();
    // Sync coord inputs to state before searching
    syncCoordsFromInputs();
    await resolveTarget(val);
  });

  // Preset chips
  document.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", async () => {
      document.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");

      const name = chip.dataset.name || chip.textContent.trim();
      const ra = parseFloat(chip.dataset.ra);
      const dec = parseFloat(chip.dataset.dec);

      state.targetName = name;
      state.ra = ra;
      state.dec = dec;
      updateCoordInputs();

      const targetIn = document.getElementById("target-in");
      if (targetIn) targetIn.value = name;

      updateTrackingTelemetry();
      syncUrlParams();
      await loadObservations();
    });
  });

  // Spectral Band Filter
  const bandSel = document.getElementById("band-sel");
  if (bandSel) {
    bandSel.addEventListener("change", async (e) => {
      state.selectedBand = e.target.value;
      stopBlink();
      renderTimeline();
      renderTable();
      autoSelectDefaultEpochs();
      const visible = getVisibleObservations();
      if (visible.length > 0) {
        await loadEpoch(0);
      }
      syncUrlParams();
      const activeTab = document.querySelector(".tab-btn.active")?.dataset.tab;
      if (activeTab === "compare" || activeTab === "diff") {
        await loadComparison();
        if (activeTab === "diff") await computeDiff();
      }
    });
  }

  // Coordinate inputs — update state on change but don't auto-query
  document.getElementById("ra-in").addEventListener("change", () => {
    syncCoordsFromInputs();
    syncUrlParams();
  });
  document.getElementById("dec-in").addEventListener("change", () => {
    syncCoordsFromInputs();
    syncUrlParams();
  });
  document.getElementById("radius-in").addEventListener("change", () => {
    state.radiusDeg = parseFloat(document.getElementById("radius-in").value) || 0.1;
  });

  // Max frames
  document.getElementById("max-frames-sel").addEventListener("change", (e) => {
    state.maxFrames = parseInt(e.target.value, 10) || 50;
  });

  // Colormap
  document.getElementById("colormap-sel").addEventListener("change", (e) => {
    state.colormap = e.target.value;
  });

  // Size arcsec
  document.getElementById("size-in").addEventListener("change", (e) => {
    state.sizeArcsec = parseInt(e.target.value, 10) || 100;
  });

  // Blink controls
  document.getElementById("btn-play").addEventListener("click", toggleBlink);

  document.getElementById("btn-prev").addEventListener("click", () => {
    stopBlink();
    const prev = Math.max(0, state.currentEpochIdx - 1);
    loadEpoch(prev);
  });

  document.getElementById("btn-next").addEventListener("click", () => {
    stopBlink();
    const visible = getVisibleObservations();
    const next = Math.min(visible.length - 1, state.currentEpochIdx + 1);
    loadEpoch(next);
  });

  document.getElementById("blink-speed").addEventListener("change", (e) => {
    state.blinkSpeed = parseInt(e.target.value, 10) || 500;
    if (state.blinkInterval) {
      stopBlink();
      startBlink();
    }
  });

  // Tab switching
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Reticle toggle
  document.getElementById("btn-toggle-reticle").addEventListener("click", () => {
    const r = document.getElementById("reticle");
    if (r) r.style.display = r.style.display === "none" ? "" : "none";
  });

  // Star Tracking Overlay toggle
  const btnTracks = document.getElementById("btn-toggle-tracks");
  if (btnTracks) {
    btnTracks.addEventListener("click", () => {
      state.showTracks = !state.showTracks;
      btnTracks.classList.toggle("active", state.showTracks);
      const overlay = document.getElementById("tracking-overlay");
      if (overlay) overlay.style.display = state.showTracks ? "" : "none";
      const card = document.getElementById("track-telemetry-card");
      if (card) card.style.display = state.showTracks ? "" : "none";
      const visible = getVisibleObservations();
      if (visible.length > 0 && state.currentEpochIdx >= 0 && state.currentEpochIdx < visible.length) {
        updateTrackingTelemetry(visible[state.currentEpochIdx]);
      }
    });
  }

  // Health button
  document.getElementById("btn-health").addEventListener("click", probeHealth);

  // P1 Load Comparison
  document.getElementById("btn-load-compare").addEventListener("click", async () => {
    switchTab("compare");
    await loadComparison();
  });

  // P2 Compute Diff
  document.getElementById("btn-compute-diff").addEventListener("click", () => computeDiff(null, true));

  // Multi-Epoch ZIP Export
  const btnZip = document.getElementById("btn-download-zip");
  if (btnZip) btnZip.addEventListener("click", downloadEpochsZip);
  const btnZipTab = document.getElementById("btn-download-zip-tab");
  if (btnZipTab) btnZipTab.addEventListener("click", downloadEpochsZip);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function syncCoordsFromInputs() {
  const ra = parseFloat(document.getElementById("ra-in").value);
  const dec = parseFloat(document.getElementById("dec-in").value);
  if (!isNaN(ra)) state.ra = ra;
  if (!isNaN(dec)) state.dec = dec;
}

// ─── Initialise ───────────────────────────────────────────────────────────────

async function init() {
  try {
    parseUrlParams();
    setupEventListeners();
    updateTrackingTelemetry();
  } catch (err) {
    console.error("Initialization error:", err);
  }

  await probeHealth();
  setInterval(probeHealth, 15000);

  try {
    await loadObservations();
  } catch (err) {
    console.error("Initial load error:", err);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  // DOM already parsed, initialize immediately
  init();
}
