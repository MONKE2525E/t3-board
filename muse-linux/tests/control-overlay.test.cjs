const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'native/control-overlay.c');
const LOGO_HEADER = path.join(ROOT, 'native/muse-logo.h');
const ICON = path.join(ROOT, 'assets/icon.png');
const XML_DIR = path.join(ROOT, 'native/protocols/overlay');
const WORK_BASE = '/tmp/muse-port-d6c9/control';
fs.mkdirSync(WORK_BASE, { recursive: true });
const WORK = fs.mkdtempSync(path.join(WORK_BASE, `overlay-o${process.pid}-`));
const BINARY = path.join(WORK, 'muse-control-overlay');

function compileHelper() {
  if (fs.existsSync(BINARY)) return BINARY;
  const generated = path.join(WORK, 'generated');
  fs.mkdirSync(generated, { recursive: true });
  const sources = [];
  for (const file of fs.readdirSync(XML_DIR).filter(name => name.endsWith('.xml'))) {
    const name = path.basename(file, '.xml');
    const xml = path.join(XML_DIR, file);
    const header = path.join(generated, name + '-client-protocol.h');
    const source = path.join(generated, name + '-protocol.c');
    execFileSync('wayland-scanner', ['client-header', xml, header], { stdio: 'pipe' });
    execFileSync('wayland-scanner', ['private-code', xml, source], { stdio: 'pipe' });
    sources.push(source);
  }
  const flags = execFileSync('pkg-config', ['--cflags', '--libs', 'wayland-client', 'cairo', 'json-glib-1.0'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  execFileSync('cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', SOURCE, '-o', BINARY, '-I' + generated, ...sources, ...flags, '-lm'], { stdio: 'pipe' });
  fs.chmodSync(BINARY, 0o755);
  return BINARY;
}

function readPng(file) {
  const data = fs.readFileSync(file);
  assert.equal(data.subarray(0, 8).compare(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 0);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 8 <= data.length) {
    const len = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString('ascii');
    const chunk = data.subarray(offset + 8, offset + 8 + len);
    offset += 12 + len;
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      colorType = chunk[9];
    } else if (type === 'IDAT') idat.push(chunk);
    else if (type === 'IEND') break;
  }
  assert.ok(colorType === 2 || colorType === 6, 'demo PNG must be RGB or RGBA');
  const bpp = colorType === 6 ? 4 : 3;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  let src = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    const row = inflated.subarray(src, src + stride);
    src += stride;
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? out[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      let value = row[i];
      if (filter === 1) value = (value + left) & 255;
      else if (filter === 2) value = (value + up) & 255;
      else if (filter === 3) value = (value + ((left + up) >> 1)) & 255;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value = (value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255;
      } else if (filter !== 0) throw new Error('unsupported png filter ' + filter);
      out[i] = value;
    }
    prev = Buffer.from(out);
  }
  return {
    width,
    height,
    at(x, y) {
      const ix = Math.round(x);
      const iy = Math.round(y);
      if (ix < 0 || iy < 0 || ix >= width || iy >= height) return { r: 0, g: 0, b: 0, a: 0 };
      const i = (iy * width + ix) * bpp;
      return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2], a: bpp === 4 ? pixels[i + 3] : 255 };
    },
    each(fn) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) fn(this.at(x, y), x, y);
      }
    },
  };
}

function isOrange(p) {
  // Stop red (#e5484d) is deliberately not orange: orange has a much higher green share.
  return p.a > 48 && p.r > 180 && p.g > 55 && p.g < 180 && p.g > p.r * 0.42 && p.b < 90 && p.r > p.b + 80;
}

function isMuseBlue(p) {
  return p.a > 48 && p.b > 150 && p.b > p.r + 50 && p.g > 70 && p.g < 210 && p.r < 150;
}

function isWhiteish(p) {
  return p.a > 180 && p.r > 210 && p.g > 210 && p.b > 210;
}

function isStopRed(p) {
  return p.r > 200 && p.g < 120 && p.b < 120;
}

function isDark(p) {
  return p.r < 40 && p.g < 40 && p.b < 45;
}

function countWhere(png, fn, box) {
  let n = 0;
  const [x0, y0, x1, y1] = box || [0, 0, png.width, png.height];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) if (fn(png.at(x, y))) n++;
  }
  return n;
}

// Demo geometry at 1280x800: badge canvas is 392 wide, centered; the pill's top edge sits at the top margin.
const PILL_LEFT = (1280 - 392) / 2 + 14;
const TIP = { x: 1280 * 0.58, y: 800 * 0.42 };

function renderDemo(name, width, height, state, extra = [], env = {}) {
  compileHelper();
  const out = path.join(WORK, name);
  const args = [...extra, '--render-demo', out, String(width), String(height)];
  if (state) args.push(state);
  execFileSync(BINARY, args, { stdio: 'pipe', env: { ...process.env, ...env } });
  return { png: readPng(out), bytes: fs.readFileSync(out) };
}

function exitStatus(args) {
  compileHelper();
  try {
    execFileSync(BINARY, args, { stdio: 'pipe' });
    return 0;
  } catch (error) {
    return error.status;
  }
}

test('overlay source keeps its lifecycle, hit testing, and privacy guards', () => {
  const source = fs.readFileSync(SOURCE, 'utf8');
  assert.match(source, /set_exclusive_zone\(s->layer, -1\)/);
  assert.match(source, /KEYBOARD_INTERACTIVITY_NONE/);
  assert.match(source, /NS_GLOW "muse-control-overlay"/);
  assert.match(source, /NS_STOP "muse-control-stop"/);
  assert.match(source, /HEARTBEAT_MS = 6000/);
  assert.match(source, /DEFAULT_TOP_MARGIN = 44/);
  assert.match(source, /#4185ff/);
  assert.match(source, /65\.0 \/ 255\.0/);
  assert.match(source, /emit_error\("no_outputs"\)/);
  assert.match(source, /emit_error\("timeout"\)/);
  assert.match(source, /registry_global_remove/);
  assert.equal(source.includes('ORANGE_'), false);
  assert.equal(/\btask\b/.test(source), false, 'private task text must have no path into the overlay');
  // Only the two buttons accept input, and nothing while hidden for capture.
  assert.match(source, /if \(s->kind == SURF_BADGE && !app->capture_hidden\) \{\s*rect_add\(region, &s->toggle\);\s*rect_add\(region, &s->stop\);/);
  assert.equal((source.match(/wl_region_add\(/g) || []).length, 1);
  // Badge is top-anchored only (pill-sized, centered), never full width.
  assert.match(source, /anchor = ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP;/);
  assert.match(source, /app->top_margin > PILL_Y \? app->top_margin - PILL_Y : 0/);
});

test('overlay draws no replacement arrow over the system cursor and no generic M glyph', () => {
  const source = fs.readFileSync(SOURCE, 'utf8');
  assert.equal(source.includes('cursor_arrow_path'), false);
  assert.equal(source.includes('draw_m_glyph'), false);
  assert.equal(source.includes('draw_cursor('), false);
  assert.match(source, /draw_pointer_mark/);
  assert.match(source, /muse_logo_png/);
  assert.match(source, /--logo/);
  assert.match(source, /--top-margin/);
});

test('protocol: pause, resume, stop events and the paused/capture_hidden commands exist', () => {
  const source = fs.readFileSync(SOURCE, 'utf8');
  assert.match(source, /\{\\"event\\":\\"resume\\"\}/);
  assert.match(source, /\{\\"event\\":\\"pause\\"\}/);
  assert.match(source, /emit_stop\(\)/);
  assert.match(source, /obj_bool\(obj, "paused", &paused\)/);
  assert.match(source, /"pause_until_ms"/);
  assert.match(source, /"human_input"/);
  assert.match(source, /obj_bool\(obj, "capture_hidden", &hidden\)/);
  assert.match(source, /wl_display_sync\(app->display\)/);
  assert.match(source, /\\"event\\":\\"capture\\"/);
  assert.match(source, /CAPTURE_MAX_MS/, 'hidden state must fail open');
  // A paused session forgets the pointer so the human is not shadowed.
  assert.match(source, /if \(app->paused\) visible = click = 0;/);
  assert.match(source, /MUSE_REDUCED_MOTION/);
  // Heartbeat keeps running while hidden: the ping handler never checks capture state.
  const ping = source.slice(source.indexOf('obj_bool(obj, "ping"'), source.indexOf('obj_bool(obj, "ping"') + 160);
  assert.equal(ping.includes('capture'), false);
});

test('only whitelisted action labels can be drawn', () => {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const list = source.slice(source.indexOf('ACTION_WHITELIST[]'), source.indexOf('};', source.indexOf('ACTION_WHITELIST[]')));
  for (const label of ['Ready', 'Observing', 'Moving pointer', 'Clicking', 'Double clicking', 'Dragging', 'Scrolling', 'Typing', 'Pressing a key', 'Focusing', 'Working']) {
    assert.ok(list.includes(`"${label}"`), label);
  }
  assert.match(source, /const char \*next = "Working";/);
});

test('embedded logo header is the real Muse icon, downscaled', () => {
  const header = fs.readFileSync(LOGO_HEADER, 'utf8');
  const bytes = Buffer.from([...header.matchAll(/0x([0-9a-f]{2})/g)].map(m => parseInt(m[1], 16)));
  assert.equal(bytes.subarray(0, 8).compare(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 0);
  assert.equal(bytes.readUInt32BE(16), 128);
  assert.equal(bytes.readUInt32BE(20), 128);
  assert.match(header, new RegExp(`muse_logo_png_len = ${bytes.length}UL`));
  assert.equal(fs.readFileSync(ICON).readUInt32BE(16), 256, 'packaged assets/icon.png is the source');
});

test('helper compiles off native/bin; active demo shows logo, Pause, Stop and sits below the top bar', () => {
  const binary = compileHelper();
  assert.equal(path.dirname(binary).startsWith('/tmp/muse-port-d6c9/control/overlay-o'), true);
  const { png } = renderDemo('active.png', 1280, 800, '', ['--logo', ICON]);
  assert.equal(png.width, 1280);
  assert.equal(png.height, 800);
  assert.equal(countWhere(png, isOrange), 0);
  assert.ok(isMuseBlue(png.at(2, 400)) || isMuseBlue(png.at(3, 400)), 'left glow edge is Muse blue');
  assert.ok(isMuseBlue(png.at(640, 2)) || isMuseBlue(png.at(640, 3)), 'top glow edge is Muse blue');
  // The top bar band (y 14..32) is untouched by the badge, and the pill starts at the 44px margin.
  const bar = png.at(640, 20);
  assert.ok(bar.r < 30 && bar.g < 30 && bar.b < 35, 'badge does not cover the top bar');
  assert.ok(!isDark(png.at(640, 40)), 'nothing between the bar and the pill');
  assert.ok(isDark(png.at(640, 56)) || isDark(png.at(PILL_LEFT + 120, 56)), 'pill body is a solid dark pill');
  // Genuine logo: a light tile with the blue Muse stroke, at the pill's left end.
  const logoBox = [PILL_LEFT + 6, 50, PILL_LEFT + 46, 90];
  assert.ok(countWhere(png, isWhiteish, logoBox) > 120, 'logo tile is drawn');
  assert.ok(countWhere(png, isMuseBlue, logoBox) > 40, 'logo blue stroke is drawn');
  // Buttons: red Stop, neutral Pause.
  assert.ok(countWhere(png, isStopRed, [750, 52, 814, 84]) > 1200, 'Stop button is red');
  assert.equal(countWhere(png, isStopRed, [658, 52, 744, 84]), 0, 'Pause is not red');
  assert.equal(countWhere(png, isMuseBlue, [662, 54, 740, 62]), 0, 'Pause is neutral, not the filled Resume style');
});

test('logo falls back to the embedded copy when --logo is missing or unreadable', () => {
  const missing = renderDemo('logo-missing.png', 1280, 800, '', ['--logo', path.join(WORK, 'nope.png')]).png;
  const bad = path.join(WORK, 'not-a-png.png');
  fs.writeFileSync(bad, 'nope');
  const broken = renderDemo('logo-bad.png', 1280, 800, '', ['--logo', bad]).png;
  const logoBox = [PILL_LEFT + 6, 50, PILL_LEFT + 46, 90];
  for (const png of [missing, broken]) {
    assert.ok(countWhere(png, isWhiteish, logoBox) > 120);
    assert.ok(countWhere(png, isMuseBlue, logoBox) > 40);
  }
});

test('paused demo shows Resume + Stop, dims the glow, and draws no pointer mark', () => {
  const active = renderDemo('active2.png', 1280, 800, '').png;
  const paused = renderDemo('paused.png', 1280, 800, 'paused').png;
  assert.ok(countWhere(paused, isMuseBlue, [662, 52, 740, 62]) > 300, 'Resume is the filled Muse-blue button');
  assert.ok(countWhere(paused, isStopRed, [750, 52, 814, 84]) > 1200, 'Stop stays available while paused');
  const chip = [TIP.x + 18, TIP.y + 16, TIP.x + 42, TIP.y + 40];
  assert.ok(countWhere(active, isWhiteish, chip) > 40, 'active state draws the small Muse badge by the pointer');
  assert.equal(countWhere(paused, isWhiteish, chip), 0, 'paused state draws nothing near the pointer');
  assert.equal(countWhere(paused, isMuseBlue, [TIP.x - 30, TIP.y - 30, TIP.x + 40, TIP.y + 40]), 0);
  assert.ok(countWhere(paused, isMuseBlue) < countWhere(active, isMuseBlue), 'glow is dimmer when paused');
});

test('pointer feedback never redraws an arrow at the hotspot', () => {
  for (const state of ['', 'click']) {
    const { png } = renderDemo(`pointer-${state || 'idle'}.png`, 1280, 800, state);
    assert.equal(countWhere(png, isWhiteish, [TIP.x - 8, TIP.y - 8, TIP.x + 5, TIP.y + 12]), 0, 'no arrow shape at the real cursor');
    assert.ok(countWhere(png, isWhiteish, [TIP.x + 18, TIP.y + 16, TIP.x + 42, TIP.y + 40]) > 40, 'Muse badge offset from the pointer');
  }
  const idle = renderDemo('pointer-idle2.png', 1280, 800, '').png;
  const click = renderDemo('pointer-click2.png', 1280, 800, 'click').png;
  const ringBox = [TIP.x - 32, TIP.y - 32, TIP.x + 32, TIP.y + 32];
  assert.equal(countWhere(idle, isMuseBlue, [TIP.x - 32, TIP.y - 32, TIP.x + 8, TIP.y + 8]), 0);
  assert.ok(countWhere(click, isMuseBlue, ringBox) > countWhere(idle, isMuseBlue, ringBox) + 60, 'click adds ripple feedback');
});

test('hidden demo (capture) paints nothing: output equals the bare fixture', () => {
  const { png } = renderDemo('hidden.png', 1280, 800, 'hidden');
  assert.equal(countWhere(png, isMuseBlue), 0);
  assert.equal(countWhere(png, isStopRed), 0);
  const bg = png.at(640, 60);
  assert.ok(bg.r > 55 && bg.r < 70 && bg.b < 85, 'fixture background shows where the pill was');
});

test('--top-margin moves the pill and rejects nonsense', () => {
  const low = renderDemo('margin80.png', 1280, 800, '', ['--top-margin', '80']).png;
  assert.ok(!isDark(low.at(640, 60)), 'nothing at the default position');
  assert.ok(isDark(low.at(PILL_LEFT + 120, 96)) || isDark(low.at(640, 96)), 'pill starts at the new margin');
  assert.equal(exitStatus(['--top-margin', '9999', '--render-demo', path.join(WORK, 'x.png'), '64', '64']), 2);
  assert.equal(exitStatus(['--top-margin', 'abc']), 2);
});

test('animation is time based and MUSE_REDUCED_MOTION freezes it', () => {
  const at = (name, time, env) => renderDemo(name, 1280, 800, '', ['--demo-time', String(time)], env).bytes;
  assert.notEqual(at('t0.png', 0).compare(at('t900.png', 900)), 0, 'halo moves between frames');
  const reduced0 = at('r0.png', 0, { MUSE_REDUCED_MOTION: '1' });
  const reduced900 = at('r900.png', 900, { MUSE_REDUCED_MOTION: '1' });
  assert.equal(reduced0.compare(reduced900), 0, 'reduced motion renders one static frame');
});

test('compiled helper reports wayland on a missing display and does not use the host compositor', async () => {
  compileHelper();
  const env = { ...process.env, WAYLAND_DISPLAY: 'muse-overlay-test-missing', XDG_RUNTIME_DIR: WORK };
  delete env.WAYLAND_SOCKET;
  const child = spawn(BINARY, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stdin.end();
  const code = await new Promise(resolve => child.once('exit', resolve));
  const event = JSON.parse(stdout.trim().split('\n')[0]);
  assert.equal(event.event, 'error');
  assert.equal(event.code, 'wayland');
  assert.equal(typeof event.id, 'undefined');
  assert.equal(code, 1);
});

test('bad argv is rejected without mapping a surface', () => {
  assert.equal(exitStatus(['--render-demo', path.join(WORK, 'nope.png'), '12', '12']), 2);
  assert.equal(exitStatus(['--render-demo', path.join(WORK, 'nope.png'), '64', '64', 'bogus']), 2);
  assert.equal(exitStatus(['--unknown']), 2);
  assert.equal(exitStatus(['--logo']), 2);
});
