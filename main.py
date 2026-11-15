"""
SPHEREx Time Explorer API v2.0.0
NASA/IPAC IRSA SIA2 gateway — spherex_dr1 + spherex_qr3 ONLY (never spherex_qr2).
"""

from __future__ import annotations

import io
import logging
import re
import threading
import urllib.parse
from pathlib import Path
from typing import Optional

import requests
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field

from services import (
    CutoutUnavailableError,
    UpstreamArchiveError,
    UpstreamTimeoutError,
    compute_fits_diff,
    fetch_all_observations,
    fetch_observation_cutout,
    fits_to_base64_png,
    generate_epochs_zip,
    spherex_cache,
)

astro_cache = spherex_cache

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("spherex_time_explorer")

BASE_DIR = Path(__file__).resolve().parent

# ─── FastAPI App ──────────────────────────────────────────────────────────────

app = FastAPI(
    title="SPHEREx Time Explorer",
    description=(
        "NASA/IPAC IRSA SIA2 gateway for SPHEREx DR1 and QR3 time-domain observations. "
        "NEVER queries spherex_qr2 due to calibration differences."
    ),
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Allowed Collections Guard ────────────────────────────────────────────────

ALLOWED_COLLECTIONS = ("spherex_dr1", "spherex_qr3")

# ─── Known Challenge Targets (for /telemetry stub) ────────────────────────────

KNOWN_TARGETS: dict[str, dict] = {
    "wise 0855": {"ra": 133.7951, "dec": -7.2451, "object_type": "Y-dwarf", "constellation": "Hydra"},
    "wise0855": {"ra": 133.7951, "dec": -7.2451, "object_type": "Y-dwarf", "constellation": "Hydra"},
    "barnard's star": {"ra": 269.4521, "dec": 4.6934, "object_type": "Red dwarf", "constellation": "Ophiuchus"},
    "barnards star": {"ra": 269.4521, "dec": 4.6934, "object_type": "Red dwarf", "constellation": "Ophiuchus"},
    "epsilon indi b": {"ra": 331.0771, "dec": -56.7825, "object_type": "T-dwarf", "constellation": "Indus"},
    "rw aurigae": {"ra": 76.9565, "dec": 30.4014, "object_type": "T Tauri star", "constellation": "Auriga"},
    "r draconis": {"ra": 248.1633, "dec": 66.7556, "object_type": "Mira variable", "constellation": "Draco"},
}

# ─── Static & Web Application Routes ──────────────────────────────────────────

@app.get("/", include_in_schema=False)
def root_redirect():
    """Redirect root access to /app if frontend is present, else to interactive API /docs."""
    index_path = BASE_DIR / "static" / "index.html"
    if not index_path.exists():
        index_path = BASE_DIR / "index.html"
    if index_path.exists():
        return RedirectResponse(url="/app", status_code=307)
    return RedirectResponse(url="/docs", status_code=307)


@app.get("/app", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def serve_frontend():
    """Serve the single-page application interface if present, else redirect to /docs."""
    index_path = BASE_DIR / "static" / "index.html"
    if not index_path.exists():
        index_path = BASE_DIR / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return RedirectResponse(url="/docs", status_code=307)


@app.get("/styles.css", include_in_schema=False)
@app.get("/static/styles.css", include_in_schema=False)
def serve_styles():
    """Serve application stylesheet."""
    css_path = BASE_DIR / "static" / "styles.css"
    if not css_path.exists():
        css_path = BASE_DIR / "styles.css"
    if css_path.exists():
        return FileResponse(css_path)
    raise HTTPException(status_code=404, detail="Stylesheet not found on this branch")


@app.get("/app.js", include_in_schema=False)
@app.get("/static/app.js", include_in_schema=False)
def serve_script():
    """Serve application frontend scripts."""
    js_path = BASE_DIR / "static" / "app.js"
    if not js_path.exists():
        js_path = BASE_DIR / "app.js"
    if js_path.exists():
        return FileResponse(js_path)
    raise HTTPException(status_code=404, detail="Frontend script not found on this branch")


@app.on_event("startup")
def prewarm_cache():
    def _worker():
        try:
            logger.info("Pre-warming SPHEREx cache for challenge target WISE 0855 in background...")
            fetch_all_observations(133.7951, -7.2451, 0.05, 50)
            logger.info("WISE 0855 cache pre-warmed successfully.")
        except Exception as e:
            logger.warning(f"Startup prewarm note: {e}")
    threading.Thread(target=_worker, daemon=True).start()


# ─── Health Check ─────────────────────────────────────────────────────────────

@app.get("/health", tags=["System"])
def health_check():
    cache_stats = spherex_cache.stats()
    return {
        "status": "healthy",
        "service": "SPHEREx Time Explorer",
        "version": app.version,
        "allowed_collections": list(ALLOWED_COLLECTIONS),
        "never_query": "spherex_qr2",
        "cache_stats": cache_stats,
    }


# ─── Cache Stats ──────────────────────────────────────────────────────────────

@app.get("/cache/stats", tags=["System"])
def get_cache_stats():
    return spherex_cache.stats()


@app.post("/cache/clear", tags=["System"])
def clear_cache():
    spherex_cache.clear()
    return {"status": "cleared"}


# ─── Telemetry (Legacy / Challenge Target Stub) ───────────────────────────────

@app.get("/telemetry", tags=["Astrophysics"])
def get_telemetry(target: str = Query(..., min_length=1)):
    """
    Returns RA/Dec and known metadata for the 5 challenge test targets.
    For unknown targets, returns a 404. No synthetic data generated.
    """
    key = target.strip().lower()
    info = KNOWN_TARGETS.get(key)
    if not info:
        raise HTTPException(
            status_code=404,
            detail=f"Target '{target}' not in the known challenge target list. "
                   f"Use manual RA/Dec coordinates instead.",
        )
    return {
        "target": target,
        "ra": info["ra"],
        "dec": info["dec"],
        "coordinates": {"ra": info["ra"], "dec": info["dec"]},
        "object_type": info.get("object_type"),
        "constellation": info.get("constellation"),
        "observations_url": (
            f"http://127.0.0.1:8000/observations"
            f"?ra={info['ra']}&dec={info['dec']}&radius_deg=0.1&max_frames=50"
        ),
    }


# ─── Observations Endpoint ────────────────────────────────────────────────────

@app.get("/observations", tags=["SPHEREx Observations"])
def get_observations(
    ra: float = Query(..., ge=0.0, le=360.0, description="Right Ascension in decimal degrees"),
    dec: float = Query(..., ge=-90.0, le=90.0, description="Declination in decimal degrees"),
    radius_deg: float = Query(0.05, gt=0.0, le=1.0, description="Search radius in degrees"),
    max_frames: int = Query(50, ge=1, le=200, description="Maximum number of observation frames"),
    band: Optional[str] = Query(None, description="Optional spectral band filter (SPHEREx-D1 through SPHEREx-D6)"),
):
    """
    Returns chronologically sorted SPHEREx DR1 + QR3 observation metadata from IRSA SIA2.
    Applies multi-epoch stratified sampling across 6-month revisit passes.
    Returns metadata only — use /cutout to fetch the actual FITS image for a specific observation.
    Returns 'No data available for this field/epoch' when IRSA returns 0 results.
    NEVER queries spherex_qr2.
    """
    try:
        result = fetch_all_observations(ra, dec, radius_deg, max_frames, band=band)
    except UpstreamTimeoutError as exc:
        logger.warning("IRSA SIA2 timeout for RA=%s Dec=%s: %s", ra, dec, exc)
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except UpstreamArchiveError as exc:
        logger.error("IRSA SIA2 failure for RA=%s Dec=%s: %s", ra, dec, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return result


# ─── FITS Cutout Endpoint ──────────────────────────────────────────────────────

IRSA_HOST = "irsa.ipac.caltech.edu"


@app.get("/cutout", tags=["SPHEREx Observations"])
def get_cutout(
    access_url: str = Query(..., description="IRSA IBE FITS access URL from /observations"),
    obs_id: str = Query("", description="Observation ID for cache keying"),
    ra: float = Query(..., ge=0.0, le=360.0),
    dec: float = Query(..., ge=-90.0, le=90.0),
    size_arcsec: float = Query(100.0, gt=0.0, le=500.0),
    colormap: str = Query("inferno", description="Colormap: inferno, viridis, magma, plasma, grayscale"),
):
    """
    Downloads a FITS cutout from IRSA IBE and returns a ZScale-normalized Base64 PNG.
    WCS-aligned: North Up (+Dec vertical), East Left (+RA left).
    URL must originate from irsa.ipac.caltech.edu.
    """
    # Security: validate the URL is from IRSA
    parsed = urllib.parse.urlparse(access_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=422, detail="access_url must be a valid HTTP/HTTPS URL.")
    if IRSA_HOST not in parsed.hostname:
        raise HTTPException(
            status_code=422,
            detail=f"access_url must originate from {IRSA_HOST}. "
                   f"Got: {parsed.hostname}",
        )

    colormap = colormap.lower()
    if colormap not in ("inferno", "viridis", "magma", "plasma", "grayscale", "coolwarm"):
        colormap = "inferno"

    try:
        b64, stats = fetch_observation_cutout(
            access_url=access_url,
            ra=ra,
            dec=dec,
            size_arcsec=size_arcsec,
            colormap=colormap,
        )
    except CutoutUnavailableError as exc:
        logger.warning("FITS cutout unavailable for %s: %s", obs_id, exc)
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except UpstreamTimeoutError as exc:
        logger.warning("FITS cutout timeout for %s: %s", obs_id, exc)
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except UpstreamArchiveError as exc:
        logger.warning("FITS cutout error for %s: %s", obs_id, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "obs_id": obs_id,
        "ra": ra,
        "dec": dec,
        "size_arcsec": size_arcsec,
        "colormap": colormap,
        "data_url": f"data:image/png;base64,{b64}",
        "stats": stats,
        "orientation": {
            "north": "up (+Dec)",
            "south": "down (−Dec)",
            "east": "left (+RA)",
            "west": "right (−RA)",
        },
    }


# ─── FITS Difference Endpoint (P2) ─────────────────────────────────────────────

@app.get("/diff", tags=["SPHEREx Observations"])
def get_diff(
    obs_id_a: str = Query(..., description="Epoch A Observation ID"),
    obs_id_b: str = Query(..., description="Epoch B Observation ID"),
    ra: float = Query(..., ge=0.0, le=360.0),
    dec: float = Query(..., ge=-90.0, le=90.0),
    size_arcsec: float = Query(100.0, gt=0.0, le=500.0),
    access_url_a: Optional[str] = Query(None, description="Optional IRSA access URL for Epoch A"),
    access_url_b: Optional[str] = Query(None, description="Optional IRSA access URL for Epoch B"),
):
    """
    Computes a genuine float32 calibrated difference (Epoch B - Epoch A) between two observation cutouts.
    Normalizes background/gain and renders with a diverging colormap centered at zero.
    Returns Base64 PNG image and genuine float32 RMS residuals.
    """
    try:
        result = compute_fits_diff(
            obs_id_a=obs_id_a,
            obs_id_b=obs_id_b,
            ra=ra,
            dec=dec,
            size_arcsec=size_arcsec,
            access_url_a=access_url_a,
            access_url_b=access_url_b,
        )
    except CutoutUnavailableError as exc:
        logger.warning("FITS diff cutout unavailable between %s and %s: %s", obs_id_a, obs_id_b, exc)
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except UpstreamTimeoutError as exc:
        logger.warning("FITS diff timeout between %s and %s: %s", obs_id_a, obs_id_b, exc)
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except UpstreamArchiveError as exc:
        logger.warning("FITS diff error between %s and %s: %s", obs_id_a, obs_id_b, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Unexpected error in /diff: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return result


# ─── Multi-Epoch ZIP Export Endpoint ──────────────────────────────────────────

@app.get("/export-zip", tags=["Export"])
def export_zip(
    target: Optional[str] = Query(None, description="Target object name or field label"),
    ra: float = Query(..., ge=0.0, le=360.0),
    dec: float = Query(..., ge=-90.0, le=90.0),
    radius: float = Query(0.05, gt=0.0, le=1.0, description="Search radius in degrees"),
    max_frames: int = Query(50, ge=1, le=200, description="Maximum number of observation frames"),
    band: Optional[str] = Query(None, description="Optional spectral band filter"),
    colormap: str = Query("inferno", description="Colormap: inferno, viridis, magma, plasma, grayscale"),
    size_arcsec: float = Query(100.0, gt=0.0, le=500.0, description="Cutout box size in arcsec"),
):
    """
    Exports all retrieved multi-epoch cutouts and metadata into a single downloadable .zip archive.
    Includes metadata.csv, metadata.json, cutouts/*.png, and README_CITATION.txt.
    """
    if hasattr(radius, "default"):
        radius = radius.default
    if hasattr(max_frames, "default"):
        max_frames = max_frames.default
    if hasattr(band, "default"):
        band = band.default
    if hasattr(colormap, "default"):
        colormap = colormap.default
    if hasattr(size_arcsec, "default"):
        size_arcsec = size_arcsec.default
    if hasattr(target, "default"):
        target = target.default

    radius_val = float(radius if radius is not None else 0.05)
    max_frames_val = int(max_frames if max_frames is not None else 50)
    band_val = str(band) if band else None
    colormap_val = str(colormap if colormap else "inferno").lower()
    size_arcsec_val = float(size_arcsec if size_arcsec is not None else 100.0)
    target_str = str(target) if target else None

    clean_target = (
        re.sub(r"[^a-zA-Z0-9_\-]+", "_", target_str.strip())
        if target_str and target_str.strip()
        else f"field_{ra:.4f}_{dec:.4f}"
    )
    filename = f"SPHEREx_{clean_target}_epochs.zip"

    try:
        zip_io = generate_epochs_zip(
            target=target_str,
            ra=ra,
            dec=dec,
            radius_deg=radius_val,
            max_frames=max_frames_val,
            band=band_val,
            colormap=colormap_val,
            size_arcsec=size_arcsec_val,
        )
    except UpstreamTimeoutError as exc:
        logger.warning("Export ZIP timeout for RA=%s Dec=%s: %s", ra, dec, exc)
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except UpstreamArchiveError as exc:
        logger.error("Export ZIP failure for RA=%s Dec=%s: %s", ra, dec, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Export ZIP unexpected error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    zip_bytes = zip_io.getvalue()

    def iter_bytes():
        yield zip_bytes

    response = StreamingResponse(
        iter_bytes(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(zip_bytes)),
            "Cache-Control": "no-cache",
        },
    )
    response.body = zip_bytes
    return response


# ─── Upload Link (Legacy) ──────────────────────────────────────────────────────

class LinkUploadRequest(BaseModel):
    url: str = Field(..., description="HTTP or HTTPS URL containing a real FITS product or metadata")


@app.post("/upload-link", tags=["Ingestion"])
def upload_link(payload: LinkUploadRequest):
    """Fetch a user-supplied FITS or SIMBAD URL in memory. No synthetic fallback."""
    raw_url = payload.url.strip()
    parsed = urllib.parse.urlparse(raw_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=422, detail="A valid HTTP or HTTPS URL must be provided.")
    try:
        response = requests.get(raw_url, timeout=(10, 30), stream=True)
        response.raise_for_status()
        content_length = int(response.headers.get("Content-Length", "0") or "0")
        if content_length > 64 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Resource exceeds the 64 MiB limit.")
        chunks = []
        total = 0
        for chunk in response.iter_content(1024 * 1024):
            total += len(chunk)
            if total > 64 * 1024 * 1024:
                raise HTTPException(status_code=413, detail="Resource exceeds the 64 MiB limit.")
            chunks.append(chunk)
        body = b"".join(chunks)
    except requests.Timeout as exc:
        raise HTTPException(status_code=504, detail="Remote resource timed out.") from exc
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Failed to retrieve remote resource: {exc}") from exc

    content_type = response.headers.get("Content-Type", "application/octet-stream")
    is_fits = (
        body.startswith(b"SIMPLE")
        or "fits" in content_type.lower()
        or raw_url.lower().split("?")[0].endswith((".fits", ".fit", ".fts"))
    )
    if is_fits:
        try:
            b64, stats = fits_to_base64_png(body, colormap="inferno")
        except (UpstreamArchiveError, Exception) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {
            "source_type": "FITS_IMAGE",
            "url": raw_url,
            "byte_length": len(body),
            "data_url": f"data:image/png;base64,{b64}",
            "stats": stats,
            "content_type": content_type,
        }

    text = body.decode("utf-8", errors="replace")
    simbad_match = re.search(
        r"Coordinates\(ICRS[^\)]*\):\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([+\-0-9.]+)\s+([0-9.]+)\s+([0-9.]+)",
        text,
    )
    coordinates = None
    if simbad_match:
        rah, ram, ras, decd, decm, decs = (float(v) for v in simbad_match.groups())
        coordinates = {
            "ra": (rah + ram / 60 + ras / 3600) * 15,
            "dec": (-1 if simbad_match.group(4).startswith("-") else 1)
            * (abs(decd) + decm / 60 + decs / 3600),
        }
    return {
        "source_type": "SIMBAD_METADATA" if "simbad" in raw_url.lower() else "GENERIC_URL",
        "url": raw_url,
        "byte_length": len(body),
        "detected_coordinates": coordinates,
        "raw_preview": text[:1200],
        "content_type": content_type,
    }
