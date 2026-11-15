/**
 * SPHEREx Time Explorer — app.js
 * NASA-IPAC Observational Gateway
 * Real IRSA SIA2 data: spherex_dr1 + spherex_qr3 ONLY (never spherex_qr2)
 */

"use strict";

// ─── API Base ────────────────────────────────────────────────────────────────
// When running over HTTP/HTTPS, relative paths ("") are used for bulletproof same-origin requests.
// Falls back to http://127.0.0.1:8000 only when loaded directly from the local filesystem (file://).
const API_BASE = (typeof window !== "undefined" && window.location.protocol.startsWith("http"))
  ? ""
  : "http://127.0.0.1:8000";

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
  let resp;
  try {
    resp = await fetch(url, options);
  } catch (netErr) {
    if (netErr.name === "AbortError" || options.signal?.aborted) {
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
    showErrorBanner(resp.status, detail, url.replace(API_BASE, ""));
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
    const resp = await fetch(`${API_BASE}/health`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    dot.className = "dot online";
    txt.textContent = "Online: SPHEREx DR1 & QR3";
  } catch (err) {
    console.warn("Health probe notice:", err);
    dot.className = "dot offline";
    txt.textContent = "API Offline";
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

function updateObsStats(data) {
  const obs = state.observations;
  const dr1Count = obs.filter(o => o.collection === "spherex_dr1").length;
  const qr3Count = obs.filter(o => o.collection === "spherex_qr3").length;

  setText("stat-total", `${obs.length} observations`);
  setText("stat-dr1", `DR1: ${dr1Count}`);
  setText("stat-qr3", `QR3: ${qr3Count}`);
  setText("stat-status", data.status || "");

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

async function loadCutout(obs, signal = null) {
  const img = document.getElementById("cutout-img");
  if (!obs || !obs.access_url) {
    if (img) img.removeAttribute("src");
    return;
  }

  const loader = document.getElementById("img-loader");
  loader.classList.remove("hidden");
  img.style.opacity = "0.3";

  // Use scoped coordinates directly from obs to prevent target-mismatch race condition
  const targetRa = obs.ra != null ? obs.ra : state.ra;
  const targetDec = obs.dec != null ? obs.dec : state.dec;

  const params = new URLSearchParams({
    access_url: obs.access_url,
    obs_id: obs.obs_id || "",
    ra: targetRa,
    dec: targetDec,
    size_arcsec: state.sizeArcsec,
    colormap: state.colormap,
  });

  try {
    const fetchSignal = signal || queryAbortController?.signal;
    const resp = await apiFetch(`${API_BASE}/cutout?${params}`, { signal: fetchSignal });
    const data = await resp.json();
    if (data.data_url) {
      img.src = data.data_url;
      img.style.opacity = "1";
    } else {
      img.removeAttribute("src");
      img.style.opacity = "1";
    }
  } catch (err) {
    if (err.name === "AbortError" || (signal && signal.aborted)) {
      return;
    }
    img.removeAttribute("src");
    img.style.opacity = "1";
  } finally {
    if (!signal || !signal.aborted) {
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

async function loadComparison(signal = null) {
  if (!state.epochA || !state.epochB) return;

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
    const params = new URLSearchParams({
      access_url: obs.access_url,
      obs_id: obs.obs_id || "",
      ra: targetRa,
      dec: targetDec,
      size_arcsec: state.sizeArcsec,
      colormap: state.colormap,
    });
    try {
      const fetchSignal = signal || queryAbortController?.signal;
      const resp = await apiFetch(`${API_BASE}/cutout?${params}`, { signal: fetchSignal });
      const data = await resp.json();
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

async function computeDiff(signal = null) {
  if (!state.epochA || !state.epochB) {
    if (state.observations && state.observations.length > 0) {
      autoSelectDefaultEpochs();
    }
  }
  if (!state.epochA || !state.epochB) return;

  const statusEl = document.getElementById("diff-status");
  const bannerEl = document.getElementById("diff-candidate-banner");
  const canvas = document.getElementById("diff-canvas");
  const placeholder = document.getElementById("diff-placeholder");
  const btnDiff = document.getElementById("btn-compute-diff");
  const ctx = canvas.getContext("2d");

  if (btnDiff) btnDiff.disabled = true;
  statusEl.textContent = "Computing backend calibrated float32 FITS difference…";
  bannerEl.style.display = "none";

  const obsA = state.epochA.obs;
  const obsB = state.epochB.obs;

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

  try {
    const fetchSignal = signal || queryAbortController?.signal;
    const resp = await apiFetch(`${API_BASE}/diff?${params}`, { signal: fetchSignal });
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

    if (maxDelta >= 2.0 || rms >= 0.5) {
      bannerEl.style.display = "";
      statusEl.textContent = `Candidate for human review — not a confirmed discovery (RMS: ${rms.toFixed(4)} DN, Peak Δ: ${maxDelta.toFixed(4)} DN)`;
    } else {
      bannerEl.style.display = "none";
      statusEl.textContent = `Baseline aligned (RMS: ${rms.toFixed(4)} DN) — Candidate residuals highlighted`;
    }

  } catch (err) {
    if (err.name === "AbortError" || (signal && signal.aborted)) {
      return;
    }
    statusEl.textContent = `Diff error: ${err.message}`;
    if (placeholder) {
      placeholder.style.display = "";
      placeholder.textContent = `Diff error: ${err.message}`;
    }
  } finally {
    setButtonStates();
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
      // Ensure cutouts are loaded and cached, then immediately execute subtraction
      if (!state.imgCacheA || !state.imgCacheB) {
        await loadComparison();
      }
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

  // Health button
  document.getElementById("btn-health").addEventListener("click", probeHealth);

  // P1 Load Comparison
  document.getElementById("btn-load-compare").addEventListener("click", async () => {
    switchTab("compare");
    await loadComparison();
  });

  // P2 Compute Diff
  document.getElementById("btn-compute-diff").addEventListener("click", computeDiff);

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
