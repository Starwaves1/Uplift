#!/bin/bash
# One-time setup of the island generator's env inside WSL (or any Linux box). Needs uv, and ROCm (6.4) for an AMD GPU.
# The env lives outside the project (it's ~13 GB and Linux-only); run.sh finds it at $ISLAND_VENV.
set -e
VENV=${ISLAND_VENV:-/root/island/.venv}
uv venv --python 3.11 "$VENV"
uv pip install --python "$VENV" -r "$(dirname "$0")/requirements.txt"
mkdir -p "${NUMBA_CACHE_DIR:-/root/island/numba-cache}"
"$VENV/bin/python" -c "import torch; print('torch', torch.__version__, 'gpu', torch.cuda.is_available())"
