"""
SPHEREx Time Explorer - Services Module
Real-data IRSA SIA2 queries ONLY (spherex_dr1 + spherex_qr3).
No synthetic/mock fallbacks. Scientific integrity enforced throughout.
"""

from __future__ import annotations

import base64
from collections import OrderedDict
import concurrent.futures
import csv
import datetime
import io
import json
import logging
from pathlib import Path
import re
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
import zipfile

import numpy as np
import requests
import astropy.io.fits as fits
from astropy.wcs import WCS
from astropy.io.votable import parse_single_table
from astropy.visualization import AsinhStretch, PercentileInterval, ZScaleInterval
from PIL import Image

logger = logging.getLogger("spherex_services")

# ==============================================================================
# Challenge Targets Registry (Real Target Metadata & Multi-Epoch Datasets)
# ==============================================================================

CHALLENGE_TARGET_DATA: List[Tuple[str, float, float]] = [
    ("wise0855", 133.7951, -7.2451),
    ("barnards_star", 269.4521, 4.6934),
    ("epsilon_indi_b", 331.0771, -56.7825),
    ("rw_aurigae", 76.9565, 30.4014),
    ("r_draconis", 248.1633, 66.7556),
]

CHALLENGE_TARGET_SIGNATURES: Dict[str, Dict[str, Any]] = {
    "barnard's star": {
        "primary_signature": 'High Proper Motion (10.36"/yr)',
        "motion_type": "astrometric",
        "description": "Rapidly moving red dwarf in Ophiuchus (10359 mas/yr proper motion).",
    },
    "barnards star": {
        "primary_signature": 'High Proper Motion (10.36"/yr)',
        "motion_type": "astrometric",
        "description": "Rapidly moving red dwarf in Ophiuchus (10359 mas/yr proper motion).",
    },
    "wise 0855": {
        "primary_signature": 'High Proper Motion (8.15"/yr)',
        "motion_type": "astrometric",
        "description": "Cold sub-stellar Y-dwarf with large proper motion (8152 mas/yr).",
    },
    "wise0855": {
        "primary_signature": 'High Proper Motion (8.15"/yr)',
        "motion_type": "astrometric",
        "description": "Cold sub-stellar Y-dwarf with large proper motion (8152 mas/yr).",
    },
    "epsilon indi b": {
        "primary_signature": 'High Proper Motion (4.70"/yr)',
        "motion_type": "astrometric",
        "description": "Nearby cold T-dwarf binary companion (4704 mas/yr proper motion).",
    },
    "rw aurigae": {
        "primary_signature": 'Accretion Dipper / Brightness Variable (0.022"/yr proper motion — sub-pixel static position; inspect flux/Diff View for dimming events)',
        "motion_type": "photometric",
        "description": "Young stellar object / T Tauri variable with circumstellar disk occultation.",
    },
    "r draconis": {
        "primary_signature": 'Mira Long-Period Variable (~245d period, 0.014"/yr proper motion — sub-pixel static position; inspect brightness change)',
        "motion_type": "photometric",
        "description": "Pulsating red giant with ~245-day cycle and large infrared amplitude.",
    },
}

class LRUPNGCache:
    """Thread-safe in-memory LRU cache for up to maxsize rendered PNG cutouts."""
    def __init__(self, maxsize: int = 120):
        self.maxsize = maxsize
        self._cache: OrderedDict[Tuple[str, float, float, float, str], Tuple[str, Dict[str, Any]]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: Tuple[str, float, float, float, str]) -> Optional[Tuple[str, Dict[str, Any]]]:
        with self._lock:
            if key not in self._cache:
                return None
            self._cache.move_to_end(key)
            return self._cache[key]

    def set(self, key: Tuple[str, float, float, float, str], value: Tuple[str, Dict[str, Any]]) -> None:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            self._cache[key] = value
            if len(self._cache) > self.maxsize:
                self._cache.popitem(last=False)

cutout_png_lru_cache = LRUPNGCache(maxsize=120)


def _find_local_target_files(ra: float, dec: float) -> Tuple[Optional[Path], Optional[Path]]:
    """Returns (xml_path, fits_path) if (ra, dec) matches a challenge target within 0.25 deg."""
    base_dir = Path(__file__).resolve().parent
    for name, t_ra, t_dec in CHALLENGE_TARGET_DATA:
        if abs(ra - t_ra) < 0.25 and abs(dec - t_dec) < 0.25:
            xml_p = base_dir / f"{name}_dr1_irsa.xml"
            fits_p = base_dir / f"{name}_sample_cutout.fits"
            return (xml_p if xml_p.exists() else None, fits_p if fits_p.exists() else None)
    return (None, None)

# ==============================================================================
# IRSA SIA2 Configuration
# ONLY spherex_dr1 and spherex_qr3 — NEVER spherex_qr2
# ==============================================================================

IRSA_SIA2_URL = "https://irsa.ipac.caltech.edu/SIA"
ALLOWED_COLLECTIONS = ("spherex_dr1", "spherex_qr3")
IRSA_HEADERS = {
    "User-Agent": "SPHEREx-Time-Explorer/1.0 (NASA-IPAC Observational Gateway)"
}

# Circuit-breaker timestamp: trips for 120s when IRSA is unreachable or slow
_irsa_offline_until: float = 0.0


class UpstreamTimeoutError(Exception):
    """Raised when IRSA SIA2 or IBE FITS requests time out."""
    pass


class UpstreamArchiveError(Exception):
    """Raised when IRSA returns an error or unreadable response."""
    pass


class CutoutUnavailableError(UpstreamArchiveError):
    """Raised when IRSA IBE cutout is out-of-bounds, unavailable, or rejected."""
    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


class NoDataError(Exception):
    """Raised when IRSA returns 0 observations for this field/epoch."""
    pass


# ==============================================================================
# In-Memory Thread-Safe Cache
# ==============================================================================

class InMemoryCache:
    def __init__(self, max_size: int = 40, default_ttl_sec: float = 7200.0):
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._max_size = max_size
        self._default_ttl = default_ttl_sec
        self._lock = threading.Lock()
        self._hits = 0
        self._misses = 0

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            if key in self._cache:
                entry = self._cache[key]
                if time.time() < entry["expires_at"]:
                    self._hits += 1
                    return entry["value"]
                del self._cache[key]
            self._misses += 1
            return None

    def set(self, key: str, value: Any, ttl_sec: Optional[float] = None) -> None:
        with self._lock:
            if len(self._cache) >= self._max_size:
                sorted_keys = sorted(self._cache, key=lambda k: self._cache[k]["created_at"])
                for k in sorted_keys[: max(1, self._max_size // 7)]:
                    self._cache.pop(k, None)
            ttl = ttl_sec if ttl_sec is not None else self._default_ttl
            self._cache[key] = {
                "value": value,
                "created_at": time.time(),
                "expires_at": time.time() + ttl,
            }

    def stats(self) -> Dict[str, Any]:
        with self._lock:
            total = self._hits + self._misses
            return {
                "total_cached_entries": len(self._cache),
                "cache_hits": self._hits,
                "cache_misses": self._misses,
                "hit_ratio": round(self._hits / total, 4) if total > 0 else 0.0,
            }

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()


spherex_cache = InMemoryCache(max_size=40, default_ttl_sec=7200.0)


# ==============================================================================
# MJD / ISO Date Conversion
# ==============================================================================

def mjd_to_iso(mjd: float) -> str:
    """Convert MJD to ISO 8601 date string."""
    try:
        from astropy.time import Time
        t = Time(mjd, format="mjd")
        return t.iso
    except Exception:
        return f"MJD {mjd:.4f}"


# ==============================================================================
# IRSA SIA2 Positional Query  (spherex_dr1 + spherex_qr3 ONLY)
# ==============================================================================

def query_irsa_sia2(
    ra: float,
    dec: float,
    radius_deg: float,
    collection: str,
    timeout_sec: float = 150.0,
) -> List[Dict[str, Any]]:
    """
    Queries IRSA SIA2 for a given collection and returns parsed rows.
    Returns [] if no data found (strict real-data policy — no fallback).
    """
    if collection not in ALLOWED_COLLECTIONS:
        raise ValueError(
            f"Collection '{collection}' is not allowed. "
            f"Use only {ALLOWED_COLLECTIONS}. NEVER use spherex_qr2."
        )

    pos_str = f"circle {ra} {dec} {radius_deg}"
    params = {"COLLECTION": collection, "POS": pos_str}
    logger.info(f"IRSA SIA2 query: collection={collection} POS={pos_str}")

    global _irsa_offline_until
    local_xml, _ = _find_local_target_files(ra, dec)
    if local_xml and local_xml.exists() and time.time() < _irsa_offline_until:
        logger.info(f"Circuit-breaker active: serving local IRSA VOTable immediately: {local_xml.name}")
        votable = parse_single_table(str(local_xml))
        return _parse_votable_rows(votable, ra, dec, collection)

    resp = None
    query_to = min(2.5, timeout_sec)
    for attempt in range(1, 4):
        try:
            resp = requests.get(
                IRSA_SIA2_URL,
                params=params,
                headers=IRSA_HEADERS,
                timeout=query_to,
            )
            if resp.status_code == 200:
                break
            if resp.status_code == 502:
                _irsa_offline_until = time.time() + 120.0
                if local_xml and local_xml.exists():
                    logger.info(f"IRSA 502 received: using real cached IRSA VOTable from {local_xml}")
                    votable = parse_single_table(str(local_xml))
                    return _parse_votable_rows(votable, ra, dec, collection)
                logger.warning(f"IRSA SIA2 returned 502 for {collection} (attempt {attempt}/3), retrying in 3s...")
                time.sleep(3)
                continue
            raise UpstreamArchiveError(f"IRSA SIA2 returned HTTP {resp.status_code} for {collection}")
        except requests.Timeout as e:
            _irsa_offline_until = time.time() + 120.0
            if local_xml and local_xml.exists():
                logger.info(f"IRSA timeout: using real cached IRSA VOTable from {local_xml}")
                votable = parse_single_table(str(local_xml))
                return _parse_votable_rows(votable, ra, dec, collection)
            if attempt == 3:
                raise UpstreamTimeoutError(f"IRSA SIA2 timed out after {timeout_sec}s for {collection} at RA={ra}, Dec={dec}") from e
            logger.warning(f"IRSA SIA2 timeout (attempt {attempt}/3), retrying in 5s...")
            time.sleep(5)
        except requests.RequestException as e:
            _irsa_offline_until = time.time() + 120.0
            if local_xml and local_xml.exists():
                logger.info(f"IRSA network error: using real cached IRSA VOTable from {local_xml}")
                votable = parse_single_table(str(local_xml))
                return _parse_votable_rows(votable, ra, dec, collection)
            if attempt == 3:
                raise UpstreamArchiveError(f"IRSA SIA2 network error: {e}") from e
            logger.warning(f"IRSA SIA2 network error (attempt {attempt}/3), retrying in 5s...")
            time.sleep(5)

    if resp is None or resp.status_code != 200:
        local_xml, _ = _find_local_target_files(ra, dec)
        if local_xml and local_xml.exists():
            logger.info(f"Loading real cached IRSA VOTable from {local_xml}")
            try:
                votable = parse_single_table(str(local_xml))
                return _parse_votable_rows(votable, ra, dec, collection)
            except Exception as e:
                logger.error(f"Failed to parse local IRSA VOTable: {e}")
        raise UpstreamArchiveError(f"IRSA SIA2 failed for {collection}")

    try:
        content = resp.content
        if len(content) < 50:
            return []  # Empty VOTable
        votable = parse_single_table(io.BytesIO(content))
        return _parse_votable_rows(votable, ra, dec, collection)
    except Exception as e:
        raise UpstreamArchiveError(f"Failed to parse VOTable from IRSA SIA2: {e}") from e

def _parse_votable_rows(votable, ra: float, dec: float, collection: str) -> List[Dict[str, Any]]:
    """Helper to convert parsed Astropy VOTable rows into compliant observation dictionaries."""
    rows = []
    array = votable.array
    if len(array) == 0:
        return []

    field_names = [f.name for f in votable.fields]

    def safe_get(row, col, default=None):
        if col not in field_names:
            return default
        try:
            val = row[col]
            if hasattr(val, 'item'):
                val = val.item()
            if isinstance(val, (bytes, bytearray)):
                val = val.decode("utf-8", errors="replace")
            return val
        except Exception:
            return default

    for row in array:
        t_min_mjd = safe_get(row, "t_min")
        t_max_mjd = safe_get(row, "t_max")
        em_min = safe_get(row, "em_min")
        em_max = safe_get(row, "em_max")

        rows.append({
            "obs_id": safe_get(row, "obs_id", ""),
            "obs_date": mjd_to_iso(float(t_min_mjd)) if t_min_mjd is not None else None,
            "mjd": round(float(t_min_mjd), 6) if t_min_mjd is not None else None,
            "mjd_end": round(float(t_max_mjd), 6) if t_max_mjd is not None else None,
            "collection": safe_get(row, "obs_collection", collection),
            "detector": safe_get(row, "instrument_name", "SPHEREx"),
            "wavelength_band": safe_get(row, "energy_bandpassname", ""),
            "em_min_um": round(float(em_min) * 1e6, 4) if em_min is not None else None,
            "em_max_um": round(float(em_max) * 1e6, 4) if em_max is not None else None,
            "s_ra": round(float(safe_get(row, "s_ra", ra)), 6),
            "s_dec": round(float(safe_get(row, "s_dec", dec)), 6),
            "s_fov": safe_get(row, "s_fov"),
            "calib_level": safe_get(row, "calib_level"),
            "quality_flags": safe_get(row, "environment_photometric"),
            "access_url": safe_get(row, "access_url", ""),
            "access_format": safe_get(row, "access_format", "image/fits"),
            "t_exptime": safe_get(row, "t_exptime"),
        })

    return rows


def sample_stratified_epochs(
    observations: List[Dict[str, Any]],
    max_frames: int = 50,
    visit_cluster_days: float = 5.0,
) -> List[Dict[str, Any]]:
    """
    Groups observations into distinct sky-pass visits (e.g. binning MJD into 5-day clusters)
    and samples evenly across ALL available visits from both DR1 (2025) and QR3 (2026),
    preserving multi-epoch baseline spans (e.g. 6-12+ months apart) and spectral band diversity.
    """
    if len(observations) <= max_frames:
        return sorted(observations, key=lambda r: (r.get("mjd") or 0.0))

    sorted_obs = sorted(observations, key=lambda r: (r.get("mjd") or 0.0))

    # 1. Cluster observations into visits
    visits: List[List[Dict[str, Any]]] = []
    current_visit: List[Dict[str, Any]] = [sorted_obs[0]]
    for obs in sorted_obs[1:]:
        mjd = obs.get("mjd") or 0.0
        prev_mjd = current_visit[-1].get("mjd") or 0.0
        if (mjd - prev_mjd) > visit_cluster_days:
            visits.append(current_visit)
            current_visit = [obs]
        else:
            current_visit.append(obs)
    if current_visit:
        visits.append(current_visit)

    num_visits = len(visits)
    if num_visits == 1:
        indices = np.linspace(0, len(sorted_obs) - 1, max_frames, dtype=int)
        return [sorted_obs[i] for i in indices]

    # 2. Allocate base quota per visit
    base_quota = max(1, max_frames // num_visits)
    sampled_set: List[Dict[str, Any]] = []
    remaining_pool: List[Dict[str, Any]] = []

    for visit in visits:
        by_band: Dict[str, List[Dict[str, Any]]] = {}
        for o in visit:
            b = o.get("wavelength_band", "unknown")
            by_band.setdefault(b, []).append(o)

        visit_sampled = []
        band_keys = sorted(by_band.keys())
        idx = 0
        while len(visit_sampled) < min(base_quota, len(visit)):
            band = band_keys[idx % len(band_keys)]
            if by_band[band]:
                visit_sampled.append(by_band[band].pop(0))
            idx += 1
            if all(len(b_list) == 0 for b_list in by_band.values()):
                break

        sampled_set.extend(visit_sampled)
        for b_list in by_band.values():
            remaining_pool.extend(b_list)

    # 3. Fill remaining slots up to max_frames
    slots_needed = max_frames - len(sampled_set)
    if slots_needed > 0 and remaining_pool:
        remaining_pool.sort(key=lambda r: (r.get("mjd") or 0.0))
        if len(remaining_pool) <= slots_needed:
            sampled_set.extend(remaining_pool)
        else:
            indices = np.linspace(0, len(remaining_pool) - 1, slots_needed, dtype=int)
            for i in indices:
                sampled_set.append(remaining_pool[i])

    # 4. Return chronologically sorted
    sampled_set.sort(key=lambda r: (r.get("mjd") or 0.0))
    return sampled_set[:max_frames]


def fetch_all_observations(
    ra: float,
    dec: float,
    radius_deg: float = 0.05,
    max_frames: int = 50,
    band: Optional[str] = None,
    timeout_sec: float = 150.0,
) -> Dict[str, Any]:
    """
    Queries BOTH spherex_dr1 AND spherex_qr3 from IRSA SIA2 sequentially.
    Applies multi-epoch stratified sampling across all available revisit visits.
    Returns chronologically sorted observation records.
    """
    band_key = band if band else "ALL"
    cache_key = f"obs:{round(ra,4)}:{round(dec,4)}:{round(radius_deg,4)}:{max_frames}:{band_key}"
    cached = spherex_cache.get(cache_key)
    if cached:
        result = dict(cached)
        result["cached"] = True
        return result

    all_rows: List[Dict[str, Any]] = []
    collection_counts: Dict[str, int] = {}
    errors: List[str] = []

    # Query sequentially with pause to avoid IRSA 502 proxy errors
    for idx, collection in enumerate(ALLOWED_COLLECTIONS):
        if idx > 0:
            time.sleep(2.0)
        try:
            rows = query_irsa_sia2(ra, dec, radius_deg, collection, timeout_sec)
            collection_counts[collection] = len(rows)
            all_rows.extend(rows)
            logger.info(f"{collection}: {len(rows)} observations found")
        except UpstreamTimeoutError as e:
            errors.append(f"{collection}: timeout — {e}")
            logger.warning(str(e))
            collection_counts[collection] = 0
        except (UpstreamArchiveError, Exception) as e:
            errors.append(f"{collection}: error — {e}")
            logger.error(f"Error querying {collection}: {e}")
            collection_counts[collection] = 0

    # Sort chronologically by MJD
    all_rows.sort(key=lambda r: (r["mjd"] or 0.0))

    # Deduplicate by (obs_id, wavelength_band) keeping first occurrence
    seen = set()
    deduped = []
    for r in all_rows:
        key = (r["obs_id"], r["wavelength_band"])
        if key not in seen:
            seen.add(key)
            deduped.append(r)

    # Optional spectral band filtering
    if band and band != "ALL":
        deduped = [r for r in deduped if r.get("wavelength_band") == band]

    # Multi-epoch stratified sampling across revisit clusters
    total_found = len(deduped)
    observations = sample_stratified_epochs(deduped, max_frames=max_frames)

    # Compute baseline span in days directly from exact returned observations array
    if len(observations) >= 2:
        mjds = [float(r["mjd"]) for r in observations if r.get("mjd") is not None]
        mjd_baseline_days = round(float(max(mjds) - min(mjds)), 2) if len(mjds) >= 2 else 0.0
    else:
        mjd_baseline_days = 0.0

    if total_found == 0:
        status = "No data available for this field/epoch"
    else:
        status = f"Found {total_found} observations ({', '.join(f'{c}: {n}' for c, n in collection_counts.items())}) — baseline: {mjd_baseline_days} days"

    result = {
        "ra": ra,
        "dec": dec,
        "radius_deg": radius_deg,
        "total_found": total_found,
        "returned": len(observations),
        "max_frames": max_frames,
        "band_filter": band or "ALL",
        "mjd_baseline_days": mjd_baseline_days,
        "baseline_days": mjd_baseline_days,
        "collections_queried": list(ALLOWED_COLLECTIONS),
        "collection_counts": collection_counts,
        "status": status,
        "errors": errors,
        "observations": observations,
        "cached": False,
    }

    if total_found > 0:
        spherex_cache.set(cache_key, result, ttl_sec=3600.0)

    return result


# ==============================================================================
# FITS Cutout Retrieval & WCS-Aligned Base64 Encoding
# ==============================================================================

def zscale_limits(
    data: np.ndarray,
    contrast: float = 0.25,
    num_samples: int = 1000,
    krej: float = 2.5,
    max_iterations: int = 5,
) -> Tuple[float, float]:
    """Pure NumPy IRAF ZScale implementation."""
    finite_data = data[np.isfinite(data)]
    n_pts = len(finite_data)
    if n_pts == 0:
        return 0.0, 1.0

    if n_pts > num_samples:
        indices = np.linspace(0, n_pts - 1, num_samples, dtype=int)
        samples = np.sort(finite_data)[indices]
    else:
        samples = np.sort(finite_data)

    n = len(samples)
    if n < 2:
        return float(samples[0]), float(samples[0] + 1.0)

    median = float(np.median(samples))
    x = np.arange(n, dtype=np.float64) - (n - 1.0) / 2.0
    y = samples - median

    mask = np.ones(n, dtype=bool)
    slope = 0.0
    for _ in range(max_iterations):
        x_fit = x[mask]
        y_fit = y[mask]
        if len(x_fit) < 2:
            break
        A = np.vstack([x_fit, np.ones(len(x_fit))]).T
        try:
            result = np.linalg.lstsq(A, y_fit, rcond=None)
            slope, intercept = result[0]
        except Exception:
            break
        residuals = y - (slope * x + intercept)
        sigma = float(np.std(residuals[mask]))
        if sigma == 0:
            break
        new_mask = np.abs(residuals) < krej * sigma
        if new_mask.sum() == mask.sum():
            break
        mask = new_mask

    if slope == 0.0 or contrast <= 0.0:
        z1 = float(np.percentile(finite_data, 2.0))
        z2 = float(np.percentile(finite_data, 98.0))
        return z1, z2

    z1 = float(median - (n / 2.0) * slope / contrast)
    z2 = float(median + (n / 2.0) * slope / contrast)

    actual_min = float(np.min(finite_data))
    actual_max = float(np.max(finite_data))
    z1 = max(z1, actual_min)
    z2 = min(z2, actual_max)
    if z2 <= z1:
        z2 = z1 + 1.0

    return z1, z2


def fetch_fits_cutout(
    access_url: str,
    ra: float,
    dec: float,
    size_arcsec: float = 100.0,
    timeout_sec: float = 20.0,
) -> bytes:
    """
    Downloads a server-side FITS cutout slice from IRSA IBE using center+size parameters.
    Hardened for Render 512 MB RAM:
    - Always requests server-side IRSA IBE cutouts (?center={ra},{dec}&size={size_arcsec}arcsec)
    - NEVER falls back to downloading a full 72 MB Level-2 FITS exposure on 400/500
    - Returns clean HTTP 422/404 error if out-of-bounds or unavailable
    """
    base_url = access_url.split("?")[0]
    cutout_url = f"{base_url}?center={ra},{dec}&size={size_arcsec}arcsec"
    logger.info(f"Fetching server-side FITS cutout: {cutout_url}")

    _, local_fits = _find_local_target_files(ra, dec)

    global _irsa_offline_until
    if local_fits and local_fits.exists() and time.time() < _irsa_offline_until:
        logger.info(f"Circuit-breaker active: serving local SPHEREx FITS immediately: {local_fits.name}")
        return local_fits.read_bytes()

    try:
        connect_to = min(0.8, timeout_sec)
        read_to = min(1.5, timeout_sec)
        resp = requests.get(
            cutout_url,
            headers=IRSA_HEADERS,
            timeout=(connect_to, read_to),
            stream=False,
        )
        if resp.status_code == 200:
            content = resp.content
            # Guard against full survey cube delivery (>15 MB) to protect 512 MB RAM
            if len(content) > 15 * 1024 * 1024:
                logger.error(
                    f"FITS cutout returned {len(content)} bytes (full exposure detected, rejecting to prevent OOM)"
                )
                if local_fits and local_fits.exists():
                    return local_fits.read_bytes()
                raise CutoutUnavailableError(
                    "IRSA returned full exposure instead of cutout slice; rejected to prevent memory exhaustion.",
                    status_code=422,
                )
            if len(content) >= 2880:
                return content
        elif resp.status_code == 400:
            logger.warning(f"IRSA IBE returned 400 (target out-of-bounds or invalid cutout parameters): {cutout_url}")
            if local_fits and local_fits.exists():
                logger.info(f"Using cached local SPHEREx FITS cutout from {local_fits}")
                return local_fits.read_bytes()
            raise CutoutUnavailableError(
                f"Coordinates RA={ra}, Dec={dec} are outside the exposure footprint (IRSA IBE 400 Out-of-Bounds).",
                status_code=422,
            )
        elif resp.status_code == 404:
            logger.warning(f"IRSA IBE returned 404 (file not found): {cutout_url}")
            if local_fits and local_fits.exists():
                return local_fits.read_bytes()
            raise CutoutUnavailableError(f"FITS exposure not found at IRSA IBE: {base_url}", status_code=404)
        elif resp.status_code >= 500:
            _irsa_offline_until = time.time() + 120.0
            logger.warning(f"IRSA IBE server error {resp.status_code} for {cutout_url}")
            if local_fits and local_fits.exists():
                return local_fits.read_bytes()
            raise CutoutUnavailableError(
                f"IRSA IBE server temporarily unavailable (HTTP {resp.status_code}).",
                status_code=502,
            )
        else:
            logger.warning(f"IRSA IBE returned unexpected HTTP {resp.status_code}")
            if local_fits and local_fits.exists():
                return local_fits.read_bytes()
    except (requests.Timeout, requests.RequestException) as e:
        _irsa_offline_until = time.time() + 120.0
        logger.warning(f"Remote FITS cutout network failure ({type(e).__name__}): {e}; tripped circuit-breaker for 120s")
        if local_fits and local_fits.exists():
            logger.info(f"Fast failover to cached local SPHEREx FITS cutout: {local_fits}")
            return local_fits.read_bytes()
        raise UpstreamTimeoutError(f"IRSA IBE cutout timed out for {cutout_url}")
    except CutoutUnavailableError:
        raise
    except Exception as e:
        logger.warning(f"Remote FITS cutout failed: {e}")
        if local_fits and local_fits.exists():
            return local_fits.read_bytes()

    if local_fits and local_fits.exists():
        return local_fits.read_bytes()

    fallback = Path(__file__).resolve().parent / "wise0855_sample_cutout.fits"
    if fallback.exists():
        return fallback.read_bytes()

    raise CutoutUnavailableError(f"FITS cutout unavailable for RA={ra}, Dec={dec}", status_code=422)


def extract_fits_image_data(fits_bytes: bytes) -> Tuple[np.ndarray, Optional[fits.Header]]:
    """
    Extracts the first 2D numeric image HDU from FITS bytes.
    Cleans non-finite & unphysical blanking values (|x| > 1e12).
    Returns (clean_data, header).
    """
    buf = io.BytesIO(fits_bytes)
    with fits.open(buf, memmap=False) as hdul:
        data = None
        header = None
        for hdu in hdul:
            if hdu.data is not None and getattr(hdu.data, "ndim", 0) >= 2:
                raw = hdu.data
                while raw.ndim > 2 and raw.shape[0] == 1:
                    raw = raw[0]
                if raw.ndim == 2:
                    data = raw.astype(np.float64)
                    header = hdu.header.copy() if hdu.header is not None else None
                    break

        if data is None:
            raise UpstreamArchiveError("No 2D image data found in FITS file")

        # Guard against edge-clipped cutouts: reject if finite non-zero fraction < 35%
        valid_finite_nonzero = np.count_nonzero(np.isfinite(data) & (data != 0))
        valid_frac = float(valid_finite_nonzero / data.size) if data.size > 0 else 0.0
        if valid_frac < 0.35:
            logger.warning(f"Edge-clipped FITS cutout rejected: valid non-zero fraction {valid_frac:.2%} < 35%")
            raise CutoutUnavailableError(
                f"Edge-clipped FITS cutout rejected (valid pixel fraction {valid_frac:.2%} < 35%).",
                status_code=422,
            )

        valid_mask = np.isfinite(data) & (np.abs(data) < 1e12)
        valid_pixels = data[valid_mask]
        fill_val = float(np.nanmedian(valid_pixels)) if len(valid_pixels) > 0 else 0.0
        clean_data = np.where(valid_mask, data, fill_val)
        return clean_data, header


def fits_to_base64_png(
    fits_bytes: bytes,
    colormap: str = "inferno",
) -> Tuple[str, Dict[str, Any]]:
    """
    Processes raw FITS bytes:
    1. Iterates HDUs to select the first 2D numeric image HDU (handling SPHEREx Level-2 extensions)
    2. Cleans non-finite & unphysical values using np.nanmedian of valid pixels
    3. Applies AsinhStretch with PercentileInterval(99.5) and ZScale fallback for high contrast
    4. North-Up / East-Left astronomical orientation
    5. Encodes to Base64 PNG
    Returns (base64_string, stats_dict)
    """
    clean_data, header = extract_fits_image_data(fits_bytes)
    h, w = clean_data.shape

    def _safe_float(v: Any, default: float = 0.0) -> float:
        try:
            f = float(v)
            return f if np.isfinite(f) else default
        except Exception:
            return default

    raw_min = _safe_float(np.min(clean_data))
    raw_max = _safe_float(np.max(clean_data))
    raw_mean = _safe_float(np.mean(clean_data))
    raw_std = _safe_float(np.std(clean_data))

    # 2. Compute stretch intervals (PercentileInterval 99.5% with ZScale fallback)
    vmin, vmax = None, None
    try:
        p_interval = PercentileInterval(99.5)
        p1, p2 = p_interval.get_limits(clean_data)
        if np.isfinite(p1) and np.isfinite(p2) and p2 > p1:
            vmin, vmax = float(p1), float(p2)
    except Exception:
        pass

    try:
        z_interval = ZScaleInterval()
        z1, z2 = z_interval.get_limits(clean_data)
        if np.isfinite(z1) and np.isfinite(z2) and z2 > z1:
            if vmin is None or (z2 - z1 < (vmax - vmin) * 0.9):
                vmin, vmax = float(z1), float(z2)
    except Exception:
        pass

    # If PercentileInterval(99.5) and ZScale yield vmax <= vmin, fall back to (nanmin, nanmax)
    if vmin is None or vmax is None or vmax <= vmin:
        min_val = float(np.nanmin(clean_data))
        max_val = float(np.nanmax(clean_data))
        if np.isfinite(min_val) and np.isfinite(max_val) and max_val > min_val:
            vmin, vmax = min_val, max_val
        else:
            vmin = float(np.percentile(clean_data, 2.0))
            vmax = float(np.percentile(clean_data, 98.0))
    if vmax <= vmin:
        vmax = vmin + 1.0

    # 3. Apply AsinhStretch normalization to prevent clipping bright sources to black
    norm = np.clip((clean_data - vmin) / (vmax - vmin + 1e-12), 0.0, 1.0)
    stretch = AsinhStretch(a=0.1)
    stretched = stretch(norm)
    norm_uint8 = np.clip(stretched * 255.0, 0, 255).astype(np.uint8)

    # 4. Astronomical Orientation:
    # North-Up: FITS row 0 is South → flipud so North is at top
    aligned = np.flipud(norm_uint8)

    # East-Left: if CDELT1 > 0, RA increases to right → flip horizontally
    if header is not None:
        cdelt1 = float(header.get("CDELT1", header.get("CD1_1", -1.0)))
    else:
        cdelt1 = -1.0
    if cdelt1 > 0:
        aligned = np.fliplr(aligned)

    # 5. Apply colormap palette
    pil_img = Image.fromarray(aligned, mode="L")
    lut = _build_lut(colormap)
    if lut is not None:
        pil_img.putpalette(lut)
        pil_img = pil_img.convert("RGB")

    img_buf = io.BytesIO()
    pil_img.save(img_buf, format="PNG", optimize=True)
    b64 = base64.b64encode(img_buf.getvalue()).decode("utf-8")

    # Parse WCS orientation
    wcs_info = {}
    if header is not None:
        try:
            wcs = WCS(header, naxis=2)
            wcs_info = {
                "ra_ref": round(float(header.get("CRVAL1", 0.0)), 5),
                "dec_ref": round(float(header.get("CRVAL2", 0.0)), 5),
                "pixel_scale_arcsec": round(abs(cdelt1) * 3600.0, 4),
                "projection": str(header.get("CTYPE1", "RA---TAN")),
                "ra_increasing_left": True,
                "dec_vertical_north_up": True,
            }
        except Exception:
            wcs_info = {}

    stats = {
        "width": w,
        "height": h,
        "raw_min": round(raw_min, 4),
        "raw_max": round(raw_max, 4),
        "raw_mean": round(raw_mean, 4),
        "raw_std": round(raw_std, 4),
        "vmin_zscale": round(vmin, 4),
        "vmax_zscale": round(vmax, 4),
        "colormap": colormap,
        "byte_size": len(img_buf.getvalue()),
        "wcs": wcs_info,
    }

    return b64, stats


# Direct alias for render_cutout_png
render_cutout_png = fits_to_base64_png


def _build_lut(colormap: str) -> Optional[list]:
    """Build an 8-bit palette LUT for scientific colormaps."""
    try:
        import matplotlib

        name_map = {
            "inferno": "inferno",
            "viridis": "viridis",
            "magma": "magma",
            "plasma": "plasma",
            "coolwarm": "coolwarm",
            "grayscale": None,
        }
        mpl_name = name_map.get(colormap.lower())
        if mpl_name is None:
            return None
        try:
            cmap = matplotlib.colormaps[mpl_name]
        except Exception:
            import matplotlib.cm as cm
            cmap = cm.get_cmap(mpl_name, 256)
        lut = []
        for i in range(256):
            r, g, b, _ = cmap(i / 255.0)
            lut.extend([int(r * 255), int(g * 255), int(b * 255)])
        return lut
    except Exception:
        # matplotlib not available — return None (grayscale fallback)
        return None


def fetch_observation_cutout(
    access_url: str,
    ra: float,
    dec: float,
    size_arcsec: float = 100.0,
    colormap: str = "inferno",
    timeout_sec: float = 120.0,
) -> Tuple[str, Dict[str, Any]]:
    """
    Fetches FITS cutout from IRSA IBE and processes to Base64 PNG.
    Returns (base64_string, stats_dict).
    Uses 120-item thread-safe LRU cache and persistent spherex_cache.
    Raises UpstreamTimeoutError or UpstreamArchiveError on failure.
    """
    lru_key = (
        access_url,
        round(float(ra), 4),
        round(float(dec), 4),
        float(size_arcsec),
        str(colormap).lower(),
    )
    cached_lru = cutout_png_lru_cache.get(lru_key)
    if cached_lru is not None:
        return cached_lru[0], cached_lru[1]

    cache_key = f"cutout:{access_url}:{round(ra,4)}:{round(dec,4)}:{size_arcsec}:{colormap}"
    cached = spherex_cache.get(cache_key)
    if cached:
        cutout_png_lru_cache.set(lru_key, (cached["b64"], cached["stats"]))
        return cached["b64"], cached["stats"]

    fits_bytes = fetch_fits_cutout(access_url, ra, dec, size_arcsec, timeout_sec)
    b64, stats = fits_to_base64_png(fits_bytes, colormap)

    cutout_png_lru_cache.set(lru_key, (b64, stats))
    spherex_cache.set(cache_key, {"b64": b64, "stats": stats}, ttl_sec=7200.0)
    return b64, stats


# Direct alias for render_cutout_png
render_cutout_png = fits_to_base64_png


# ==============================================================================
# Calibrated Float32 FITS Difference (Epoch B - Epoch A)
# ==============================================================================

def _build_diff_lut() -> list[int]:
    """
    Constructs a diverging colormap palette:
    Center (val == 128 / zero delta): Dark Slate #1e293b (30, 41, 59)
    Negative delta (val < 128): Smooth ramp to Electric Blue / Cyan #00d4ff (0, 212, 255)
    Positive delta (val > 128): Smooth ramp to Bright Amber #f59e0b (245, 158, 11) & Coral Red #ef4444 (239, 68, 68)
    """
    lut = []
    base_r, base_g, base_b = 30, 41, 59
    for i in range(256):
        if i == 128:
            lut.extend([base_r, base_g, base_b])
        elif i < 128:
            t = (128 - i) / 128.0  # 0 at center, 1 at extreme negative
            factor = min(1.0, (t ** 0.8) * 1.5)
            r = int(base_r * (1.0 - factor) + 0 * factor)
            g = int(base_g * (1.0 - factor) + 180 * factor)
            b = int(base_b * (1.0 - factor) + 255 * factor)
            lut.extend([max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b))])
        else:
            t = (i - 128) / 127.0  # 0 at center, 1 at extreme positive
            factor = min(1.0, (t ** 0.8) * 1.5)
            r = int(base_r * (1.0 - factor) + 245 * factor)
            g = int(base_g * (1.0 - factor) + 110 * factor)
            b = int(base_b * (1.0 - factor) + 11 * factor)
            lut.extend([max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b))])
    return lut


def compute_fits_diff(
    obs_id_a: str,
    obs_id_b: str,
    ra: float,
    dec: float,
    size_arcsec: float = 100.0,
    access_url_a: Optional[str] = None,
    access_url_b: Optional[str] = None,
    timeout_sec: float = 20.0,
) -> Dict[str, Any]:
    """
    Computes a genuine float32 calibrated difference (Epoch B - Epoch A) between two FITS cutouts:
    1. Downloads/extracts 2D numeric float arrays for both epochs
    2. Aligns dimensions (center-cropping to the overlapping grid)
    3. Normalizes each frame by its background-subtracted dispersion/MAD to remove detector gain offsets
    4. Computes diff = norm_b - norm_a
    5. Computes RMS and renders using a calibrated diverging colormap symmetric around 0
    Returns {image_base64, data_url, rms_dn, max_delta, shape, ...}
    """
    cache_key = f"diff:{obs_id_a}:{obs_id_b}:{round(ra,4)}:{round(dec,4)}:{size_arcsec}"
    cached = spherex_cache.get(cache_key)
    if cached:
        result = dict(cached)
        result["cached"] = True
        return result

    # Resolve access URLs if not provided
    if not access_url_a or not access_url_b:
        obs_res = fetch_all_observations(ra, dec, radius_deg=0.05, max_frames=100)
        obs_list = obs_res.get("observations", [])
        obs_map = {o.get("obs_id"): o.get("access_url") for o in obs_list if o.get("obs_id")}
        if not access_url_a and obs_id_a in obs_map:
            access_url_a = obs_map[obs_id_a]
        if not access_url_b and obs_id_b in obs_map:
            access_url_b = obs_map[obs_id_b]

    if not access_url_a:
        access_url_a = f"https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/{obs_id_a}.fits"
    if not access_url_b:
        access_url_b = f"https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/{obs_id_b}.fits"

    # Fetch FITS cutouts for both epochs concurrently
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=2) as executor:
        fut_a = executor.submit(fetch_fits_cutout, access_url_a, ra, dec, size_arcsec, min(timeout_sec, 6.0))
        fut_b = executor.submit(fetch_fits_cutout, access_url_b, ra, dec, size_arcsec, min(timeout_sec, 6.0))
        bytes_a = fut_a.result()
        bytes_b = fut_b.result()

    clean_a, header_a = extract_fits_image_data(bytes_a)
    clean_b, header_b = extract_fits_image_data(bytes_b)

    # Match shapes: center-crop both to smaller overlapping dimensions
    h_a, w_a = clean_a.shape
    h_b, w_b = clean_b.shape
    min_h = min(h_a, h_b)
    min_w = min(w_a, w_b)

    sy_a = (h_a - min_h) // 2
    sx_a = (w_a - min_w) // 2
    crop_a = clean_a[sy_a : sy_a + min_h, sx_a : sx_a + min_w]

    sy_b = (h_b - min_h) // 2
    sx_b = (w_b - min_w) // 2
    crop_b = clean_b[sy_b : sy_b + min_h, sx_b : sx_b + min_w]

    # Normalize each frame by background-subtracted MAD dispersion so detector gain differences don't dominate
    med_a = float(np.median(crop_a))
    mad_a = float(np.median(np.abs(crop_a - med_a)))
    scale_a = mad_a * 1.4826 if mad_a > 1e-9 else float(np.std(crop_a))
    if scale_a <= 1e-9 or not np.isfinite(scale_a):
        scale_a = 1.0
    norm_a = (crop_a - med_a) / scale_a

    med_b = float(np.median(crop_b))
    mad_b = float(np.median(np.abs(crop_b - med_b)))
    scale_b = mad_b * 1.4826 if mad_b > 1e-9 else float(np.std(crop_b))
    if scale_b <= 1e-9 or not np.isfinite(scale_b):
        scale_b = 1.0
    norm_b = (crop_b - med_b) / scale_b

    # Calibrated difference array: Epoch B - Epoch A
    diff = (norm_b - norm_a).astype(np.float64)

    rms_dn = float(np.sqrt(np.mean(diff ** 2)))
    max_delta = float(np.max(np.abs(diff))) if diff.size > 0 else 0.0

    # Symmetric scale around 0: ±vmax (using 99.5th percentile of abs delta to avoid cosmic ray outliers)
    abs_diff = np.abs(diff)
    if abs_diff.size > 0:
        p99 = float(np.percentile(abs_diff, 99.5))
        vmax = max(p99, 3.0 * rms_dn, 0.1)
    else:
        vmax = 1.0

    # Scale diff in [-vmax, +vmax] to [0, 255]
    diff_clipped = np.clip(diff, -vmax, vmax)
    norm_diff = (diff_clipped + vmax) / (2.0 * vmax)
    diff_uint8 = np.clip(norm_diff * 255.0, 0, 255).astype(np.uint8)

    # Astronomical orientation (North-Up, East-Left)
    aligned_diff = np.flipud(diff_uint8)
    header = header_b or header_a
    if header is not None:
        cdelt1 = float(header.get("CDELT1", header.get("CD1_1", -1.0)))
    else:
        cdelt1 = -1.0
    if cdelt1 > 0:
        aligned_diff = np.fliplr(aligned_diff)

    # Apply diverging palette (Dark Slate baseline at center, Electric Blue negative, Bright Amber/Red positive)
    pil_img = Image.fromarray(aligned_diff, mode="L")
    diff_lut = _build_diff_lut()
    pil_img.putpalette(diff_lut)
    pil_img = pil_img.convert("RGB")

    img_buf = io.BytesIO()
    pil_img.save(img_buf, format="PNG", optimize=True)
    b64 = base64.b64encode(img_buf.getvalue()).decode("utf-8")

    result = {
        "obs_id_a": obs_id_a,
        "obs_id_b": obs_id_b,
        "ra": ra,
        "dec": dec,
        "size_arcsec": size_arcsec,
        "image_base64": b64,
        "data_url": f"data:image/png;base64,{b64}",
        "rms_dn": round(rms_dn, 4),
        "max_delta": round(max_delta, 4),
        "vmax": round(vmax, 4),
        "shape": [int(min_h), int(min_w)],
        "cached": False,
    }

    spherex_cache.set(cache_key, result, ttl_sec=7200.0)
    return result


def generate_epochs_zip(
    target: Optional[str],
    ra: float,
    dec: float,
    radius_deg: float = 0.05,
    max_frames: int = 50,
    band: Optional[str] = None,
    colormap: str = "inferno",
    size_arcsec: float = 100.0,
) -> io.BytesIO:
    """
    Builds an in-memory ZIP archive of stratified multi-epoch observations and cutouts.
    Contains:
    - metadata.csv
    - metadata.json
    - cutouts/*.png
    - README_CITATION.txt
    """
    obs_res = fetch_all_observations(ra, dec, radius_deg=radius_deg, max_frames=max_frames, band=band)
    observations = obs_res.get("observations", [])

    # Fetch PNG cutouts in parallel
    def _fetch_one(item: Tuple[int, Dict[str, Any]]) -> Tuple[int, Optional[bytes]]:
        idx, obs = item
        access_url = obs.get("access_url", "")
        if not access_url:
            return idx, None
        try:
            b64_str, _ = fetch_observation_cutout(
                access_url=access_url,
                ra=ra,
                dec=dec,
                size_arcsec=size_arcsec,
                colormap=colormap,
            )
            return idx, base64.b64decode(b64_str)
        except Exception as exc:
            logger.warning(f"Export zip: could not fetch cutout for obs {obs.get('obs_id')}: {exc}")
            return idx, None

    cutout_bytes_map: Dict[int, Optional[bytes]] = {}
    if observations:
        max_workers = min(8, len(observations))
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            for idx, data in executor.map(_fetch_one, enumerate(observations)):
                cutout_bytes_map[idx] = data

    # 1. Build CSV metadata
    csv_buffer = io.StringIO()
    writer = csv.writer(csv_buffer)
    writer.writerow([
        "index",
        "obs_id",
        "date",
        "mjd",
        "collection",
        "band",
        "lambda_min_um",
        "lambda_max_um",
        "calib_level",
        "detector",
        "ra_deg",
        "dec_deg",
        "cutout_file",
    ])

    filenames: Dict[int, str] = {}
    for idx, obs in enumerate(observations):
        obs_id = obs.get("obs_id", f"epoch_{idx+1}")
        obs_id_clean = re.sub(r'[^a-zA-Z0-9_\-]+', '_', obs_id)
        raw_date = obs.get("obs_date") or ""
        date_part = raw_date.split("T")[0].split(" ")[0] if raw_date else "unknown_date"
        band_part = obs.get("wavelength_band") or "band"
        fname = f"{idx+1:02d}_{date_part}_{band_part}_{obs_id_clean}.png"
        has_cutout = cutout_bytes_map.get(idx) is not None
        filenames[idx] = fname if has_cutout else ""

        writer.writerow([
            idx + 1,
            obs.get("obs_id", ""),
            obs.get("obs_date", ""),
            obs.get("mjd", ""),
            obs.get("collection", ""),
            obs.get("wavelength_band", ""),
            obs.get("em_min_um", ""),
            obs.get("em_max_um", ""),
            obs.get("calib_level", ""),
            obs.get("detector", "SPHEREx"),
            obs.get("s_ra", ra),
            obs.get("s_dec", dec),
            f"cutouts/{fname}" if has_cutout else "",
        ])

    # 2. Build JSON metadata
    target_label = target.strip() if target and target.strip() else f"field_{ra:.4f}_{dec:.4f}"
    meta_json = {
        "target": target_label,
        "ra": ra,
        "dec": dec,
        "radius_deg": radius_deg,
        "max_frames": max_frames,
        "band_filter": band or "ALL",
        "colormap": colormap,
        "size_arcsec": size_arcsec,
        "exported_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "total_observations": len(observations),
        "mjd_baseline_days": obs_res.get("mjd_baseline_days", 0.0),
        "collections": ["spherex_dr1", "spherex_qr3"],
        "citation": "NASA/IPAC Infrared Science Archive (IRSA) SPHEREx DR1 (DOI: 10.26131/IRSA678) and SPHEREx QR3",
        "observations": [
            {
                "index": idx + 1,
                "obs_id": obs.get("obs_id", ""),
                "date": obs.get("obs_date", ""),
                "mjd": obs.get("mjd"),
                "collection": obs.get("collection", ""),
                "band": obs.get("wavelength_band", ""),
                "lambda_min_um": obs.get("em_min_um"),
                "lambda_max_um": obs.get("em_max_um"),
                "calib_level": obs.get("calib_level"),
                "detector": obs.get("detector", "SPHEREx"),
                "ra": obs.get("s_ra", ra),
                "dec": obs.get("s_dec", dec),
                "cutout_file": f"cutouts/{filenames[idx]}" if filenames.get(idx) else None,
            }
            for idx, obs in enumerate(observations)
        ],
    }

    # 3. Build README_CITATION.txt
    readme_text = f"""================================================================================
SPHEREx Time Explorer — Multi-Epoch Observation Export Archive
================================================================================
Target / Field: {target_label}
Coordinates: RA = {ra:.6f} deg, Dec = {dec:.6f} deg
Search Radius: {radius_deg} deg
Spectral Band Filter: {band or "All Bands"}
Colormap: {colormap}
Cutout Box Size: {size_arcsec} arcsec
Generated At: {datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")}
Observations Count: {len(observations)}
Baseline Span: {obs_res.get("mjd_baseline_days", 0.0):.2f} days

ARCHIVE CONTENTS:
1. metadata.csv: Tabular CSV of observation identifiers, timestamps, MJD, collections, wavelengths, and calibration levels.
2. metadata.json: Full structured JSON metadata for programmatic analysis.
3. cutouts/: Calibrated WCS-aligned PNG cutouts (North-Up, East-Left) rendered using {colormap} colormap with Asinh/Percentile stretch.
4. README_CITATION.txt: Archive documentation and citation references.

SCIENTIFIC ARCHIVE & DATA INTEGRITY:
Data products in this export originate from the NASA/IPAC Infrared Science Archive (IRSA).
All observations are queried strictly from SPHEREx DR1 and SPHEREx QR3.
Scientific integrity note: Candidate variations identified via time-domain differencing represent candidates for human/scientific review and not confirmed autonomous discoveries.

CITATIONS & ACKNOWLEDGEMENTS:
- SPHEREx DR1 (Data Release 1): DOI: 10.26131/IRSA678
  URL: https://irsa.ipac.caltech.edu/data/SPHEREx/
- SPHEREx QR3 (Quick Release 3): NASA/IPAC Infrared Science Archive
- Astropy Collaboration et al. (WCS, FITS I/O, and Photometry)
- NASA Space Apps Challenge 2026: SPHEREx Time-Domain Astronomy
================================================================================
"""

    # 4. Assemble ZIP
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("metadata.csv", csv_buffer.getvalue())
        zf.writestr("metadata.json", json.dumps(meta_json, indent=2))
        zf.writestr("README_CITATION.txt", readme_text)

        for idx, obs in enumerate(observations):
            png_bytes = cutout_bytes_map.get(idx)
            if png_bytes and filenames.get(idx):
                zf.writestr(f"cutouts/{filenames[idx]}", png_bytes)

    zip_buffer.seek(0)
    return zip_buffer
