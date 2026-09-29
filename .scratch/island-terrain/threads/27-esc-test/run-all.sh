H=../agent-a894e21c8ed7cdb12/tools/headless.py; T=/c/Users/garre/AppData/Local/Temp/esc27
for b in ${BUILDS:-old fixed}; do for m in fp chase spec; do
  G=--glider; [ $m = spec ] && G=
  echo "=== $b build, $m ==="
  py $H run --url "http://127.0.0.1:8775/windborne-test-esc-$b.html" $G --no-materials --js "window.__ESC_MODE='$m'" --js "$(cat $T/esc-test.js)" --size 1280x720 --settle 1 2>&1 | py -c "import sys,json
for l in sys.stdin:
  l=l.strip()
  if l.startswith('\"') and len(l)>10: print(json.loads(l))
  elif l.startswith('done') or 'rror' in l: print(l)"
done; done
