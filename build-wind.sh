#!/bin/sh
# usage: sh build-wind.sh            → windborne.html + windborne-test.html with every models/*.js (except _*.js)
#        sh build-wind.sh flora,fauna → windborne-test-flora,fauna.html with only those model modules (for isolated testing)
set -e
SRC=${SRC:-wind}
cd "$(dirname "$0")/$SRC"
TAG=""; [ "$SRC" != wind ] && TAG="-${SRC#wind-}"
if [ -n "$1" ]; then
  MODS=""; for m in $(echo "$1" | tr ',' ' '); do MODS="$MODS models/$m.js"; done
  OUT="../windborne$TAG-test-$1.html"; PUB=""
else
  MODS=$(ls models/*.js 2>/dev/null | grep -v '/_' | sort || true)
  OUT="../windborne$TAG-test.html"; PUB="../windborne$TAG.html"
fi
OLDGLIDER=glider.js
case " $MODS " in *models/glider.js*) OLDGLIDER="";; esac
BODY=$(mktemp)
{
  sed -n '1,/<!--SCRIPTS-->/p' shell.html | sed '$d'
  echo '<div id="bootmsg" style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);font:500 15px system-ui,sans-serif;color:#dfe8ef;letter-spacing:.04em;z-index:99">Loading the island…</div>'
  echo '<script type="text/plain" id="wb-game">'
  EXTRA=""; [ -f post.js ] && grep -q "POST" main.js && EXTRA="post.js"; [ -f atmosphere.js ] && grep -q "ATMOS\." main.js && EXTRA="$EXTRA atmosphere.js"; [ -f shadow.js ] && grep -q "SHADOW\." main.js && EXTRA="$EXTRA shadow.js"; [ -f clouds.js ] && grep -q "CLOUDS\." main.js && EXTRA="$EXTRA clouds.js"; [ -f shafts.js ] && grep -q "SHAFTS\." main.js && EXTRA="$EXTRA shafts.js"; [ -f water.js ] && grep -q "WATER\." main.js && EXTRA="$EXTRA water.js"
  cat core.js mesh.js $EXTRA terrain.js world.js scenery.js $OLDGLIDER $MODS flight.js audio.js music.js main.js
  echo '</script>'
  echo '<script>'; cat boot.js; echo '</script>'
} > "$BODY"
[ -n "$PUB" ] && cp "$BODY" "$PUB"
{
  printf '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><script>window.WB_MUTE=true</script></head><body>\n'
  cat "$BODY"
  printf '\n</body></html>\n'
} > "$OUT"
rm -f "$BODY"
echo "built $OUT ($(wc -c < "$OUT") bytes) with models:$MODS ${OLDGLIDER:+(+legacy glider.js)}"
