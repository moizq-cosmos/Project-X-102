"""
NASA Space Apps 2026 Review - Automated Verification Suite
Verifies all 5 challenge targets against:
1. Multi-epoch stratified sampling (MJD baseline > 100 days across revisit visits)
2. FITS cutout extraction (HDU 1 2D image, NaN handling, AsinhStretch, std > 0)
3. Spectral band filtering (SPHEREx-D1 through D6)
4. Generates SPHEREx_Time_Explorer_Submission.zip
"""

import io
import sys
import zipfile
from pathlib import Path
import numpy as np

from services import (
    fits_to_base64_png,
    fetch_all_observations,
    CHALLENGE_TARGET_DATA,
    _find_local_target_files,
)

def run_verification():
    print("=" * 70)
    print("SPHEREx Time Explorer — Challenge Target Verification")
    print("=" * 70)

    all_passed = True
    results = {}

    for name, ra, dec in CHALLENGE_TARGET_DATA:
        print(f"\nVerifying target: {name} (RA: {ra}, Dec: {dec})")

        # 1. Observations query
        obs_res = fetch_all_observations(ra, dec, radius_deg=0.05, max_frames=50)
        total = obs_res.get("total_found", 0)
        returned = obs_res.get("returned", 0)
        baseline = obs_res.get("mjd_baseline_days", 0.0)

        print(f"  Observations: total_found={total}, returned={returned}, baseline_span={baseline:.2f} days")

        if total == 0:
            print(f"  ❌ FAILED: 0 observations found for {name}")
            all_passed = False
        if baseline < 100.0:
            print(f"  ❌ FAILED: Multi-epoch baseline ({baseline:.2f}d) < 100 days for {name}")
            all_passed = False
        else:
            print(f"  ✅ PASSED: Multi-epoch baseline span = {baseline:.2f} days (>100d)")

        # 2. Spectral band filtering check (SPHEREx-D3)
        d3_res = fetch_all_observations(ra, dec, radius_deg=0.05, max_frames=50, band="SPHEREx-D3")
        d3_obs = d3_res.get("observations", [])
        all_d3 = all(o.get("wavelength_band") == "SPHEREx-D3" for o in d3_obs)
        if d3_obs and all_d3:
            print(f"  ✅ PASSED: Band filter 'SPHEREx-D3' locked {len(d3_obs)} matching frames")
        else:
            print(f"  ❌ FAILED: Band filter 'SPHEREx-D3' contains mismatched bands")
            all_passed = False

        # 3. FITS cutout extraction & AsinhStretch
        _, local_fits = _find_local_target_files(ra, dec)
        if not local_fits or not local_fits.exists():
            print(f"  ❌ FAILED: Cutout FITS file missing for {name}")
            all_passed = False
            continue

        fits_bytes = local_fits.read_bytes()
        b64_str, stats = fits_to_base64_png(fits_bytes, colormap="inferno")
        std = stats.get("raw_std", 0.0)
        mean = stats.get("raw_mean", 0.0)
        wcs_ok = bool(stats.get("wcs"))

        print(f"  Cutout stats: raw_std={std:.2f}, raw_mean={mean:.2f}, b64_len={len(b64_str)}, WCS={wcs_ok}")

        if std <= 0.0:
            print(f"  ❌ FAILED: Cutout pixel variance std <= 0 for {name} (pitch black)")
            all_passed = False
        else:
            print(f"  ✅ PASSED: Non-zero pixel variance (std = {std:.2f}, non-black cutout)")

        results[name] = {
            "total_obs": total,
            "baseline_days": baseline,
            "band_lock_frames": len(d3_obs),
            "cutout_std": std,
            "cutout_mean": mean,
        }

    # 4. Verify Export ZIP functionality
    print("\nVerifying /export-zip multi-epoch archive export...")
    try:
        from main import export_zip
        zip_resp = export_zip(
            target="WISE 0855",
            ra=133.7951,
            dec=-7.2451,
            radius=0.05,
            max_frames=5,
            band="SPHEREx-D3",
        )
        assert zip_resp.media_type == "application/zip", f"Expected application/zip, got {zip_resp.media_type}"
        disp = zip_resp.headers.get("content-disposition", "")
        assert 'filename="SPHEREx_WISE_0855_epochs.zip"' in disp, f"Invalid Content-Disposition: {disp}"
        test_zf = zipfile.ZipFile(io.BytesIO(zip_resp.body))
        zf_names = test_zf.namelist()
        assert "metadata.csv" in zf_names, "Missing metadata.csv in ZIP"
        assert "metadata.json" in zf_names, "Missing metadata.json in ZIP"
        assert "README_CITATION.txt" in zf_names, "Missing README_CITATION.txt in ZIP"
        cutout_pngs = [n for n in zf_names if n.startswith("cutouts/") and n.endswith(".png")]
        assert len(cutout_pngs) > 0, "Missing cutout PNGs in cutouts/"
        print(f"  ✅ PASSED: /export-zip built valid archive with {len(zf_names)} files ({len(cutout_pngs)} PNG cutouts, {len(zip_resp.body):,} bytes)")
    except Exception as e:
        print(f"  ❌ FAILED: /export-zip verification error: {e}")
        all_passed = False

    print("\n" + "=" * 70)
    if all_passed:
        print("ALL 5 CHALLENGE TARGETS & EXPORT FEATURES PASSED CHECKS!")
    else:
        print("SOME CHECKS FAILED.")
    print("=" * 70)

    # 5. Generate SPHEREx_Time_Explorer_Submission.zip
    zip_filename = "SPHEREx_Time_Explorer_Submission.zip"
    files_to_zip = [
        "index.html",
        "styles.css",
        "app.js",
        "main.py",
        "services.py",
        "verify_all_targets.py",
        "requirements.txt",
        "render.yaml",
        ".gitignore",
        "README.md",
        "run.ps1",
        "run.sh",
        "static/index.html",
        "static/styles.css",
        "static/app.js",
        "docs/SPHEREx_Time_Explorer_Final_Verification_Report.docx",
        "docs/01_timeline_cutout_viewer.png",
        "docs/02_before_after_comparison.png",
        "docs/03_diff_view_residuals.png",
        "wise0855_dr1_irsa.xml",
        "wise0855_sample_cutout.fits",
        "barnards_star_dr1_irsa.xml",
        "barnards_star_sample_cutout.fits",
        "epsilon_indi_b_dr1_irsa.xml",
        "epsilon_indi_b_sample_cutout.fits",
        "rw_aurigae_dr1_irsa.xml",
        "rw_aurigae_sample_cutout.fits",
        "r_draconis_dr1_irsa.xml",
        "r_draconis_sample_cutout.fits",
    ]

    base_dir = Path(__file__).resolve().parent
    with zipfile.ZipFile(base_dir / zip_filename, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for fname in files_to_zip:
            fpath = base_dir / fname
            if fpath.exists():
                zf.write(fpath, arcname=fname)
                print(f"  Added to submission zip: {fname} ({fpath.stat().st_size:,} bytes)")
            else:
                print(f"  Warning: file {fname} not found")

    zip_size = (base_dir / zip_filename).stat().st_size
    print(f"\nSuccessfully generated {zip_filename} ({zip_size:,} bytes).")
    return all_passed

if __name__ == "__main__":
    success = run_verification()
    sys.exit(0 if success else 1)
