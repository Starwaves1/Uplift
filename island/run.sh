#!/bin/bash
# run an island script in the WSL ROCm venv: ./run.sh script.py args...   (first time: ./setup-wsl.sh)
cd "$(dirname "$0")"
export PYTHONUNBUFFERED=1 NUMBA_CACHE_DIR=${NUMBA_CACHE_DIR:-/root/island/numba-cache}
exec "${ISLAND_VENV:-/root/island/.venv}/bin/python" "$@"
