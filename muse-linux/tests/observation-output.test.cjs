'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compactObservation, validateObservationOptions, COMPACT_BUDGET, FULL_BUDGET } = require('../src/observation-output.cjs');

function payloadBytes(obj) {
  const copy = { ...obj };
  delete copy.image_transfer;
  return Buffer.byteLength(JSON.stringify(copy), 'utf8');
}

function browserObservation(extra = {}) {
  return {
    title: 'Example',
    url: 'https://example.com/',
    width: 1280,
    height: 800,
    text_excerpt: 'Hello from the page',
    window_id: 7,
    app: 'Muse Local Browser',
    observation_id: 'obs-browser',
    captured_at: '2026-04-02T00:00:00.000Z',
    controls: [
      {
        element_number: 1, role: 'a', type: '', label: 'Docs', value: '', files: [], disabled: false,
        coordinate: [120, 40],
      },
      {
        element_number: 2, role: 'input', type: 'text', label: 'Search', value: 'café 日本語', files: [], disabled: false,
        coordinate: [500, 80],
      },
      {
        element_number: 3, role: 'input', type: 'file', label: 'Upload', value: '', disabled: false, coordinate: [500, 120],
        files: [{ name: 'note.txt', size: 12, type: 'text/plain' }],
      },
    ],
    ...extra,
  };
}

function nativeObservation(controls, extra = {}) {
  return {
    window_id: '0xabc',
    pid: 42,
    app: 'notes',
    title: 'Muse Native Test',
    bounds: [10, 20, 800, 600],
    workspace: 3,
    workspace_name: '3',
    monitor: 'DP-1',
    focused: true,
    visible: true,
    visibility_reason: null,
    observation_id: 'obs-native',
    text_excerpt: 'Test note hello\nSave note',
    accessibility_available: true,
    truncated: false,
    captured_at: '2026-04-02T00:00:00.000Z',
    coordinate_system: { origin: 'top_left', min: 0, max: 1000, space: 'selected_window', units: 'normalized' },
    pointer_actions: ['move', 'click', 'double_click', 'drag', 'scroll'],
    capabilities: {
      accessibility: true,
      compositor_keys: true,
      bulk_text: true,
      native_keyboard_text: 'Basic Multilingual Plane Unicode. Emoji and other supplementary characters require an accessible editable control or Muse Local Browser; native fallback refuses them before input.',
      key_names: 'Case-insensitive: Enter/Return, Tab, arrows, Home/End, PageUp/PageDown, F1-F24; Ctrl+Shift+P or key with modifiers ctrl,shift. Meta/Super/Win are equivalent.',
      pause: { physical_takeover: true, resume: 'User only; obtain a fresh observation after Resume', scope: 'Desktop input and new local mutations. Already running terminal/command jobs and cloud reasoning are not suspended.' },
      pointer: true,
      pointer_actions: ['move', 'click', 'double_click', 'drag', 'scroll'],
      buttons: ['left', 'right', 'middle'],
      coordinate_system: { origin: 'top_left', min: 0, max: 1000, space: 'selected_window', units: 'normalized' },
      batch: { max_actions: 16, final_observation: true },
    },
    controls,
    ...extra,
  };
}

function nativeControls() {
  return [
    { path: '', role: 'frame', label: 'Muse Native Test', value: '', editable: false, disabled: false, showing: true, actionable: false, scrollable: false, toolkit: 'gtk' },
    { path: '0:1', role: 'text', label: 'Test note', value: 'hello', editable: true, disabled: false, showing: true, actionable: true, scrollable: false, bounds: [32, 67, 960, 34], actions: ['activate'] },
    { path: '0:2', role: 'button', label: 'Save note', value: '', editable: false, disabled: false, showing: true, actionable: true, scrollable: false, bounds: [32, 117, 960, 34] },
  ];
}

test('small browser observations keep values, coordinates, files, and pass image_transfer through', () => {
  const image = { mime_type: 'image/png', data_base64: 'iVBORw0KGgo=', filename: 'linux-window-obs.png' };
  const input = browserObservation({ image_transfer: image });
  const snapshot = JSON.parse(JSON.stringify({ ...input, image_transfer: { ...image } }));
  const out = compactObservation(input);
  assert.equal(out.observation_id, 'obs-browser');
  assert.equal(out.title, 'Example');
  assert.equal(out.url, 'https://example.com/');
  assert.equal(out.text_excerpt, 'Hello from the page');
  assert.equal(out.width, 1280);
  assert.deepEqual(out.controls[1].value, 'café 日本語');
  assert.deepEqual(out.controls.map(c => c.element_number), [1, 2, 3]);
  assert.deepEqual(out.controls[0].coordinate, [120, 40]);
  assert.deepEqual(out.controls[2].files, [{ name: 'note.txt', size: 12, type: 'text/plain' }]);
  assert.equal(out.controls[2].type, 'file');
  assert.equal(out.image_transfer, image);
  assert.equal(out.controls_total, 3);
  assert.equal(out.returned, 3);
  assert.equal(out.more, false);
  assert.equal(out.next_offset, null);
  assert.equal(out.truncated, false);
  assert.ok(payloadBytes(out) <= COMPACT_BUDGET);
  input.controls[1].value = 'mutated';
  input.controls[0].coordinate[0] = 1;
  input.image_transfer.data_base64 = 'changed';
  assert.equal(out.controls[1].value, snapshot.controls[1].value);
  assert.deepEqual(out.controls[0].coordinate, snapshot.controls[0].coordinate);
  out.controls[2].label = 'nope';
  out.controls[0].coordinate[1] = 9;
  assert.equal(input.controls[2].label, 'Upload');
  assert.equal(snapshot.controls[0].coordinate[1], 40);
});

test('native compact strips accessibility paths and toolkit clutter without renumbering', () => {
  const input = nativeObservation(nativeControls());
  const out = compactObservation(input);
  assert.equal(out.observation_id, 'obs-native');
  assert.deepEqual(out.bounds, [10, 20, 800, 600]);
  assert.deepEqual(out.pointer_actions, ['move', 'click', 'double_click', 'drag', 'scroll']);
  assert.equal(out.coordinate_system.max, 1000);
  assert.equal(out.controls.length, 3);
  assert.deepEqual(out.controls.map(c => c.element_number), [1, 2, 3]);
  assert.equal(out.controls[1].label, 'Test note');
  assert.equal(out.controls[1].value, 'hello');
  assert.equal(out.controls[1].role, 'text');
  assert.deepEqual(out.controls[1].bounds, [32, 67, 960, 34]);
  assert.deepEqual(out.controls[1].actions, ['activate']);
  assert.equal(out.controls[1].path, undefined);
  assert.equal(out.controls[0].toolkit, undefined);
  assert.equal('path' in out.controls[1], false);
  assert.equal(out.capabilities.native_keyboard_text, undefined);
  assert.equal(out.capabilities.key_names, undefined);
  assert.equal(out.capabilities.pointer, true);
  assert.equal(input.controls[1].path, '0:1');
  assert.equal(input.controls[0].toolkit, 'gtk');
  assert.match(input.capabilities.native_keyboard_text, /Basic Multilingual Plane/);
});

test('default compact outcome leaves small payloads under budget and full is a higher hard cap', () => {
  const small = compactObservation(browserObservation());
  assert.ok(payloadBytes(small) < 2048);
  assert.equal(small.returned, 3);
  const full = compactObservation(browserObservation(), { detail: 'full' });
  assert.ok(payloadBytes(full) <= FULL_BUDGET);
  assert.equal(full.controls[1].value, 'café 日本語');
});

test('hundreds of native controls stay bounded, keep stable ids, and paginate with string params', () => {
  const controls = [];
  for (let i = 0; i < 400; i++) {
    const n = i + 1;
    if (i % 5 === 0) {
      controls.push({
        path: `0:${i}`, role: 'frame', label: `Pane ${n}`, value: '', editable: false, disabled: false,
        showing: true, actionable: false, scrollable: false, toolkit: 'atspi',
      });
    } else {
      controls.push({
        path: `0:${i}`, role: i % 5 === 1 ? 'text' : 'button', label: `Control ${n}`, value: i % 5 === 1 ? `value-${n}` : '',
        editable: i % 5 === 1, disabled: false, showing: true, actionable: true, scrollable: false,
        bounds: [i, i, 80, 20], actions: ['Press'],
      });
    }
  }
  const input = nativeObservation(controls, { text_excerpt: 'x'.repeat(16000), truncated: true });
  const out = compactObservation(input, { control_offset: '0', control_limit: '40' });
  assert.ok(payloadBytes(out) <= COMPACT_BUDGET);
  assert.equal(out.image_transfer, undefined);
  assert.equal(out.controls.length, 40);
  assert.equal(out.returned, 40);
  assert.equal(out.more, true);
  assert.equal(out.next_offset, 40);
  assert.equal(out.truncated, true);
  assert.ok(out.controls_total >= 40);
  assert.ok(out.controls.every(c => c.role === 'text' || c.role === 'button'));
  assert.ok(out.controls.every(c => Number.isInteger(c.element_number) && c.element_number >= 1));
  assert.deepEqual(out.controls.map(c => c.element_number), [...new Set(out.controls.map(c => c.element_number))]);
  assert.notEqual(out.controls[0].element_number, 1);
  assert.equal(out.controls[0].path, undefined);
  const next = compactObservation(input, { control_offset: String(out.next_offset), control_limit: '40' });
  assert.notEqual(next.controls[0].element_number, out.controls[0].element_number);
  assert.ok(next.controls[0].element_number > out.controls.at(-1).element_number);
  assert.ok(payloadBytes(next) <= COMPACT_BUDGET);
  const unbounded = compactObservation(input);
  assert.ok(payloadBytes(unbounded) <= COMPACT_BUDGET);
  assert.ok(unbounded.returned >= 1);
  assert.ok(unbounded.more);
  assert.ok(unbounded.controls.every(c => c.element_number !== undefined));
  const originalIds = new Set(input.controls.map((c, i) => c.element_number || i + 1));
  assert.ok(unbounded.controls.every(c => originalIds.has(c.element_number)));
});

test('budget clipping is utf8-safe for large unicode values', () => {
  const family = '👨‍👩‍👧‍👦';
  const value = `${family.repeat(2000)}🎯中文${' café'.repeat(80)}`;
  const huge = {
    element_number: 7, role: 'text', label: family.repeat(80), value, editable: true, disabled: false,
    showing: true, actionable: true, bounds: [1, 2, 3, 4],
  };
  const small = {
    element_number: 8, role: 'button', label: 'Save note', value: '', editable: false, disabled: false,
    showing: true, actionable: true, bounds: [8, 9, 10, 11],
  };
  const input = nativeObservation([huge, small], { text_excerpt: 'note', title: '🎯'.repeat(400) });
  assert.ok(Buffer.byteLength(JSON.stringify({ controls: [{ value }] }), 'utf8') > COMPACT_BUDGET);
  const out = compactObservation(input, { control_limit: '1' });
  assert.ok(payloadBytes(out) <= COMPACT_BUDGET);
  assert.ok(out.controls.length >= 1);
  assert.equal(out.controls[0].element_number, 7);
  assert.equal(out.controls[0].role, 'text');
  const clipped = out.controls[0].value || '';
  assert.ok(Buffer.byteLength(clipped, 'utf8') < Buffer.byteLength(value, 'utf8'));
  assert.ok(Buffer.byteLength(clipped, 'utf8') <= 240);
  assert.equal(Buffer.from(clipped, 'utf8').toString('utf8'), clipped);
  assert.doesNotMatch(clipped, /\uFFFD/);
  assert.equal(clipped.includes('\uD83D') && clipped.endsWith('\uD83D'), false);
  if (out.title) assert.equal(Buffer.from(out.title, 'utf8').toString('utf8'), out.title);
  assert.equal(out.more, true);
  assert.equal(out.next_offset, 1);
  const next = compactObservation(input, { control_offset: String(out.next_offset), control_limit: '1' });
  assert.ok(payloadBytes(next) <= COMPACT_BUDGET);
  assert.equal(next.controls[0].element_number, 8);
  assert.equal(next.controls[0].label, 'Save note');
  assert.notEqual(next.next_offset, out.next_offset);
});

test('validateObservationOptions parses string params before any observation mutation', () => {
  assert.deepEqual(validateObservationOptions(), { detail: 'compact', control_offset: 0, control_limit: null });
  assert.deepEqual(validateObservationOptions({ detail: 'FULL', control_offset: '12', control_limit: '40' }), {
    detail: 'full', control_offset: 12, control_limit: 40,
  });
  const input = browserObservation();
  const before = JSON.stringify(input);
  for (const control_offset of ['-1', '1.5', 'foo', 1.2, -3]) {
    assert.throws(() => validateObservationOptions({ control_offset }), /invalid_offset/);
    assert.throws(() => compactObservation(input, { control_offset }), /invalid_offset/);
  }
  for (const control_limit of ['0', '-1', '1.5', 'foo', 0, 1001]) {
    assert.throws(() => validateObservationOptions({ control_limit }), /invalid_size/);
    assert.throws(() => compactObservation(input, { control_limit }), /invalid_size/);
  }
  assert.throws(() => validateObservationOptions({ detail: 'debug' }), /invalid_detail/);
  assert.throws(() => compactObservation(null, { control_offset: '-1' }), /invalid_offset/);
  assert.throws(() => compactObservation(null), /observation_required/);
  assert.equal(JSON.stringify(input), before);
  const empty = compactObservation(input, { control_offset: '50', control_limit: '10' });
  assert.deepEqual(empty.controls, []);
  assert.equal(empty.returned, 0);
  assert.equal(empty.more, false);
  assert.equal(empty.next_offset, null);
  assert.equal(empty.controls_total, 3);
});

test('huge external fields and screenshots cannot blow the JSON budget', () => {
  const png = 'A'.repeat(80_000);
  const image = { mime_type: 'image/png', data_base64: png, filename: 'linux-native-obs.png' };
  const input = nativeObservation(nativeControls(), {
    dump: 'Z'.repeat(60_000),
    accessibility_tree: { nodes: ['Q'.repeat(20_000)] },
    notes: 'N'.repeat(40_000),
    image_transfer: image,
  });
  const out = compactObservation(input);
  assert.ok(payloadBytes(out) <= COMPACT_BUDGET);
  assert.equal(out.image_transfer, image);
  assert.equal(out.image_transfer.data_base64.length, 80_000);
  assert.equal(out.dump, undefined);
  assert.equal(out.accessibility_tree, undefined);
  const full = compactObservation(input, { detail: 'full' });
  assert.ok(payloadBytes(full) <= FULL_BUDGET);
  assert.equal(full.image_transfer, image);
  assert.equal(full.image_transfer.data_base64, png);
});

test('huge text_excerpt does not drop the only actionable control', () => {
  const input = {
    observation_id: 'id',
    text_excerpt: 'x'.repeat(12000),
    controls: [{ element_number: 1, role: 'button', label: 'z'.repeat(120), coordinate: [1, 1] }],
  };
  const out = compactObservation(input);
  assert.ok(payloadBytes(out) <= COMPACT_BUDGET);
  assert.ok(out.controls.length >= 1);
  assert.equal(out.returned, 1);
  assert.equal(out.controls[0].element_number, 1);
  assert.equal(out.controls[0].role, 'button');
  assert.equal(out.controls[0].label, 'z'.repeat(120));
  assert.deepEqual(out.controls[0].coordinate, [1, 1]);
  assert.ok(!out.text_excerpt || out.text_excerpt.length < 12000);
  assert.equal(input.controls[0].label.length, 120);
  assert.equal(input.text_excerpt.length, 12000);
});

test('full detail keeps operate fields and still honors the safety budget', () => {
  const controls = [];
  for (let i = 0; i < 300; i++) {
    controls.push({
      path: `p${i}`, role: 'button', label: `B${i}`, value: 'v'.repeat(800), description: 'd'.repeat(400),
      editable: false, disabled: false, showing: true, actionable: true, bounds: [i, 0, 10, 10],
      element_number: i + 1,
    });
  }
  const input = nativeObservation(controls, { text_excerpt: 't'.repeat(12000) });
  const out = compactObservation(input, { detail: 'full', control_limit: '80' });
  assert.ok(payloadBytes(out) <= FULL_BUDGET);
  assert.equal(out.controls[0].element_number, 1);
  assert.equal(out.controls[0].role, 'button');
  assert.ok(out.controls[0].bounds);
  assert.equal(out.controls[0].path, undefined);
  assert.ok(out.more);
  assert.equal(typeof out.next_offset, 'number');
});

test('malicious huge identity fields still stay under the promised budget', () => {
  const input = nativeObservation(nativeControls(), {
    observation_id: 'id-'.repeat(20_000),
    window_id: '0x'.repeat(20_000),
    bounds: Array.from({ length: 50_000 }, (_, i) => i),
    coordinate_system: { origin: 'x'.repeat(40_000), min: 0, max: 1000, space: 'y'.repeat(40_000), extra: 'z'.repeat(40_000) },
  });
  const out = compactObservation(input);
  assert.ok(payloadBytes(out) <= COMPACT_BUDGET);
  if (out.observation_id) {
    assert.ok(Buffer.byteLength(String(out.observation_id), 'utf8') <= 128);
    assert.equal(Buffer.from(String(out.observation_id), 'utf8').toString('utf8'), out.observation_id);
  }
  if (out.bounds) assert.ok(out.bounds.length <= 8);
  assert.equal(input.observation_id.startsWith('id-'), true);
  assert.equal(input.bounds.length, 50_000);
});

test('control and batch shaped observations compact independently of sibling fields', () => {
  const observation = nativeObservation(nativeControls());
  const batch = { dispatched: true, completed: 2, observation, retryable: false };
  const passthrough = compactObservation(batch);
  assert.equal(passthrough.observation.controls[1].path, '0:1');
  const nested = compactObservation(batch.observation);
  assert.equal(nested.controls[1].path, undefined);
  assert.equal(nested.observation_id, 'obs-native');
  assert.equal(batch.observation.controls[1].path, '0:1');
});

test('crowded headers cannot skip a larger first control in favor of a smaller second one',()=>{
  const out=compactObservation({observation_id:'id',text_excerpt:'x'.repeat(12000),controls:[{element_number:1,role:'button',label:'z'.repeat(120)},{element_number:2,role:'button',label:'ok'}]});
  assert.deepEqual(out.controls.map(c=>c.element_number),[1,2]);assert.ok(payloadBytes(out)<=COMPACT_BUDGET);assert.ok(out.text_excerpt.length<12000);
});
test('oversized known metadata cannot strand observation paging at the same offset',()=>{
  for(const field of ['app','workspace_name','error','monitor','session_id','state','reason']){
    const out=compactObservation({observation_id:'id',[field]:'x'.repeat(20000),controls:[{element_number:1,role:'button',label:'ok'}]});
    assert.equal(out.controls[0]?.element_number,1,field);assert.ok(payloadBytes(out)<=COMPACT_BUDGET);assert.equal(out.more,false);assert.equal(out.next_offset,null);
  }
});
test('oversized file metadata keeps its numbered upload control and useful file fields',()=>{
  const out=compactObservation({observation_id:'id',controls:[{element_number:1,role:'input',type:'file',files:[{name:'note.txt',size:12,type:'text/plain',extra:'x'.repeat(20000)}]},{element_number:2,role:'button',label:'Save'}]});
  assert.deepEqual(out.controls.map(c=>c.element_number),[1,2]);assert.deepEqual(out.controls[0].files,[{name:'note.txt',size:12,type:'text/plain'}]);assert.ok(payloadBytes(out)<=COMPACT_BUDGET);
});
test('last-resort empty observations never advertise a repeating page',()=>{
  const out=compactObservation({observation_id:'id',state:Array(20000).fill('huge'),controls:[{element_number:1,role:'button',label:'ok'}]});
  assert.ok(payloadBytes(out)<=COMPACT_BUDGET);if(out.returned===0){assert.equal(out.more,false);assert.equal(out.next_offset,null);assert.equal(out.error,'observation_truncated');}
});

test('unrepresentable first controls fail explicitly instead of creating an infinite cursor',()=>{
  const out=compactObservation({observation_id:'id',controls:[{element_number:1,role:'button',value:{nested:'x'.repeat(20000)}},{element_number:2,role:'button',label:'ok'}]});
  assert.equal(out.returned,0);assert.equal(out.more,false);assert.equal(out.next_offset,null);assert.equal(out.error,'observation_truncated');assert.ok(payloadBytes(out)<=COMPACT_BUDGET);
});
