const { createHash, randomUUID } = require('node:crypto');

function parseForceImage(value) {
  if (value == null || value === '') return false;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw Error('invalid_force_image');
}

function pixelHash(pixels, width, height) {
  const dims = Buffer.alloc(8);
  dims.writeUInt32LE(width, 0);
  dims.writeUInt32LE(height, 4);
  return createHash('sha256').update(dims).update(pixels).digest('hex');
}

class ScreenshotCache {
  constructor() {
    this.reset();
  }

  reset() {
    this.baseline = null;
  }

  compare({ key, pixels, width, height, force = false } = {}) {
    const forced = parseForceImage(force);
    if (typeof key !== 'string' || !key) throw Error('invalid_screenshot_key');
    if (!Buffer.isBuffer(pixels)) throw Error('invalid_screenshot_pixels');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw Error('invalid_screenshot_size');
    if (pixels.length !== width * height * 4) throw Error('invalid_screenshot_pixels');
    const hash = pixelHash(pixels, width, height);
    if (!forced && this.baseline && this.baseline.key === key && this.baseline.hash === hash) {
      return { unchanged: true, screenshot_id: this.baseline.screenshot_id };
    }
    const screenshot_id = randomUUID();
    this.baseline = { key, hash, screenshot_id };
    return { unchanged: false, screenshot_id };
  }
}

module.exports = { ScreenshotCache, parseForceImage };
