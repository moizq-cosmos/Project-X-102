# SPHEREx Time Explorer 🌌🔭
**NASA Space Apps Challenge 2026 — SPHEREx Time-Domain Astronomy Gateway**

[![FastAPI](https://img.shields.io/badge/FastAPI-0.110+-009688.svg?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![Python](https://img.shields.io/badge/Python-3.11%20%7C%203.12-3776AB.svg?logo=python&logoColor=white)](https://www.python.org/)
[![Astropy](https://img.shields.io/badge/Astropy-6.0+-orange.svg)](https://www.astropy.org/)
[![IRSA SIA2](https://img.shields.io/badge/NASA%2FIPAC-IRSA%20SIA2-005ea2.svg)](https://irsa.ipac.caltech.edu)
[![DOI](https://img.shields.io/badge/DOI-10.26131%2FIRSA678-blue.svg)](https://doi.org/10.26131/IRSA678)

**SPHEREx Time Explorer** is a high-performance web platform and scientific gateway designed to discover moving and variable celestial objects—such as brown dwarfs, high-proper-motion stars, young stellar objects, and candidates for Planet X—using genuine multi-epoch infrared data from the **NASA/IPAC Infrared Science Archive (IRSA)**.

---

## 🏛 Architecture & Science Data Pipeline

```
                     ┌───────────────────────────────────────────────┐
                     │           NASA/IPAC IRSA SIA2 Gateway         │
                     │   (spherex_dr1: 2025  +  spherex_qr3: 2026)   │
                     └───────────────────────┬───────────────────────┘
                                             │  Multi-Epoch VOTable
                                             ▼
                     ┌───────────────────────────────────────────────┐
                     │          Stratified Epoch Sampler             │
                     │  - Bin observations into 5-day visit clusters │
                     │  - Sample 6–12+ month revisit baselines       │
                     │  - Lock matched spectral band (SPHEREx-D1..D6)│
                     └───────────────────────┬───────────────────────┘
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
       ┌───────────────────────────────┐           ┌───────────────────────────────┐
       │   FITS Image Extraction HDU   │           │   Calibrated Float32 Diff     │
       │   - First 2D image HDU        │           │   - Background MAD norm       │
       │   - NaN & Inf sanitization    │           │   - Center-cropped overlap    │
       │   - Asinh + Percentile stretch│           │   - Diverging colormap        │
       │   - WCS alignment (N-Up/E-Left│           │   - RMS noise measurement     │
       └───────────────┬───────────────┘           └───────────────┬───────────────┘
                       │                                           │
                       └─────────────────────┬─────────────────────┘
                                             ▼
                     ┌───────────────────────────────────────────────┐
                     │         FastAPI Time Explorer Interface       │
                     │  [P0] Timeline Scrubber & Reticle Cutout      │
                     │  [P1] Side-by-Side Dual-Epoch Blink Player    │
                     │  [P2] Calibrated Difference Residual Canvas   │
                     │  [Export] One-Click Multi-Epoch ZIP Archive   │
                     └───────────────────────────────────────────────┘
```

---

## 🌟 Key Features

1. **Multi-Epoch Stratified Sampling (6-Month Revisits):**
   - Automatically groups observations into distinct sky-pass visits (binning `MJD` into 5-day clusters) across both `spherex_dr1` (2025) and `spherex_qr3` (2026).
   - Guarantees multi-month baseline spans ($\Delta\text{MJD} > 100\text{ days}$) so proper motion and flux variability are visibly detectable.

2. **Spectral Band Locking (`SPHEREx-D1` through `D6`):**
   - Wavelength-locked filtering prevents false-positive differences caused by comparing mismatched bandpasses (e.g., $1.63\,\mu\text{m}$ vs $4.41\,\mu\text{m}$).

3. **Astronomical Cutout Extraction & Asinh Stretch:**
   - Detects the primary 2D numeric image HDU, sanitizes `NaN` and blanking pedestal values, and applies `AsinhStretch` with `PercentileInterval(99.5)` scaling.
   - Guaranteed non-black cutouts for faint brown dwarfs and bright variable stars.

4. **Calibrated Backend Float32 Differencing (`GET /diff`):**
   - Normalizes background pedestals using Median Absolute Deviation (MAD) scaling: $\text{norm} = \frac{\text{crop} - \text{median}}{\text{MAD}}$.
   - Calculates true float32 residuals ($\Delta = \text{Norm}_B - \text{Norm}_A$) and RMS residual noise ($\text{RMS}_{\text{DN}} = \sqrt{\langle \Delta^2 \rangle}$).
   - Renders with a diverging colormap centered at zero: Electric Blue (negative flux decrease), Dark Slate (zero background), and Bright Amber/Red (positive flux increase).

5. **One-Click Multi-Epoch ZIP Export (`GET /export-zip`):**
   - Exports all retrieved observations, WCS-aligned PNG cutouts, `metadata.csv`, `metadata.json`, and official citation acknowledgements in a single downloadable `.zip` archive.

6. **100% Responsive Design:**
   - Mobile, tablet, and desktop adaptive layout with preserved 1:1 celestial aspect ratio and centered coordinate reticle crosshairs.

---

## 🔬 Scientific Integrity & Citations

> [!IMPORTANT]
> **Candidate Notice:** Apparent variations or proper motions identified through time-domain differencing represent **candidates for human review and not confirmed autonomous discoveries**.

### Archive Data Citations
- **SPHEREx DR1 (Data Release 1):** DOI: [10.26131/IRSA678](https://doi.org/10.26131/IRSA678)
- **SPHEREx QR3 (Quick Release 3):** NASA/IPAC Infrared Science Archive (IRSA), Caltech/JPL.
- **Allowed Collections Rule:** Queries query strictly `spherex_dr1` and `spherex_qr3`. `spherex_qr2` is permanently barred due to calibration discrepancies.
- **Real Data Only:** Zero synthetic or mock data is injected.

---

## 🎯 Verified Challenge Targets

All 5 NASA challenge targets have been verified using automated regression tests (`verify_all_targets.py`):

| Target | Coordinates (RA, Dec) | Object Type | Baseline Revisit Span | Band Locking | Pixel Variance (std) | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **WISE 0855** | `133.7951°, -7.2451°` | Y-type Brown Dwarf | 373.59 days | Locked (`SPHEREx-D3`) | `10,357,363.30` | ✅ PASSED |
| **Barnard's Star** | `269.4521°, +4.6934°` | High-PM Red Dwarf | 373.59 days | Locked (`SPHEREx-D3`) | `14.06` | ✅ PASSED |
| **Epsilon Indi B** | `331.0771°, -56.7825°` | T-type Brown Dwarf | 373.59 days | Locked (`SPHEREx-D3`) | `7.80` | ✅ PASSED |
| **RW Aurigae** | `76.9565°, +30.4014°` | T Tauri Variable Star | 373.59 days | Locked (`SPHEREx-D3`) | `18.85` | ✅ PASSED |
| **R Draconis** | `248.1633°, +66.7556°` | Mira Pulsating Variable | 373.59 days | Locked (`SPHEREx-D3`) | `22.63` | ✅ PASSED |

---

## 🚀 Getting Started

### Prerequisites
- Python 3.11 or 3.12
- `pip` package manager

### 1. Local Setup
```bash
# Clone the repository
git clone https://github.com/your-username/spherex-time-explorer.git
cd spherex-time-explorer

# Create and activate virtual environment
python -m venv .venv
source .venv/bin/activate       # On Linux/macOS
# .venv\Scripts\Activate.ps1    # On Windows PowerShell

# Install dependencies
pip install -r requirements.txt
```

### 2. Run the Server
```bash
# Start Uvicorn development server
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```
Open **[http://127.0.0.1:8000](http://127.0.0.1:8000)** in your browser (redirects automatically to `/app`).

### 3. Run Automated Verification Suite
```bash
python verify_all_targets.py
```

---

## 🌐 Deploy to Render

This repository is pre-configured for instant deployment on [Render](https://render.com) using the included `render.yaml`:

1. Fork or push this repository to GitHub.
2. Log in to [Render](https://dashboard.render.com).
3. Click **New +** → **Blueprint**.
4. Connect your GitHub repository. Render will automatically detect `render.yaml` and configure:
   - **Environment:** `Python 3.12`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`
5. Click **Apply**. Your app will be live with a free HTTPS URL.

---

## 📁 Repository & Branch Structure

To maintain a clean separation of concerns between backend infrastructure and user-facing presentation, the repository is partitioned across dedicated branches:

- **`main` (Backend API & Scientific Pipeline):**
  Contains the FastAPI backend engine, IRSA data pipeline, automated verification suite, and project documentation:
  ```
  .
  ├── main.py                     # FastAPI application endpoints & API routing
  ├── services.py                 # IRSA SIA2/IBE client, WCS differencing, & ZIP exporter
  ├── verify_all_targets.py       # Automated 5-target verification test suite
  ├── requirements.txt            # Pinned production dependencies
  ├── render.yaml                 # Render infrastructure-as-code blueprint
  ├── .gitignore                  # Git exclusion rules
  ├── README.md                   # Project documentation & deployment guide
  ├── run.ps1                     # PowerShell launch helper
  ├── run.sh                      # Shell launch helper
  ├── docs/                       # Verification report docx & UI validation captures
  └── screenshots/                # Application verification figures
  ```

- **`website` (Frontend Web Application):**
  Dedicated branch containing the responsive Single-Page Application (SPA) frontend interface:
  ```
  .
  ├── index.html                  # Main HTML5 responsive interface (root)
  ├── styles.css                  # Dark-space theme & responsive grid layouts
  ├── app.js                      # Frontend state machine, blink player, & differencing
  ├── static/                     # Mirror directory for static hosting
  └── README.md                   # Frontend architecture & local hosting guide
  ```

- **`artifacts` (Reference Datasets & Archive):**
  Contains reference SIA2 XML VOTables and sample multi-epoch SPHEREx FITS cutouts for offline regression testing.

---

## 📜 License & Acknowledgements
Developed for the **NASA Space Apps Challenge 2026**.
Data provided by the **NASA/IPAC Infrared Science Archive (IRSA)**, Caltech/JPL.
Built with Astropy, FastAPI, NumPy, Pillow, and Matplotlib.
