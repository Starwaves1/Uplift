"""Where the generator keeps its intermediate grids: island/work/ inside the project (git-ignored, reproducible), or
$ISLAND_WORK if set (e.g. a Linux-side folder for faster I/O)."""
import os

WORK = os.environ.get('ISLAND_WORK', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'work'))
os.makedirs(WORK, exist_ok=True)
