const test = require('node:test');
const assert = require('node:assert/strict');
const { ScreenshotCache, parseForceImage } = require('../src/screenshot-cache.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pixels(fill = 1, width = 2, height = 1) {
  return Buffer.alloc(width * height * 4, fill);
}

test('parseForceImage accepts booleans and true|false strings', () => {
  assert.equal(parseForceImage(undefined), false);
  assert.equal(parseForceImage(null), false);
  assert.equal(parseForceImage(''), false);
  assert.equal(parseForceImage(false), false);
  assert.equal(parseForceImage('false'), false);
  assert.equal(parseForceImage(true), true);
  assert.equal(parseForceImage('true'), true);
});

test('parseForceImage rejects anything else before a compare can run', () => {
  for (const value of ['yes', 'TRUE', '1', 1, 0, 'false ', {}, []]) {
    assert.throws(() => parseForceImage(value), /invalid_force_image/);
  }
});

test('first capture and changed pixels send a new screenshot_id', () => {
  const cache = new ScreenshotCache();
  const first = cache.compare({ key: 'a', pixels: pixels(1), width: 2, height: 1 });
  assert.equal(first.unchanged, false);
  assert.match(first.screenshot_id, UUID);
  const changed = cache.compare({ key: 'a', pixels: pixels(9), width: 2, height: 1 });
  assert.equal(changed.unchanged, false);
  assert.match(changed.screenshot_id, UUID);
  assert.notEqual(changed.screenshot_id, first.screenshot_id);
});

test('equal pixels match even when they live in different buffers', () => {
  const cache = new ScreenshotCache();
  const first = cache.compare({ key: 'tab', pixels: pixels(4), width: 2, height: 1 });
  const copy = Buffer.from(pixels(4));
  const second = cache.compare({ key: 'tab', pixels: copy, width: 2, height: 1 });
  assert.equal(second.unchanged, true);
  assert.equal(second.screenshot_id, first.screenshot_id);
  assert.equal(cache.baseline.hash.length, 64);
  assert.equal(Object.keys(cache.baseline).sort().join(','), 'hash,key,screenshot_id');
});

test('hash includes dimensions so a 2x2 and 4x1 buffer are distinct', () => {
  const cache = new ScreenshotCache();
  const data = Buffer.alloc(16, 3);
  const first = cache.compare({ key: 'a', pixels: data, width: 2, height: 2 });
  const second = cache.compare({ key: 'a', pixels: Buffer.from(data), width: 4, height: 1 });
  assert.equal(second.unchanged, false);
  assert.notEqual(second.screenshot_id, first.screenshot_id);
});

test('a different target key is a new image and drops the previous baseline', () => {
  const cache = new ScreenshotCache();
  const data = pixels(2);
  const first = cache.compare({ key: 'session-a', pixels: data, width: 2, height: 1 });
  const other = cache.compare({ key: 'session-b', pixels: Buffer.from(data), width: 2, height: 1 });
  assert.equal(other.unchanged, false);
  assert.notEqual(other.screenshot_id, first.screenshot_id);
  assert.equal(cache.baseline.key, 'session-b');
  const replay = cache.compare({ key: 'session-a', pixels: Buffer.from(data), width: 2, height: 1 });
  assert.equal(replay.unchanged, false);
  assert.notEqual(replay.screenshot_id, first.screenshot_id);
  assert.equal(cache.baseline.key, 'session-a');
});

test('reset forgets the baseline so the next frame is sent again', () => {
  const cache = new ScreenshotCache();
  const data = pixels(5);
  const first = cache.compare({ key: 'a', pixels: data, width: 2, height: 1 });
  cache.reset();
  assert.equal(cache.baseline, null);
  const again = cache.compare({ key: 'a', pixels: Buffer.from(data), width: 2, height: 1 });
  assert.equal(again.unchanged, false);
  assert.notEqual(again.screenshot_id, first.screenshot_id);
});

test('force refreshes the baseline even when pixels match', () => {
  const cache = new ScreenshotCache();
  const data = pixels(8);
  const first = cache.compare({ key: 'a', pixels: data, width: 2, height: 1 });
  const forced = cache.compare({ key: 'a', pixels: Buffer.from(data), width: 2, height: 1, force: true });
  assert.equal(forced.unchanged, false);
  assert.notEqual(forced.screenshot_id, first.screenshot_id);
  const after = cache.compare({ key: 'a', pixels: Buffer.from(data), width: 2, height: 1, force: 'false' });
  assert.equal(after.unchanged, true);
  assert.equal(after.screenshot_id, forced.screenshot_id);
});

test('invalid force flags throw before the baseline mutates', () => {
  const cache = new ScreenshotCache();
  const data = pixels(1);
  const first = cache.compare({ key: 'a', pixels: data, width: 2, height: 1 });
  assert.throws(() => cache.compare({ key: 'a', pixels: pixels(2), width: 2, height: 1, force: 'yes' }), /invalid_force_image/);
  const same = cache.compare({ key: 'a', pixels: Buffer.from(data), width: 2, height: 1 });
  assert.equal(same.unchanged, true);
  assert.equal(same.screenshot_id, first.screenshot_id);
});

test('baseline keeps hash metadata and does not retain pixel bytes', () => {
  const cache = new ScreenshotCache();
  const data = pixels(1);
  cache.compare({ key: 'a', pixels: data, width: 2, height: 1 });
  data.fill(9);
  const same = cache.compare({ key: 'a', pixels: pixels(1), width: 2, height: 1 });
  assert.equal(same.unchanged, true);
  assert.equal('pixels' in cache.baseline, false);
  assert.ok(Buffer.byteLength(JSON.stringify(cache.baseline)) < 256);
});

test('compare rejects bad keys, sizes, and pixel buffers', () => {
  const cache = new ScreenshotCache();
  assert.throws(() => cache.compare({ key: '', pixels: pixels(), width: 2, height: 1 }), /invalid_screenshot_key/);
  assert.throws(() => cache.compare({ key: 1, pixels: pixels(), width: 2, height: 1 }), /invalid_screenshot_key/);
  assert.throws(() => cache.compare({ key: 'a', pixels: [1, 2, 3, 4], width: 1, height: 1 }), /invalid_screenshot_pixels/);
  assert.throws(() => cache.compare({ key: 'a', pixels: pixels(), width: 0, height: 1 }), /invalid_screenshot_size/);
  assert.throws(() => cache.compare({ key: 'a', pixels: pixels(), width: 3, height: 1 }), /invalid_screenshot_pixels/);
});
