#!/usr/bin/env bash
set -e

echo "=========================================================="
echo " Starting Astro-API Gateway (NASA / IPAC Bridge)         "
echo "=========================================================="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "[1/2] Installing requirements from requirements.txt..."
pip install -r requirements.txt

echo "[2/2] Launching Uvicorn ASGI server on port 8000..."
uvicorn main:app --reload --port 8000 --host 0.0.0.0
