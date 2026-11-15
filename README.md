# SPHEREx Time Explorer — Web Frontend 🌌🔭
**NASA Space Apps Challenge 2026**

This branch (`website`) contains the responsive Single-Page Application (SPA) frontend for the **SPHEREx Time Explorer**.

---

## 📁 Branch Structure

```
.
├── index.html          # Main HTML5 responsive interface (root)
├── styles.css          # Dark-space celestial CSS styling & responsive grid layouts
├── app.js              # Frontend state machine, blink comparator, & IRSA API client
└── static/             # Mirror directory for static server mounts
    ├── index.html
    ├── styles.css
    └── app.js
```

---

## 🌟 Frontend Capabilities

1. **[P0] Timeline Scrubber & Reticle Cutout:**
   - 1:1 celestial aspect ratio (`North +Dec` / `East +RA`) with crosshair reticle.
   - Interactive observation playback across all sky-pass visits.

2. **[P1] Dual-Epoch Blink Comparator:**
   - Synchronized Epoch A vs Epoch B blink animation (1–10 Hz adjustable toggle).
   - Side-by-side comparison cards with MJD delta computation ($\Delta t > 100\text{ days}$).

3. **[P2] Calibrated Difference Residual Canvas:**
   - Automated server-side float32 background-normalized differencing.
   - Diverging colormap (`RdBu_r` / Slate-Cyan-Amber) with RMS noise readouts ($0.142\text{ DN}$).

4. **Multi-Epoch ZIP Exporter:**
   - One-click export packaging metadata CSV/JSON, WCS-aligned PNG cutouts, and NASA/IPAC citations into `SPHEREx_<target>_epochs.zip`.

---

## 🚀 Running Locally

You can serve this frontend with any static file server:

```bash
# Using Python
python -m http.server 8080

# Using Node.js npx serve
npx serve .
```

To connect to a remote or local SPHEREx backend API, ensure the backend from the `main` branch is running on `http://127.0.0.1:8000`.
