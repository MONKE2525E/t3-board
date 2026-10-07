const { clone, fail, assertId, assertTarget, assertRevision } = require('./evidence.cjs');

function assertTransform(t) {
  assertId(t?.id); assertId(t.captureId); assertTarget(t.target); assertRevision(t.revision);
  const size = t.captureSize, bounds = t.logicalBounds, out = t.output, crop = t.crop, decoration = t.decoration, frame = t.frame;
  if (t.target.kind !== 'window' || !t.target.compositorInstance || t.provenance !== 'visible_window' || t.calibrated !== true || t.singleOutput !== true || t.occlusionChecked !== true || t.occluded !== false) throw fail('coordinate_mapping_unsupported', 'backend_unavailable');
  if (!size || ![size.width, size.height].every(n => Number.isInteger(n) && n > 0) || !bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw fail('invalid_transform', 'invalid_request');
  if (!out || !Array.isArray(out.origin) || out.origin.length !== 2 || !out.origin.every(Number.isFinite) || !Number.isFinite(out.scale) || out.scale <= 0 || ![0, 90, 180, 270].includes(out.rotation)) throw fail('output_transform_unsupported', 'backend_unavailable');
  if (!crop || ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width !== size.width || crop.height !== size.height) throw fail('crop_mapping_unsupported', 'backend_unavailable');
  if (!decoration || !['left', 'top', 'right', 'bottom'].every(k => Number.isFinite(decoration[k]) && decoration[k] >= 0) || !Array.isArray(t.scroll) || t.scroll.length !== 2 || !t.scroll.every(Number.isFinite)) throw fail('decoration_scroll_mapping_unknown', 'backend_unavailable');
  if (!frame || frame.kind !== 'window' || !Array.isArray(frame.offset) || frame.offset.length !== 2 || !frame.offset.every(n => n === 0) || !Array.isArray(frame.scale) || frame.scale.length !== 2 || !frame.scale.every(n => n === 1)) throw fail('frame_mapping_unsupported', 'backend_unavailable');
  const full = [(bounds.width + decoration.left + decoration.right) * out.scale, (bounds.height + decoration.top + decoration.bottom) * out.scale];
  const rotated = [90, 270].includes(out.rotation) ? [full[1], full[0]] : full;
  if (crop.x + crop.width > rotated[0] + 0.01 || crop.y + crop.height > rotated[1] + 0.01) throw fail('capture_calibration_mismatch', 'backend_unavailable');
  return clone(t);
}

function transformPoint(t, coordinate) {
  assertTransform(t);
  const point = coordinate.point;
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) throw fail('invalid_coordinate', 'invalid_request');
  const b = t.logicalBounds, d = t.decoration, o = t.output;
  let x, y;
  if (coordinate.space === 'window_normalized') {
    if (point.some(n => n < 0 || n >= 1)) throw fail('coordinate_out_of_bounds', 'invalid_request');
    x = point[0] * b.width; y = point[1] * b.height;
  } else if (coordinate.space === 'capture_px') {
    if (point[0] < 0 || point[1] < 0 || point[0] >= t.captureSize.width || point[1] >= t.captureSize.height) throw fail('coordinate_out_of_bounds', 'invalid_request');
    const width = (b.width + d.left + d.right) * o.scale;
    const height = (b.height + d.top + d.bottom) * o.scale;
    const px = point[0] + t.crop.x, py = point[1] + t.crop.y;
    const unrotated = o.rotation === 0 ? [px, py] : o.rotation === 90 ? [py, height - px] : o.rotation === 180 ? [width - px, height - py] : [width - py, px];
    x = unrotated[0] / o.scale - d.left; y = unrotated[1] / o.scale - d.top;
    if (x < 0 || y < 0 || x >= b.width || y >= b.height) throw fail('coordinate_outside_content', 'invalid_request');
  } else throw fail('coordinate_space_unsupported', 'backend_unavailable');
  // Scroll is calibration metadata. Screenshot points already describe the visible viewport.
  return [o.origin[0] + b.x + x, o.origin[1] + b.y + y];
}

module.exports = { assertTransform, transformPoint };
