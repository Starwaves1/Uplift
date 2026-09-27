"""Fetch the photoscanned ground materials (Poly Haven, CC0) that the terrain's material arrays are built from.

Downloads the 4K JPG maps of every set in SETS into assets/src/polyhaven/<set>/ (git-ignored: ~750 MB, re-fetchable),
checks each file against the md5 Poly Haven publishes, skips files already present and intact, and writes
assets/src/polyhaven/manifest.json (set → map → url, md5, bytes).

usage: py assets/fetch_polyhaven.py [res]        (res: 1k | 2k | 4k, default 4k)
"""
import hashlib, json, os, sys, urllib.request

RES = sys.argv[1] if len(sys.argv) > 1 else '4k'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src', 'polyhaven')
MAPS = ['Diffuse', 'nor_gl', 'Rough', 'AO', 'Displacement']
# what each set is for on the island
SETS = {
    'aerial_rocks_02': 'rock seen from above: Nordic granite slabs',
    'aerial_rocks_04': 'rock seen from above: broken grey rock',
    'rocky_terrain_02': 'rough rocky ground: alpine slopes',
    'rock_face_03': 'rock face: cliffs and steep walls (triplanar)',
    'rock_06': 'pale layered rock: plateau limestone/sandstone walls',
    'sandstone_cracks': 'cracked pale rock: plateau tops, karst pavement',
    'rocks_ground_02': 'scree and loose rock',
    'gravelly_sand': 'gravel: river beds, fans, scree fringes',
    'aerial_grass_rock': 'grass broken by rock: Nordic fell, alpine meadow edges',
    'leafy_grass': 'meadow grass: valley floors',
    'aerial_ground_rock': 'thin soil over rock from above: high ground',
    'forest_leaves_02': 'forest floor',
    'brown_mud_dry': 'dry soil: Mediterranean hillsides, fields',
    'red_laterite_soil_stones': 'red stony soil: Mediterranean south',
    'aerial_beach_01': 'beach sand from above',
    'coast_sand_rocks_02': 'sand with rocks: rocky shores',
    'snow_field_aerial': 'snowfield from above: high summits',
    'snow_02': 'snow close-up',
}


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'windborne-assets/1.0'})) as r:
        return json.load(r)


def md5(path):
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    os.makedirs(ROOT, exist_ok=True)
    manifest, total = {}, 0
    for sid in SETS:
        files = get_json(f'https://api.polyhaven.com/files/{sid}')
        os.makedirs(os.path.join(ROOT, sid), exist_ok=True)
        manifest[sid] = {'use': SETS[sid], 'license': 'CC0', 'page': f'https://polyhaven.com/a/{sid}', 'maps': {}}
        for m in MAPS:
            info = files.get(m, {}).get(RES, {}).get('jpg')
            if not info:
                print(f'  {sid}: no {m} at {RES}', flush=True)
                continue
            dst = os.path.join(ROOT, sid, os.path.basename(info['url']))
            if not (os.path.exists(dst) and os.path.getsize(dst) == info['size'] and md5(dst) == info['md5']):
                urllib.request.urlretrieve(info['url'], dst)
                if md5(dst) != info['md5']:
                    raise SystemExit(f'md5 mismatch: {dst}')
            manifest[sid]['maps'][m] = {'file': os.path.basename(dst), 'url': info['url'], 'md5': info['md5'], 'bytes': info['size']}
            total += info['size']
        print(f'{sid:28s} {len(manifest[sid]["maps"])} maps   total {total / 1e6:7.1f} MB', flush=True)
    json.dump(manifest, open(os.path.join(ROOT, 'manifest.json'), 'w'), indent=1)
    print('done', round(total / 1e6, 1), 'MB')


if __name__ == '__main__':
    main()
