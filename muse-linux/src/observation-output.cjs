'use strict';

const COMPACT_BUDGET = 12 * 1024;
const FULL_BUDGET = 32 * 1024;
const MAX_LIMIT = 1000;
const ID_BYTES = 128;

const DIAGNOSTIC = new Set([
  'path', 'toolkit', 'children', 'nodes', 'tree', 'raw', 'xml', 'ax', 'ax_tree', 'accessibility_tree',
  'accessible_id', 'atspi', 'atspi_path', 'interfaces', 'states', 'source', 'inspector', 'dump', 'debug',
  'parent', 'index', 'child_count', 'help',
  'ref',
]);
const TOP_DIAGNOSTIC = new Set([
  'path', 'toolkit', 'children', 'nodes', 'tree', 'raw', 'xml', 'ax', 'ax_tree', 'accessibility_tree',
  'dump', 'debug', 'inspector',
]);
const OPERATE_KEYS = [
  'element_number', 'role', 'label', 'value', 'actions', 'actionable', 'editable', 'disabled',
  'showing', 'scrollable', 'bounds', 'coordinate', 'type', 'files',
  'ref_id', 'capabilities', 'destination_url', 'destination_target',
];
const HEADER_KEEP = new Set([
  'accessibility_status', 'accessibility_error', 'state_conflicts',
  'observation_id', 'window_id', 'pid', 'app', 'title', 'url', 'bounds', 'workspace', 'workspace_name',
  'monitor', 'focused', 'visible', 'visibility_reason', 'captured_at', 'text_excerpt',
  'accessibility_available', 'accessibility_error', 'truncated', 'coordinate_system', 'pointer_actions',
  'width', 'height', 'session_id', 'paused', 'requires_user_resume', 'error', 'interrupted', 'retryable',
  'dispatched', 'state', 'reason', 'capabilities', 'controls', 'controls_total', 'returned', 'more',
  'next_offset',
  'run_id', 'target', 'revision', 'route', 'coverage', 'headings', 'host_input', 'coordinates_available', 'coordinate_guidance',
  'unchanged', 'screenshot_id', 'capture_status', 'image_current', 'capture_error', 'capture_guidance', 'previous_screenshot_id', 'surface', 'layer_namespace', 'layer_pid', 'screenshot_bounds', 'redacted_blocked_windows', 'guidance',
]);
const OPERABLE_ROLES = new Set([
  'button', 'link', 'text', 'entry', 'checkbox', 'radio', 'radiobutton', 'combobox', 'slider',
  'spinbutton', 'tab', 'menuitem', 'switch', 'textbox', 'searchbox', 'option', 'listitem', 'toggle',
  'togglebutton', 'cell', 'treeitem', 'pagetab', 'pushbutton', 'hyperlink', 'edit', 'editbox',
  'textarea', 'select', 'input', 'a', 'checkbox', 'menuitemcheckbox', 'menuitemradio', 'progressbar',
  'scrollbar', 'combobox', 'listbox', 'spinbutton', 'slider', 'tab', 'tabpanel',
]);
const CLIP = {
  compact: { label: 120, value: 240, text: 2048, title: 200, url: 400, error: 240, other: 240, fileName: 200 },
  full: { label: 150, value: 1000, text: 8192, title: 200, url: 2048, error: 400, other: 400, fileName: 200 },
};

function utf8CompleteLength(buf) {
  if (!buf.length) return 0;
  let i = buf.length, trail = 0;
  while (i > 0 && (buf[i - 1] & 0xc0) === 0x80) { trail++; i--; }
  if (i === 0) return 0;
  const lead = buf[i - 1];
  if (lead < 0x80) return buf.length;
  const need = lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : lead < 0xf8 ? 3 : -1;
  if (need < 0 || trail > need) return i - 1;
  if (trail < need) return i - 1;
  return buf.length;
}

function clipUtf8(text, maxBytes) {
  if (typeof text !== 'string') return text;
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, utf8CompleteLength(buf.subarray(0, maxBytes))).toString('utf8');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function payloadBytes(obj) {
  const copy = { ...obj };
  delete copy.image_transfer;
  return Buffer.byteLength(JSON.stringify(copy), 'utf8');
}

function parseDetail(value) {
  if (value == null || value === '') return 'compact';
  const text = String(value).trim().toLowerCase();
  if (text === 'compact' || text === 'full') return text;
  throw Error('invalid_detail');
}

function parseOffset(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return 0;
    if (!/^[0-9]+$/.test(text)) throw Error('invalid_offset');
    value = Number(text);
  }
  if (!Number.isSafeInteger(value) || value < 0) throw Error('invalid_offset');
  return value;
}

function parseLimit(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return null;
    if (!/^[1-9][0-9]*$/.test(text)) throw Error('invalid_size');
    value = Number(text);
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) throw Error('invalid_size');
  return value;
}

function validateObservationOptions(args = {}) {
  const options = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  return {
    detail: parseDetail(options.detail),
    control_offset: parseOffset(options.control_offset),
    control_limit: parseLimit(options.control_limit),
  };
}

function roleKey(role) {
  return String(role || '').toLowerCase().replace(/[\s_-]+/g, '');
}

function isRelevant(control) {
  if (!control || typeof control !== 'object') return false;
  if (control.actionable || control.editable || control.scrollable) return true;
  if (Array.isArray(control.coordinate) && control.coordinate.length >= 2) return true;
  if (control.type) return true;
  if (Array.isArray(control.files) && control.files.length) return true;
  if (Array.isArray(control.actions) && control.actions.length) return true;
  return OPERABLE_ROLES.has(roleKey(control.role));
}

function sanitizeControl(control, index, detail) {
  if (!control || typeof control !== 'object' || Array.isArray(control)) {
    return { element_number: index + 1 };
  }
  const out = {};
  for (const [key, value] of Object.entries(control)) {
    if (DIAGNOSTIC.has(key)) continue;
    if (detail === 'compact' && key === 'description') continue;
    out[key] = value;
  }
  const n = Number(control.element_number);
  out.element_number = Number.isInteger(n) && n >= 1 ? n : index + 1;
  return out;
}

function slimCapabilities(obs) {
  const caps = obs.capabilities;
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    delete obs.capabilities;
    return;
  }
  const slim = {};
  if (typeof caps.pointer === 'boolean') slim.pointer = caps.pointer;
  if (typeof caps.accessibility === 'boolean') slim.accessibility = caps.accessibility;
  if (typeof caps.compositor_keys === 'boolean') slim.compositor_keys = caps.compositor_keys;
  if (typeof caps.bulk_text === 'boolean') slim.bulk_text = caps.bulk_text;
  if (typeof caps.layer_surfaces === 'boolean') slim.layer_surfaces=caps.layer_surfaces;
  if (typeof caps.observation_free_shortcuts === 'boolean') slim.observation_free_shortcuts=caps.observation_free_shortcuts;
  if (typeof caps.semantic_actions === 'boolean') slim.semantic_actions = caps.semantic_actions;
  if (typeof caps.screenshot_reuse === 'boolean') slim.screenshot_reuse = caps.screenshot_reuse;
  if (Array.isArray(caps.pointer_actions)) slim.pointer_actions = caps.pointer_actions;
  if (caps.coordinate_system && typeof caps.coordinate_system === 'object') slim.coordinate_system = caps.coordinate_system;
  if (caps.batch && typeof caps.batch === 'object' && typeof caps.batch.max_actions === 'number') {
    slim.batch = { max_actions: caps.batch.max_actions };
  }
  obs.capabilities = slim;
}

function stripTopDiagnostics(obs) {
  for (const key of Object.keys(obs)) {
    if (TOP_DIAGNOSTIC.has(key)) delete obs[key];
  }
}

function clipStrings(value, maxBytes) {
  if (typeof value === 'string') return clipUtf8(value, maxBytes);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => clipStrings(item, maxBytes));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = clipStrings(item, maxBytes);
  return out;
}

function compactScalarId(value, maxBytes = ID_BYTES) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return clipUtf8(value, maxBytes);
  return undefined;
}

function compactBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length < 2 || bounds.length > 8) return undefined;
  const nums = bounds.map(Number);
  if (nums.some(n => !Number.isFinite(n))) return undefined;
  return nums;
}

function compactCoordinateSystem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const key of ['origin', 'min', 'max', 'space', 'units']) {
    if (typeof value[key] === 'string') out[key] = clipUtf8(value[key], 64);
    else if (typeof value[key] === 'number' && Number.isFinite(value[key])) out[key] = value[key];
  }
  return Object.keys(out).length ? out : undefined;
}

function compactPointerActions(actions) {
  if (!Array.isArray(actions)) return undefined;
  return actions.filter(action => typeof action === 'string').map(action => clipUtf8(action, 32)).slice(0, 16);
}

function clipHeader(obs, limits) {
  for (const key of HEADER_KEEP) {
    if (!['controls', 'text_excerpt', 'title', 'url'].includes(key) && typeof obs[key] === 'string') obs[key] = clipUtf8(obs[key], limits.other);
  }
  if (typeof obs.observation_id === 'string') obs.observation_id = clipUtf8(obs.observation_id, ID_BYTES);
  else if (obs.observation_id != null && typeof obs.observation_id !== 'number') delete obs.observation_id;
  if (typeof obs.window_id === 'string') obs.window_id = clipUtf8(obs.window_id, ID_BYTES);
  else if (obs.window_id != null && typeof obs.window_id !== 'number') delete obs.window_id;
  if (typeof obs.title === 'string') obs.title = clipUtf8(obs.title, limits.title);
  if (typeof obs.url === 'string') obs.url = clipUtf8(obs.url, limits.url);
  if (typeof obs.text_excerpt === 'string') obs.text_excerpt = clipUtf8(obs.text_excerpt, limits.text);
  if (typeof obs.accessibility_error === 'string') obs.accessibility_error = clipUtf8(obs.accessibility_error, limits.error);
  if (typeof obs.visibility_reason === 'string') obs.visibility_reason = clipUtf8(obs.visibility_reason, limits.other);
  if (obs.capabilities) obs.capabilities = clipStrings(obs.capabilities, limits.other);
  const bounds = compactBounds(obs.bounds);
  if (bounds) obs.bounds = bounds;
  else delete obs.bounds;
  const system = compactCoordinateSystem(obs.coordinate_system);
  if (system) obs.coordinate_system = system;
  else delete obs.coordinate_system;
  const actions = compactPointerActions(obs.pointer_actions);
  if (actions) obs.pointer_actions = actions;
  else delete obs.pointer_actions;
}

function clipControl(control, limits) {
  const out = { ...control };
  if (typeof out.label === 'string') out.label = clipUtf8(out.label, limits.label);
  if (typeof out.value === 'string') out.value = clipUtf8(out.value, limits.value);
  if (typeof out.role === 'string') out.role = clipUtf8(out.role, limits.other);
  if (typeof out.type === 'string') out.type = clipUtf8(out.type, 40);
  if (Array.isArray(out.actions)) {
    out.actions = out.actions.filter(action => typeof action === 'string').map(action => clipUtf8(action, 40)).slice(0, 8);
  }
  if (Array.isArray(out.files)) {
    out.files = out.files.filter(file => file && typeof file === 'object' && !Array.isArray(file)).slice(0, 8).map(file => {
      return {
        name: typeof file.name === 'string' ? clipUtf8(file.name, limits.fileName) : '',
        type: typeof file.type === 'string' ? clipUtf8(file.type, 80) : '',
        ...(typeof file.size === 'number' && Number.isFinite(file.size) ? {size:file.size} : {}),
      };
    });
  }
  const bounds = compactBounds(out.bounds);
  if (bounds) out.bounds = bounds;
  else delete out.bounds;
  if (Array.isArray(out.coordinate)) {
    const coordinate = compactBounds(out.coordinate);
    if (coordinate) out.coordinate = coordinate;
    else delete out.coordinate;
  }
  return out;
}

function operateOnly(control) {
  const out = {};
  for (const key of OPERATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(control, key)) out[key] = control[key];
  }
  return out;
}

function dropExtraFields(obs) {
  for (const key of Object.keys(obs)) {
    if (!HEADER_KEEP.has(key)) delete obs[key];
  }
}

function assemble(base, controls, meta) {
  return {
    ...base,
    controls,
    controls_total: meta.total,
    returned: controls.length,
    more: meta.more,
    next_offset: meta.more ? meta.next : null,
    truncated: meta.truncated,
  };
}

function guaranteedMinimal(ids, meta, budget) {
  const base = {
    controls: [],
    controls_total: meta.total,
    returned: 0,
    more: false,
    next_offset: null,
    truncated: true,
    error: 'observation_truncated',
  };
  const candidates = [
    ['observation_id', compactScalarId(ids.observation_id)],
    ['window_id', compactScalarId(ids.window_id)],
    ['bounds', compactBounds(ids.bounds)],
    ['coordinate_system', compactCoordinateSystem(ids.coordinate_system)],
    ['pointer_actions', compactPointerActions(ids.pointer_actions)],
  ];
  for (const [key, value] of candidates) {
    if (value === undefined) continue;
    const trial = { ...base, [key]: value };
    if (payloadBytes(trial) <= budget) base[key] = value;
  }
  if (payloadBytes(base) <= budget) {
    if (!base.observation_id && ids.observation_id != null) base.error = 'observation_truncated';
    if (payloadBytes(base) <= budget) return base;
  }
  const error = {
    controls: [],
    returned: 0,
    more: false,
    next_offset: null,
    truncated: true,
    error: 'observation_truncated',
  };
  if (payloadBytes(error) <= budget) return error;
  return { truncated: true, error: 'observation_truncated', controls: [], returned: 0 };
}

function compactObservation(result, args = {}) {
  const { detail, control_offset: offset, control_limit: limit } = validateObservationOptions(args);
  if (result == null || typeof result !== 'object' || Array.isArray(result)) throw Error('observation_required');
  const budget = detail === 'full' ? FULL_BUDGET : COMPACT_BUDGET;
  const limits = CLIP[detail];

  const hasImage = Object.prototype.hasOwnProperty.call(result, 'image_transfer');
  const image = result.image_transfer;
  const rest = { ...result };
  delete rest.image_transfer;
  const working = cloneJson(rest);

  const finish = obj => {
    let out = obj;
    if (Array.isArray(working.controls) && payloadBytes(out) > budget) {
      out = guaranteedMinimal(out, {
        total: out.controls_total || 0,
        more: out.more === true,
        next: out.next_offset,
      }, budget);
    }
    if (hasImage) out.image_transfer = image;
    return out;
  };

  if (!Array.isArray(working.controls)) return finish(working);

  const originalTruncated = working.truncated === true;
  working.controls = working.controls.map((control, index) => sanitizeControl(control, index, detail));
  stripTopDiagnostics(working);
  if (detail === 'compact') slimCapabilities(working);
  else if (working.capabilities) working.capabilities = clipStrings(working.capabilities, limits.other);

  const all = working.controls;
  const fits = obj => payloadBytes(obj) <= budget;

  const sliceList = (list, start) => {
    const stop = limit == null ? list.length : Math.min(list.length, start + limit);
    const items = start >= list.length ? [] : list.slice(start, stop);
    return assemble(working, items, {
      total: list.length,
      more: start + items.length < list.length,
      next: start + items.length,
      truncated: originalTruncated,
    });
  };

  const entire = assemble(working, all, {
    total: all.length,
    more: false,
    next: all.length,
    truncated: originalTruncated,
  });
  if (fits(entire) && offset === 0 && limit == null) return finish(entire);
  if (fits(entire)) {
    const paged = sliceList(all, offset);
    if (fits(paged)) return finish(paged);
  }

  let source = all;
  if (detail === 'compact') {
    const relevant = all.filter(isRelevant);
    if (relevant.length) source = relevant;
  }

  const pageFrom = (list, header, clipped, operate) => {
    const stop = limit == null ? list.length : Math.min(list.length, offset + limit);
    const fitted = [];
    let index = offset;
    let truncated = originalTruncated;
    while (index < stop) {
      let item = list[index];
      if (clipped) item = clipControl(item, limits);
      if (operate) item = operateOnly(item);
      const next = index + 1;
      const trial = assemble(header, [...fitted, item], {
        total: list.length,
        more: next < list.length,
        next,
        truncated,
      });
      if (fits(trial)) {
        fitted.push(item);
        index = next;
        continue;
      }
      if (!clipped || !operate) break;
      truncated = true;
      break;
    }
    if (index < stop && index < list.length) truncated = true;
    return assemble(header, fitted, {
      total: list.length,
      more: index < list.length,
      next: index,
      truncated,
    });
  };

  const tryModes = header => {
    for (const [clipped, operate] of [[false, false], [true, false], [true, true]]) {
      const candidate = pageFrom(source, header, clipped, operate);
      if (fits(candidate) && (candidate.returned > 0 || offset >= source.length)) return candidate;
    }
    return null;
  };

  let found = tryModes(working);
  if (found) return finish(found);

  const header = { ...working };
  clipHeader(header, limits);
  found = tryModes(header);
  if (found) return finish(found);

  dropExtraFields(header);
  found = tryModes(header);
  if (found) return finish(found);

  for (const key of ['text_excerpt', 'capabilities', 'accessibility_error', 'visibility_reason', 'url', 'title']) {
    if (header[key] == null) continue;
    delete header[key];
    found = tryModes(header);
    if (found) return finish(found);
  }

  const last = pageFrom(source, header, true, true);
  if (fits(last) && (last.returned > 0 || offset >= source.length)) return finish(last);
  return finish(guaranteedMinimal(header, { total: source.length }, budget));
}

module.exports = { compactObservation, validateObservationOptions, COMPACT_BUDGET, FULL_BUDGET };
