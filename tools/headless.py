"""Headless review tool: in-game screenshots, JavaScript and frame timings from a muted test build, with no window.

It runs the installed Chrome (or Edge) in headless mode with GPU WebGL (ANGLE on D3D11), drives it over the DevTools
protocol with a small standard-library WebSocket client, and always kills the browser at the end. Nothing appears on
screen, nothing takes focus or the cursor, audio is muted, and the page is refused pointer lock before its scripts run.

The page's frames are driven by tools/review-harness.js (injected before the game's scripts; the whole R.* API works
in --js steps), so every frame is a fixed 1/60 s step and shots are deterministic, full-resolution canvas read-backs.

  py tools/headless.py info                                   browser, GPU and the game's WebGL renderer string
  py tools/headless.py shot  --at 29,43.5,215,450 --name south  one spectator view -> shots/south.png
  py tools/headless.py shot  --spots views.txt                a batch of spots (lines: `name X,Y,HDG,ALT` or `name X Y HDG ALT`)
  py tools/headless.py pair  --at ... --b-url URL|--b-island NAME|--b-js JS   before/after -> _a/_b PNGs + sbs_<name>.jpg
  py tools/headless.py run   --at ... --js "WB.step(60, 1/60)" --expr "Array.from(FLIGHT.g.pos)"
  py tools/headless.py bench --at ... --frames 300           per-pass GPU ms (WB.PROF) and synced wall ms per frame

Common options: --url PAGE (default: the muted test build on 127.0.0.1:8765), --island NAME, --glider (fly the glider
from the spot instead of the ?fly spectator camera), --settings '{"tod":"dusk","quality":"high"}' (written to the
game's saved settings before it starts), --size 1920x1080, --settle 150 (frames before each shot; bench 0),
--out DIR (default shots/), --browser chrome|edge|PATH, --port N (DevTools port; default: a free one picked by the
browser), --console.
Run `py tools/headless.py <command> -h` for everything.
"""
import argparse, base64, ctypes, json, os, re, shutil, socket, struct, subprocess, sys, tempfile, threading, time

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)
DEFAULT_URL = 'http://127.0.0.1:8765/windborne-test.html'
BROWSERS = {
    'chrome': [r'C:\Program Files\Google\Chrome\Application\chrome.exe',
               r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
               os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe')],
    'edge': [r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
             r'C:\Program Files\Microsoft\Edge\Application\msedge.exe'],
}
GPU_CACHE_DIR = os.path.join(tempfile.gettempdir(), 'wb-headless-gpu-cache')
GPU_CACHES = ['GrShaderCache', 'ShaderCache', os.path.join('Default', 'GPUCache'),
              os.path.join('Default', 'DawnGraphiteCache'), os.path.join('Default', 'DawnWebGPUCache')]
SOFTWARE_GL = re.compile(r'swiftshader|llvmpipe|basic render|software|warp', re.I)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ── a minimal WebSocket client (RFC 6455, client side, text frames) ──
class WebSocket:
    def __init__(self, url, timeout=600):
        m = re.match(r'ws://([^/:]+):(\d+)(/.*)', url)
        host, port, path = m.group(1), int(m.group(2)), m.group(3)
        self.s = socket.create_connection((host, port), timeout=timeout)
        self.s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f'GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                        f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            d = self.s.recv(4096)
            if not d:
                raise ConnectionError('websocket handshake: connection closed')
            buf += d
        head, rest = buf.split(b'\r\n\r\n', 1)
        if b' 101 ' not in head.split(b'\r\n')[0]:
            raise ConnectionError('websocket handshake refused: ' + head.decode(errors='replace')[:300])
        self.buf = bytearray(rest)

    def _frame(self):
        """One complete frame off the buffer as (b0, payload), or None — a timeout never leaves half a frame consumed."""
        b = self.buf
        if len(b) < 2:
            return None
        n, i = b[1] & 127, 2
        if n == 126:
            if len(b) < 4:
                return None
            n, i = struct.unpack('>H', b[2:4])[0], 4
        elif n == 127:
            if len(b) < 10:
                return None
            n, i = struct.unpack('>Q', b[2:10])[0], 10
        mk = None
        if b[1] & 128:  # servers don't mask, but be tolerant
            if len(b) < i + 4:
                return None
            mk, i = bytes(b[i:i + 4]), i + 4
        if len(b) < i + n:
            return None
        b0, d = b[0], bytes(b[i:i + n])
        del b[:i + n]
        if mk:
            d = bytes(c ^ mk[j & 3] for j, c in enumerate(d))
        return b0, d

    def send(self, data, op=1):
        if isinstance(data, str):
            data = data.encode()
        n = len(data)
        hdr = bytes([0x80 | op]) + (bytes([0x80 | n]) if n < 126 else
                                    bytes([0x80 | 126]) + struct.pack('>H', n) if n < 65536 else
                                    bytes([0x80 | 127]) + struct.pack('>Q', n))
        mask = os.urandom(4)
        k = int.from_bytes((mask * (n // 4 + 1))[:n], 'big') if n else 0
        body = (int.from_bytes(data, 'big') ^ k).to_bytes(n, 'big') if n else b''
        self.s.sendall(hdr + mask + body)

    def recv(self, timeout=None):
        """The next text message; raises socket.timeout after `timeout` seconds (None: wait as long as it takes)."""
        self.s.settimeout(timeout)
        msg = bytearray()
        while True:
            f = self._frame()
            if f is None:
                d = self.s.recv(1 << 20)
                if not d:
                    raise ConnectionError('websocket closed')
                self.buf += d
                continue
            b0, d = f
            op = b0 & 15
            if op == 9:
                self.send(d, 10)
            elif op == 8:
                raise ConnectionError('websocket closed by the browser')
            elif op in (0, 1, 2):
                msg += d
                if b0 & 128:
                    return msg.decode('utf-8', errors='replace')

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


# ── Windows: a kill-on-close job object, so the browser dies with this process however it ends ──
def _job_for(proc):
    if os.name != 'nt':
        return None
    try:
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.CreateJobObjectW.restype = ctypes.c_void_p
        job = k32.CreateJobObjectW(None, None)
        if not job:
            return None

        class IO(ctypes.Structure):
            _fields_ = [(n, ctypes.c_ulonglong) for n in ('r', 'w', 'o', 'rb', 'wb', 'ob')]

        class BASIC(ctypes.Structure):
            _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong), ('PerJobUserTimeLimit', ctypes.c_longlong),
                        ('LimitFlags', ctypes.c_uint32), ('MinimumWorkingSetSize', ctypes.c_size_t),
                        ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', ctypes.c_uint32),
                        ('Affinity', ctypes.c_size_t), ('PriorityClass', ctypes.c_uint32),
                        ('SchedulingClass', ctypes.c_uint32)]

        class EXT(ctypes.Structure):
            _fields_ = [('Basic', BASIC), ('Io', IO), ('ProcessMemoryLimit', ctypes.c_size_t),
                        ('JobMemoryLimit', ctypes.c_size_t), ('PeakProcessMemoryUsed', ctypes.c_size_t),
                        ('PeakJobMemoryUsed', ctypes.c_size_t)]

        info = EXT()
        info.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(ctypes.c_void_p(job), 9, ctypes.byref(info), ctypes.sizeof(info)):
            return None
        if not k32.AssignProcessToJobObject(ctypes.c_void_p(job), ctypes.c_void_p(int(proc._handle))):
            return None
        return job
    except Exception:
        return None


# ── the page side: harness + a small bridge, injected before any of the game's scripts ──
BRIDGE = r"""
(() => {
  // never take the user's mouse or screen, whatever the game asks for
  const no = what => function () { return Promise.reject(new DOMException('headless review: no ' + what, 'NotAllowedError')); };
  Element.prototype.requestPointerLock = no('pointer lock');
  Element.prototype.requestFullscreen = no('fullscreen');
  if (navigator.keyboard) navigator.keyboard.lock = no('keyboard lock');
  window.WB_MUTE = true; // test builds set it too; this keeps any page silent (and Chrome runs with --mute-audio)
  const HB = window.HB = { out: [], errors: [] };
  addEventListener('error', e => HB.errors.push(String(e.message || e)));
  addEventListener('unhandledrejection', e => HB.errors.push('unhandled rejection: ' + String(e.reason && (e.reason.stack || e.reason))));
  // the game says so when the photo materials can't load: stop waiting for them
  const warn = console.warn; console.warn = function (...a) { if (/materials unavailable/.test(String(a[0]))) HB.noMaterials = true; return warn.apply(this, a); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  HB.dtMs = 1000 / 60;
  // JSON with typed arrays as plain arrays (FLIGHT.g.pos is a Float32Array)
  HB.json = v => v === undefined ? 'null' : JSON.stringify(v, (k, x) => ArrayBuffer.isView(x) ? Array.from(x) : x);
  // render one frame and read the canvas back in the same task (the drawing buffer is gone after the next composite)
  HB.grab = (dt = 0.2) => new Promise((res, rej) => {
    R.frame(dt);
    GLX.canvas.toBlob(b => {
      if (!b) return rej(new Error('no frame'));
      const f = new FileReader(); f.onload = () => res(f.result); f.onerror = () => rej(f.error); f.readAsDataURL(b);
    }, 'image/png');
  });
  // the harness's R.shot / R.pair save through this tool instead of tools/shot_server.py
  R.shot = name => HB.grab().then(d => { HB.out.push([String(name), d]); return String(name); });
  HB.renderer = () => {
    const gl = (typeof GLX !== 'undefined' && GLX && GLX.gl) || document.createElement('canvas').getContext('webgl2');
    if (!gl) return { renderer: 'no WebGL2' };
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: String(d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
             vendor: String(d ? gl.getParameter(d.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
             timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2') };
  };
  // a build from before ?fly / ?at / ?island ignores them and shows the title flyby: fail instead of saving that
  HB.checkUrl = async () => {
    const q = new URLSearchParams(location.search), isl = q.get('island'), at = q.get('at'), fly = q.has('fly'), bad = [];
    if (isl && !performance.getEntriesByType('resource').some(e => e.name.includes(`islands/${isl}/island.bin`) && e.responseStatus === 200))
      bad.push(`?island=${isl} (islands/${isl}/island.bin not loaded)`);
    const island = typeof ISLAND !== 'undefined' && ISLAND;
    if (at && !island) bad.push(`?at=${at} (no island loaded)`);
    else if (at) { // the spectator camera (?fly) or the glider starts at the spot
      const [x, y] = at.split(',').map(Number), p = fly ? FLIGHT.cam.pos : FLIGHT.g.pos;
      if (Math.hypot(p[0] - x * 1000 - island.origin, p[2] - y * 1000 - island.origin) > 300) bad.push(`?at=${at}`);
    }
    if (fly) { // the spectator camera holds still with no keys down; the title flyby's camera moves
      const p0 = Array.from(FLIGHT.cam.pos);
      await R.pump(2, HB.dtMs);
      const c = FLIGHT.cam.pos;
      if (Math.hypot(c[0] - p0[0], c[1] - p0[1], c[2] - p0[2]) > 0.01) bad.push('?fly');
    }
    if (bad.length) throw new Error(`this page ignored ${bad.join(', ')}: is it an old build? Rebuild it (sh build-wind.sh ...) or pick another with --url`);
  };
  // wait for the game (and its photo ground materials), pump the loading frames; play: take flight in the glider
  HB.ready = async ({ play = false, materials = true, timeout = 60000 } = {}) => {
    const t0 = performance.now();
    while (!(window.WB && typeof TERRAIN !== 'undefined') && performance.now() - t0 < timeout) {
      if (HB.errors.length) break;
      await sleep(50);
    }
    if (!window.WB) throw new Error('the game did not start' + (HB.errors.length ? ': ' + HB.errors.join(' | ') : ' (timeout)'));
    const tStart = performance.now();
    await R.pump(20, HB.dtMs);
    await HB.checkUrl();
    const tFirst = performance.now();
    // (builds from before the photo materials have no TERRAIN.materials: nothing to wait for)
    while (materials && 'materials' in TERRAIN && !TERRAIN.materials && !HB.noMaterials && performance.now() - t0 < timeout) { await R.pump(3, HB.dtMs); await sleep(30); }
    HB.phases = { startMs: Math.round(tStart - t0), first20FramesMs: Math.round(tFirst - tStart), materialsMs: Math.round(performance.now() - tFirst) };
    if (play) {
      [...document.querySelectorAll('button')].find(b => /take flight/i.test(b.textContent))?.click();
      R.centre();
      await R.pump(10, HB.dtMs);
    }
    return { materials: TERRAIN.materials, mode: WB.mode, quality: WB.settings.quality, tod: WB.settings.tod,
             canvas: [GLX.canvas.width, GLX.canvas.height], loadMs: Math.round(performance.now() - t0), ...HB.renderer() };
  };
  const stats = a => { const b = a.slice().sort((x, y) => x - y), q = p => b[Math.min(b.length - 1, Math.floor(p * b.length))];
    return { mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3), p50: +q(0.5).toFixed(3), p90: +q(0.9).toFixed(3),
             p99: +q(0.99).toFixed(3), max: +b[b.length - 1].toFixed(3) }; };
  // frame-time benchmark: n frames, each followed by a 1-pixel read-back so the GPU work is finished inside the timing
  HB.bench = async (n = 300, warm = 60) => {
    const P = WB.PROF, gl = GLX.gl, px = new Uint8Array(4);
    P.on = true;
    await R.pump(warm, HB.dtMs);
    P.reset();
    const wall = [], cpu = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      R.frame(HB.dtMs);
      const t1 = performance.now();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t2 = performance.now();
      cpu.push(t1 - t0); wall.push(t2 - t0);
      await new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
    }
    await R.pump(6, HB.dtMs); // the timer queries land a few frames late
    const gpu = {}; for (const [k, v] of Object.entries(P.ms)) gpu[k] = +v.toFixed(3);
    return { frames: n, wallMs: stats(wall), cpuMs: stats(cpu), gpuMs: gpu, gpuTotalMs: +P.total.toFixed(3),
             timerQuery: HB.renderer().timerQuery, canvas: [GLX.canvas.width, GLX.canvas.height],
             quality: WB.settings.quality, res: WB.settings.res };
  };
})();
"""


def gpu_cache(profile, cache_dir, save):
    """Carry the GPU shader caches from run to run (each run's profile is fresh): compiling the game's shaders for
    D3D11 takes ~15 s the first time, ~1 s from the cache. Only compiled-shader caches, keyed by the shader source —
    never the HTTP cache, so a rebuilt page is always loaded fresh. Best effort: any failure just means a slower load."""
    for sub in GPU_CACHES:
        live, kept = os.path.join(profile, sub), os.path.join(cache_dir, sub)
        tmp, old = f'{kept}.tmp{os.getpid()}', f'{kept}.old{os.getpid()}'
        try:
            if not save:
                if os.path.isdir(kept):
                    shutil.copytree(kept, live, dirs_exist_ok=True)
            elif os.path.isdir(live):  # copy aside, then swap in (another run may be reading the old one)
                shutil.copytree(live, tmp)
                if os.path.isdir(kept):
                    os.replace(kept, old)
                os.replace(tmp, kept)
        except OSError:
            pass
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(old, ignore_errors=True)


class Browser:
    """A headless browser with one page, driven over the DevTools protocol. Use as a context manager."""

    def __init__(self, exe='chrome', size=(1920, 1080), port=0, console=False, settings=None, verbose=False):
        self.exe = next((p for p in BROWSERS.get(exe, [exe]) if os.path.isfile(p)), None)
        if not self.exe:
            raise SystemExit(f'browser not found: {exe}')
        self.size, self.port, self.console, self.settings, self.verbose = size, port, console, settings, verbose
        self.proc = self.ws = self.job = self.profile = None
        self.id, self.events, self.session, self.loaded = 0, [], None, False

    # ── lifecycle ──
    def __enter__(self):
        try:
            self.start()
        except BaseException:
            self.close()
            raise
        return self

    def __exit__(self, *a):
        self.close()

    def start(self):
        # profiles left behind by runs that were killed outright (their browsers died with them: see _job_for)
        for d in os.listdir(tempfile.gettempdir()):
            p = os.path.join(tempfile.gettempdir(), d)
            if d.startswith('wb-headless-') and not d.startswith(os.path.basename(GPU_CACHE_DIR)) and '.' not in d:
                try:
                    if time.time() - os.path.getmtime(p) > 6 * 3600:
                        shutil.rmtree(p, ignore_errors=True)
                except OSError:
                    pass
        self.profile = tempfile.mkdtemp(prefix='wb-headless-')
        # one cache per browser (Chrome's and Edge's shader caches aren't interchangeable)
        self.cache_dir = GPU_CACHE_DIR + '-' + os.path.splitext(os.path.basename(self.exe))[0].lower()
        gpu_cache(self.profile, self.cache_dir, save=False)
        w, h = self.size
        args = [self.exe, '--headless=new', f'--user-data-dir={self.profile}', f'--remote-debugging-port={self.port}',
                '--remote-debugging-address=127.0.0.1',
                # GPU WebGL through ANGLE on Direct3D 11, on the discrete GPU; never the software rasterizer
                '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu',
                '--disable-software-rasterizer',
                '--mute-audio', '--autoplay-policy=user-gesture-required',
                f'--window-size={w},{h}', '--force-device-scale-factor=1', '--hide-scrollbars',
                '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
                '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
                '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
                '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows', '--disable-hang-monitor', 'about:blank']
        si = subprocess.STARTUPINFO() if os.name == 'nt' else None
        flags = 0
        if si is not None:  # belt and braces: even a stray window would start hidden and never take focus
            si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            si.wShowWindow = 0  # SW_HIDE
            flags = subprocess.CREATE_NO_WINDOW | 0x4  # CREATE_SUSPENDED: join the job before it spawns anything
        self.proc = subprocess.Popen(args, startupinfo=si, creationflags=flags, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=None if self.verbose else subprocess.DEVNULL)
        if os.name == 'nt':
            self.job = _job_for(self.proc)
            ctypes.WinDLL('ntdll').NtResumeProcess(ctypes.c_void_p(int(self.proc._handle)))
        # the browser writes its DevTools port and path once it listens
        portfile, t0 = os.path.join(self.profile, 'DevToolsActivePort'), time.time()
        while True:
            if self.proc.poll() is not None:
                raise SystemExit(f'browser exited at startup (code {self.proc.returncode}); rerun with --verbose')
            try:
                with open(portfile) as f:
                    lines = f.read().split()
                if len(lines) >= 2:
                    break
            except OSError:
                pass
            if time.time() - t0 > 30:
                raise SystemExit('browser did not open its DevTools port in 30 s')
            time.sleep(0.05)
        self.port = int(lines[0])
        self.ws = WebSocket(f'ws://127.0.0.1:{self.port}{lines[1]}')
        self.version = self.call('Browser.getVersion')
        tid = self.call('Target.createTarget', {'url': 'about:blank'})['targetId']
        self.session = self.call('Target.attachToTarget', {'targetId': tid, 'flatten': True})['sessionId']
        for m in ('Page.enable', 'Runtime.enable'):
            self.call(m, session=True)
        self.call('Emulation.setDeviceMetricsOverride', {'width': w, 'height': h, 'deviceScaleFactor': 1, 'mobile': False},
                  session=True)
        self.call('Emulation.setFocusEmulationEnabled', {'enabled': True}, session=True)
        pre = BRIDGE
        if self.settings is not None:
            pre = (f"try {{ localStorage.setItem('windborne.settings', JSON.stringify(Object.assign("
                   f"JSON.parse(localStorage.getItem('windborne.settings') || '{{}}'), {json.dumps(self.settings)}))); }} "
                   f"catch (e) {{}}\n") + pre
        with open(os.path.join(TOOLS, 'review-harness.js'), encoding='utf-8') as f:
            harness = f.read()
        # the harness (IIFE-wrapped so its top-level names stay out of the game's scope), then the bridge
        self.call('Page.addScriptToEvaluateOnNewDocument', {'source': '(() => {\n' + harness + '\n})();\n' + pre},
                  session=True)
        self.goto('about:blank', timeout=10)  # a fresh document with the scripts in

    def close(self):
        if self.ws:
            try:
                self.ws.send(json.dumps({'id': 999999, 'method': 'Browser.close'}))
            except OSError:
                pass
            self.ws.close()
        if self.proc:
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                pass
            if self.proc.poll() is None:
                # still running: kill its whole tree (GPU, renderers), by the PID of the process we started — never
                # the user's own browsers
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/F', '/T', '/PID', str(self.proc.pid)], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
                else:
                    self.proc.kill()
                try:
                    self.proc.wait(5)
                except subprocess.TimeoutExpired:
                    pass
        if self.job:
            ctypes.WinDLL('kernel32').CloseHandle(ctypes.c_void_p(self.job))  # kills anything still in the job
            self.job = None
        if not getattr(self, 'profile', None):
            return
        if self.loaded:
            time.sleep(0.3)
            gpu_cache(self.profile, self.cache_dir, save=True)
        for _ in range(20):
            shutil.rmtree(self.profile, ignore_errors=True)
            if not os.path.exists(self.profile):
                break
            time.sleep(0.25)

    # ── protocol ──
    def call(self, method, params=None, session=None, timeout=600):
        self.id += 1
        mid, msg = self.id, {'id': self.id, 'method': method, 'params': params or {}}
        if session:
            msg['sessionId'] = self.session
        self.ws.send(json.dumps(msg))
        end = time.time() + timeout
        while True:
            try:
                m = json.loads(self.ws.recv(max(0.01, end - time.time())))
            except socket.timeout:
                raise TimeoutError(f'{method}: no answer in {timeout:g} s') from None
            if m.get('id') == mid:
                if 'error' in m:
                    raise RuntimeError(f"{method}: {m['error'].get('message')} {m['error'].get('data', '')}")
                return m.get('result', {})
            self._event(m)

    def _event(self, m):
        meth, p = m.get('method'), m.get('params', {})
        if meth == 'Runtime.exceptionThrown':
            d = p.get('exceptionDetails', {})
            log('[page exception]', (d.get('exception', {}).get('description') or d.get('text', ''))[:600])
        elif meth == 'Runtime.consoleAPICalled':
            kind = p.get('type')
            if self.console or kind in ('error', 'assert'):
                text = ' '.join(str(a.get('value', a.get('description', a.get('type', '')))) for a in p.get('args', []))
                log(f'[page {kind}]', text[:600])
        elif meth == 'Page.loadEventFired':
            self.events.append('load')

    def js(self, code, timeout=600):
        """Evaluate JavaScript in the page and return its JSON value. `code` may be an expression or a block of statements
        (use `return` for a value); either may use await."""
        src = f'(async () => HB.json(await ({code}\n)))()'
        # not an expression (it doesn't compile as one)? then it's a block of statements
        if self.call('Runtime.compileScript', {'expression': src, 'sourceURL': '', 'persistScript': False},
                     session=True).get('exceptionDetails'):
            src = f'(async () => HB.json(await (async () => {{ {code}\n}})()))()'
        r = self.call('Runtime.evaluate', {'expression': src, 'awaitPromise': True, 'returnByValue': True},
                      session=True, timeout=timeout)
        ex = r.get('exceptionDetails')
        if ex:
            raise RuntimeError('page: ' + (ex.get('exception', {}).get('description') or ex.get('text', ''))[:1500])
        v = r.get('result', {}).get('value')
        return json.loads(v) if isinstance(v, str) else v

    def goto(self, url, timeout=60):
        self.events.clear()
        r = self.call('Page.navigate', {'url': url}, session=True)
        if r.get('errorText'):
            raise SystemExit(f'cannot load {url}: {r["errorText"]} (is the static server on 127.0.0.1:8765 running?)')
        end = time.time() + timeout
        while 'load' not in self.events and time.time() < end:
            try:
                self._event(json.loads(self.ws.recv(max(0.01, end - time.time()))))
            except socket.timeout:
                break

    def drain(self, outdir):
        """Write the frames the page saved (R.shot / R.pair) to outdir/<name>.png; returns their paths."""
        paths = []
        while True:
            item = self.js('HB.out.length ? HB.out.shift() : null')
            if not item:
                return paths
            name, data = item
            paths.append(save_png(outdir, name, data))

    def page_shot(self, outdir, name):
        """The composited page (canvas plus any DOM on top) as the user would see it."""
        self.js('R.pump(2, HB.dtMs)')
        r = self.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False}, session=True)
        return save_png(outdir, name, r['data'])


def save_png(outdir, name, data):
    name = re.sub(r'[^A-Za-z0-9_.,=-]', '_', name)[:120]
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, name + '.png')
    with open(path, 'wb') as f:
        f.write(base64.b64decode(data.split(',', 1)[1] if data.startswith('data:') else data))
    return path


# ── spots and URLs ──
def parse_at(s):
    v = [float(x) for x in re.split(r'[,\s]+', s.strip()) if x]
    if not 2 <= len(v) <= 4:
        raise ValueError(f'want X,Y[,HEADING[,ALT]], got {s!r}')
    return ','.join(f'{x:g}' for x in v)


def spots_from(args):
    """[(name, 'X,Y,H,A')] from --at (NAME=X,Y,H,A or X,Y,H,A) and --spots; --name names a single spot, else prefixes."""
    spots, pre = [], (args.name + '_' if args.name else '')
    for i, a in enumerate(args.at or []):
        name, at = a.split('=', 1) if '=' in a else (None, a)
        if name:
            name = pre + name
        elif len(args.at) == 1:
            name = args.name or args.cmd
        else:
            name = f'{pre or args.cmd + "_"}{i + 1}'
        spots.append((name, parse_at(at)))
    if args.spots:
        with open(args.spots) as f:
            for line in f:
                line = line.split('#', 1)[0].strip()
                if line:
                    name, rest = line.split(None, 1)
                    spots.append((pre + name, parse_at(rest)))
    return spots


def page_url(base, at=None, island=None, glider=False):
    parts = [] if glider else ['fly']
    if at:
        parts.append('at=' + at)
    if island:
        parts.append('island=' + island)
    return base + ('&' if '?' in base else '?') + '&'.join(parts) if parts else base


def check_renderer(info, allow_software):
    r = info.get('renderer', '')
    if SOFTWARE_GL.search(r) or not r or r == 'no WebGL2':
        msg = f'WebGL is not on the GPU: {r!r}'
        if not allow_software:
            raise SystemExit(msg + ' (pass --allow-software to continue anyway)')
        log('WARNING:', msg)


def load(b, args, url, js_steps=()):
    """Navigate, wait for the game, run the JS steps (saving any R.shot frames), settle. Returns the ready info."""
    b.goto(url)
    try:
        info = b.js(f'HB.ready({{ play: {json.dumps(bool(args.glider))}, materials: {json.dumps(not args.no_materials)}, '
                    f'timeout: {int(args.timeout * 1000)} }})', timeout=args.timeout + 30)
    except RuntimeError as e:  # the page's own message (the game didn't start, or ignored ?fly/?at/?island) is enough
        raise SystemExit(f'{url}: ' + str(e).removeprefix('page: Error: ').split('\n    at ')[0])
    check_renderer(info, args.allow_software)
    b.loaded = True
    for step in js_steps or ():
        v = b.js(step, timeout=args.timeout + 600)
        if v is not None:
            print(json.dumps(v))
        for p in b.drain(args.out):
            print('saved', p)
    if args.settle:
        b.js(f'R.pump({int(args.settle)}, HB.dtMs)')
    return info


def shot(b, args, name):
    return b.page_shot(args.out, name) if args.page else save_png(args.out, name, b.js('HB.grab()'))


# ── commands ──
def cmd_info(b, args):
    blank = b.js('HB.renderer()')
    gpu = b.call('SystemInfo.getInfo').get('gpu', {})
    out = {'browser': b.version.get('product'), 'exe': b.exe, 'devtoolsPort': b.port, 'blankPage': blank,
           'gpuDevices': [{k: d.get(k) for k in ('vendorString', 'deviceString', 'driverVersion')} for d in gpu.get('devices', [])],
           'featureStatus': {k: v for k, v in gpu.get('featureStatus', {}).items() if 'webgl' in k or k in ('gpu_compositing', 'rasterization')}}
    if not args.no_page:
        url = page_url(args.url, parse_at(args.at[0]) if args.at else None, args.island, args.glider)
        out['page'] = url
        out['game'] = load(b, args, url)
    print(json.dumps(out, indent=1))
    check_renderer((out.get('game') or blank), args.allow_software)


def cmd_shot(b, args):
    spots = spots_from(args) or [(args.name or 'shot', None)]
    for name, at in spots:
        t0 = time.time()
        info = load(b, args, page_url(args.url, at, args.island, args.glider), args.js)
        p = shot(b, args, name)
        log(f'{name}: {time.time() - t0:.1f} s (load {info["loadMs"] / 1000:.1f} s, {info["quality"]}, {info["renderer"]})')
        print('saved', p)


def cmd_run(b, args):
    spots = spots_from(args)
    if len(spots) > 1:
        raise SystemExit('run takes one spot (use shot for several, or R.view in --js)')
    url = page_url(args.url, spots[0][1] if spots else None, args.island, args.glider)
    info = load(b, args, url, args.js)
    for e in args.expr or []:
        print(json.dumps(b.js(e)))
    if args.shot:
        print('saved', shot(b, args, args.shot))
    if not args.expr and not args.js:
        print(json.dumps(info))


def cmd_bench(b, args):
    spots = spots_from(args) or [('bench', None)]
    res = []
    for name, at in spots:
        info = load(b, args, page_url(args.url, at, args.island, args.glider), args.js)
        r = b.js(f'HB.bench({int(args.frames)}, 60)', timeout=args.timeout + 600)
        r = {'spot': name, 'at': at, 'renderer': info['renderer'], **r}
        res.append(r)
        print(json.dumps(r, indent=1))
    return res


def stitch(a, b, out, labels):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        log('PIL not available: no side-by-side image (the two PNGs are saved)')
        return None
    A, B = Image.open(a).convert('RGB'), Image.open(b).convert('RGB')
    w, h = A.size[0] // 2, A.size[1] // 2
    S = Image.new('RGB', (w * 2 + 8, h), (18, 18, 18))
    S.paste(A.resize((w, h), Image.LANCZOS), (0, 0))
    S.paste(B.resize((w, h), Image.LANCZOS), (w + 8, 0))
    try:
        font = ImageFont.truetype('arialbd.ttf', 24)
    except OSError:
        font = ImageFont.load_default()
    d = ImageDraw.Draw(S)
    for x, t in ((14, labels[0]), (w + 22, labels[1])):
        d.text((x + 2, 14), t, font=font, fill=(0, 0, 0))
        d.text((x, 12), t, font=font, fill=(255, 255, 255))
    S.save(out, quality=90)
    return out


def cmd_pair(b, args):
    spots = spots_from(args) or [(args.name or 'pair', None)]
    a_url, b_url = args.url, args.b_url or args.url
    a_island, b_island = args.island, args.b_island or args.island
    a_js, b_js = args.js or [], (args.js or []) + (args.b_js or [])
    labels = args.labels or ['A: ' + describe(a_url, a_island, a_js), 'B: ' + describe(b_url, b_island, b_js)]
    for name, at in spots:
        t0 = time.time()
        pa = pb = None
        for side, url, island, js in (('a', a_url, a_island, a_js), ('b', b_url, b_island, b_js)):
            load(b, args, page_url(url, at, island, args.glider), js)
            p = shot(b, args, f'{name}_{side}')
            print('saved', p)
            if side == 'a':
                pa = p
            else:
                pb = p
        s = stitch(pa, pb, os.path.join(args.out, f'sbs_{name}.jpg'), labels)
        if s:
            print('saved', s)
        log(f'{name}: {time.time() - t0:.1f} s for the pair')


def describe(url, island, js):
    s = url.rsplit('/', 1)[-1]
    if island:
        s += f' island={island}'
    if js:
        s += ' + js'
    return s[:60]


def serve(root):
    """A static server for `root` on a free 127.0.0.1 port, for the duration of the run; returns its base URL."""
    from functools import partial
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    httpd = ThreadingHTTPServer(('127.0.0.1', 0), partial(Quiet, directory=root))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f'http://127.0.0.1:{httpd.server_address[1]}/'


def main():
    sys.stdout.reconfigure(line_buffering=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--url', default=DEFAULT_URL, help='page to load (a muted test build!): a URL, or a path like '
                        'windborne-test.html to serve it from --root on a private port for this run; default ' + DEFAULT_URL)
    common.add_argument('--root', default=ROOT, help='folder served for a --url/--b-url path (default: this checkout)')
    common.add_argument('--island', help='islands/NAME/ (adds &island=NAME)')
    common.add_argument('--at', action='append', help='spot X,Y[,HEADING[,ALT]] (design-grid km, compass degrees, m above '
                        'ground); NAME=X,Y,H,A to name it; repeat for several')
    common.add_argument('--spots', help='file of spots, one per line: NAME X,Y,HDG,ALT (or NAME X Y HDG ALT); # comments')
    common.add_argument('--name', help='output name (single spot) or prefix (several)')
    common.add_argument('--glider', action='store_true', help='take flight in the glider at the spot instead of the ?fly '
                        'spectator camera')
    common.add_argument('--js', action='append', help='JavaScript step run after the game is ready, before settling '
                        '(expression or statements; await works; R.* harness and WB.* available); repeatable')
    common.add_argument('--settings', type=json.loads, help='JSON merged into the game\'s saved settings before it starts, '
                        'e.g. \'{"tod":"dusk","quality":"high"}\'')
    common.add_argument('--settle', type=int, help='frames (1/60 s each) pumped before a shot (default 150; bench: 0, '
                        'it has its own 60 warm-up frames)')
    common.add_argument('--no-materials', action='store_true', help="don't wait for the photo ground materials")
    common.add_argument('--page', action='store_true', help='screenshot the composited page (canvas + HUD/DOM) instead of '
                        'reading back the canvas')
    common.add_argument('--out', default=os.path.join(ROOT, 'shots'), help='output folder (default: shots/ next to tools/)')
    common.add_argument('--size', default='1920x1080', help='viewport WxH (default 1920x1080)')
    common.add_argument('--browser', default='chrome', help='chrome, edge, or a path to the executable')
    common.add_argument('--port', type=int, default=0, help='DevTools port (default 0: the browser picks a free one)')
    common.add_argument('--timeout', type=float, default=90, help='seconds to wait for the game to load (default 90)')
    common.add_argument('--allow-software', action='store_true', help="continue even if WebGL isn't on the GPU")
    common.add_argument('--console', action='store_true', help='print the page\'s console output (errors always print)')
    common.add_argument('--verbose', action='store_true', help="show the browser's own stderr")

    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0], formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__.split('\n\n', 1)[1])
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('info', parents=[common], help='browser, GPU and WebGL renderer (on a blank page and in the game)')
    p.add_argument('--no-page', action='store_true', help="don't load the game, just the blank page")
    sub.add_parser('shot', parents=[common], help='screenshots of one or more spots')
    p = sub.add_parser('pair', parents=[common], help='before/after pairs (A: --url/--island/--js; B: --b-*)')
    p.add_argument('--b-url', help='page for B (default: --url)')
    p.add_argument('--b-island', help='island for B (default: --island)')
    p.add_argument('--b-js', action='append', help='extra JS steps for B only, e.g. "TERRAIN.materials = false"')
    p.add_argument('--labels', nargs=2, help='labels for the side-by-side image')
    p = sub.add_parser('run', parents=[common], help='run --js steps and print --expr values as JSON')
    p.add_argument('--expr', action='append', help='expression to print as JSON, after the steps and settling; repeatable')
    p.add_argument('--shot', help='also save a screenshot under this name at the end')
    p = sub.add_parser('bench', parents=[common], help='frame-time benchmark: WB.PROF GPU passes + synced wall time')
    p.add_argument('--frames', type=int, default=300, help='frames to time (default 300, after 60 warm-up frames)')
    args = ap.parse_args()
    if args.settle is None:
        args.settle = 0 if args.cmd == 'bench' else 150
    for k in ('url', 'b_url'):
        u = getattr(args, k, None)
        if u and re.search(r'(^|/)windborne\.html(\?|$)', u):
            raise SystemExit('refusing to load windborne.html: it plays audio. Use a muted windborne-test-*.html build.')
        if u and not re.match(r'https?://', u):
            u = u.lstrip('/')
            if not os.path.isfile(os.path.join(args.root, u.split('?', 1)[0])):
                raise SystemExit(f'no such page: {os.path.join(args.root, u)}')
            base = getattr(args, '_served', None) or serve(args.root)
            args._served = base
            setattr(args, k, base + u)
    w, h = (int(v) for v in args.size.lower().split('x'))
    t0 = time.time()
    with Browser(args.browser, (w, h), args.port, args.console, args.settings, args.verbose) as b:
        {'info': cmd_info, 'shot': cmd_shot, 'pair': cmd_pair, 'run': cmd_run, 'bench': cmd_bench}[args.cmd](b, args)
    log(f'done in {time.time() - t0:.1f} s (browser closed)')


if __name__ == '__main__':
    main()
