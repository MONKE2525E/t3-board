'use strict';

/**
 * Shared key contract for Muse Local Browser (Electron sendInputEvent) and
 * native Linux control (Hyprland send_shortcut and muse-keyboard).
 *
 * normalizeKey('Ctrl+Shift+P')
 * normalizeKey({ key: 'Enter', modifiers: 'control,shift' })
 *
 * Result:
 *   key        canonical name: Enter, Tab, Escape, Space, Backspace, Delete,
 *              Left, Right, Up, Down, Home, End, PageUp, PageDown, Insert,
 *              F1-F24, Control, Shift, Alt, Super, or a single lowercase
 *              letter / digit / punctuation
 *   mods       extra held modifiers ['control','shift','alt','super'] in that
 *              order. A standalone Super tap is key Super with mods []
 *   electron   { keyCode, modifiers }  super -> meta; Super key is Meta
 *   hyprland   { key, mods }           Return/BackSpace/Prior/Next/space,
 *                                      Super_L/Control_L/Shift_L/Alt_L.
 *                                      A modifier used as the key includes
 *                                      itself (standalone Super is SUPER +
 *                                      Super_L, matching Omarchy bindr)
 *   linux      { name, code }          evdev KEY_* and numeric code.
 *                                      Super/Meta/Win is KEY_LEFTMETA 125
 *   combo      'Ctrl+Shift+P', 'Super', 'Ctrl+Super'
 *
 * Case-insensitive aliases: Enter/Return, Tab, ctrl/control, Meta/Super/Win,
 * arrows, home/end/pageup/down, F1-F24. Standalone Ctrl/Shift/Alt/Super taps
 * are left-side modifier keys, not invalid_key.
 */

const MOD_ORDER = ['control', 'shift', 'alt', 'super'];

const MOD_ALIASES = {
  ctrl: 'control',
  control: 'control',
  ctl: 'control',
  controlleft: 'control',
  controlright: 'control',
  control_l: 'control',
  control_r: 'control',
  shift: 'shift',
  shiftleft: 'shift',
  shiftright: 'shift',
  shift_l: 'shift',
  shift_r: 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  altleft: 'alt',
  altright: 'alt',
  alt_l: 'alt',
  alt_r: 'alt',
  meta: 'super',
  super: 'super',
  win: 'super',
  windows: 'super',
  logo: 'super',
  cmd: 'super',
  command: 'super',
  metaleft: 'super',
  metaright: 'super',
  super_l: 'super',
  super_r: 'super',
  meta_l: 'super',
  meta_r: 'super',
};

const HYPRLAND_MOD = { control: 'CTRL', shift: 'SHIFT', alt: 'ALT', super: 'SUPER' };
const COMBO_MOD = { control: 'Ctrl', shift: 'Shift', alt: 'Alt', super: 'Super' };
const KEY_AS_MOD = { Control: 'control', Shift: 'shift', Alt: 'alt', Super: 'super' };

const KEYS = new Map();

function addKey(aliases, spec) {
  const entry = Object.freeze({
    key: spec.key,
    electron: spec.electron,
    hyprland: spec.hyprland,
    linux: Object.freeze({ name: spec.linux, code: spec.code }),
  });
  for (const alias of aliases) KEYS.set(String(alias).toLowerCase(), entry);
  return entry;
}

addKey(['enter', 'return', 'ent'], { key: 'Enter', electron: 'Enter', hyprland: 'Return', linux: 'KEY_ENTER', code: 28 });
addKey(['tab'], { key: 'Tab', electron: 'Tab', hyprland: 'Tab', linux: 'KEY_TAB', code: 15 });
addKey(['escape', 'esc'], { key: 'Escape', electron: 'Escape', hyprland: 'Escape', linux: 'KEY_ESC', code: 1 });
addKey(['space', 'spacebar', ' '], { key: 'Space', electron: 'Space', hyprland: 'space', linux: 'KEY_SPACE', code: 57 });
addKey(['backspace', 'back'], { key: 'Backspace', electron: 'Backspace', hyprland: 'BackSpace', linux: 'KEY_BACKSPACE', code: 14 });
addKey(['delete', 'del'], { key: 'Delete', electron: 'Delete', hyprland: 'Delete', linux: 'KEY_DELETE', code: 111 });
addKey(['left', 'arrowleft', 'arrow_left', 'arrow-left'], { key: 'Left', electron: 'Left', hyprland: 'Left', linux: 'KEY_LEFT', code: 105 });
addKey(['right', 'arrowright', 'arrow_right', 'arrow-right'], { key: 'Right', electron: 'Right', hyprland: 'Right', linux: 'KEY_RIGHT', code: 106 });
addKey(['up', 'arrowup', 'arrow_up', 'arrow-up'], { key: 'Up', electron: 'Up', hyprland: 'Up', linux: 'KEY_UP', code: 103 });
addKey(['down', 'arrowdown', 'arrow_down', 'arrow-down'], { key: 'Down', electron: 'Down', hyprland: 'Down', linux: 'KEY_DOWN', code: 108 });
addKey(['home'], { key: 'Home', electron: 'Home', hyprland: 'Home', linux: 'KEY_HOME', code: 102 });
addKey(['end'], { key: 'End', electron: 'End', hyprland: 'End', linux: 'KEY_END', code: 107 });
addKey(['pageup', 'page_up', 'page-up', 'pgup', 'prior'], { key: 'PageUp', electron: 'PageUp', hyprland: 'Prior', linux: 'KEY_PAGEUP', code: 104 });
addKey(['pagedown', 'page_down', 'page-down', 'pgdn', 'pgdown', 'next'], { key: 'PageDown', electron: 'PageDown', hyprland: 'Next', linux: 'KEY_PAGEDOWN', code: 109 });
addKey(['insert', 'ins'], { key: 'Insert', electron: 'Insert', hyprland: 'Insert', linux: 'KEY_INSERT', code: 110 });
addKey(['control', 'ctrl', 'ctl', 'controlleft', 'controlright', 'control_l', 'control_r'], {
  key: 'Control', electron: 'Control', hyprland: 'Control_L', linux: 'KEY_LEFTCTRL', code: 29,
});
addKey(['shift', 'shiftleft', 'shiftright', 'shift_l', 'shift_r'], {
  key: 'Shift', electron: 'Shift', hyprland: 'Shift_L', linux: 'KEY_LEFTSHIFT', code: 42,
});
addKey(['alt', 'option', 'opt', 'altleft', 'altright', 'alt_l', 'alt_r'], {
  key: 'Alt', electron: 'Alt', hyprland: 'Alt_L', linux: 'KEY_LEFTALT', code: 56,
});
addKey(['super', 'meta', 'win', 'windows', 'logo', 'cmd', 'command', 'metaleft', 'metaright', 'super_l', 'super_r', 'meta_l', 'meta_r'], {
  key: 'Super', electron: 'Meta', hyprland: 'Super_L', linux: 'KEY_LEFTMETA', code: 125,
});

for (let n = 1; n <= 24; n++) {
  let code;
  if (n <= 10) code = 58 + n;
  else if (n === 11) code = 87;
  else if (n === 12) code = 88;
  else code = 183 + (n - 13);
  const name = 'F' + n;
  addKey([name, name.toLowerCase()], { key: name, electron: name, hyprland: name, linux: 'KEY_' + name, code });
}

const PUNCT = [
  ['-', 'minus', 'KEY_MINUS', 12],
  ['=', 'equal', 'KEY_EQUAL', 13],
  ['[', 'bracketleft', 'KEY_LEFTBRACE', 26],
  [']', 'bracketright', 'KEY_RIGHTBRACE', 27],
  [';', 'semicolon', 'KEY_SEMICOLON', 39],
  ["'", 'apostrophe', 'KEY_APOSTROPHE', 40],
  ['`', 'grave', 'KEY_GRAVE', 41],
  ['\\', 'backslash', 'KEY_BACKSLASH', 43],
  [',', 'comma', 'KEY_COMMA', 51],
  ['.', 'period', 'KEY_DOT', 52],
  ['/', 'slash', 'KEY_SLASH', 53],
];
for (const [ch, name, linux, code] of PUNCT) {
  addKey([ch, name], { key: ch, electron: ch, hyprland: ch, linux, code });
}

function fCode(n) {
  if (n <= 10) return 58 + n;
  if (n === 11) return 87;
  if (n === 12) return 88;
  return 183 + (n - 13);
}

const LETTER_CODES = {
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38,
  z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50,
};

function tokenKey(token) {
  const raw = String(token).trim();
  if (!raw) throw Error('invalid_key');
  const lower = raw.toLowerCase();
  const named = KEYS.get(lower);
  if (named) return named;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) {
    const n = Number(raw.slice(1));
    const name = 'F' + n;
    return { key: name, electron: name, hyprland: name, linux: { name: 'KEY_' + name, code: fCode(n) } };
  }
  if (raw.length === 1) {
    const ch = raw;
    const lowerCh = ch.toLowerCase();
    if (lowerCh >= 'a' && lowerCh <= 'z') {
      return { key: lowerCh, electron: lowerCh, hyprland: lowerCh, linux: { name: 'KEY_' + lowerCh.toUpperCase(), code: LETTER_CODES[lowerCh] } };
    }
    if (ch >= '0' && ch <= '9') {
      const code = ch === '0' ? 11 : 1 + Number(ch);
      return { key: ch, electron: ch, hyprland: ch, linux: { name: 'KEY_' + ch, code } };
    }
    const punct = KEYS.get(ch);
    if (punct) return punct;
  }
  throw Error('invalid_key');
}

function uniqueMods(list) {
  const seen = new Set();
  for (const item of list) {
    const alias = MOD_ALIASES[String(item || '').trim().toLowerCase()];
    if (!alias) throw Error('invalid_key');
    seen.add(alias);
  }
  return MOD_ORDER.filter(name => seen.has(name));
}

function parseModifiers(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return uniqueMods(value);
  if (typeof value === 'string') {
    const parts = value.split(/[+,]/).map(part => part.trim()).filter(Boolean);
    return uniqueMods(parts);
  }
  throw Error('invalid_key');
}

function comboOf(key, mods) {
  const parts = mods.map(name => COMBO_MOD[name]);
  const label = key === 'Control' ? 'Ctrl' : key.length === 1 ? key.toUpperCase() : key;
  parts.push(label);
  return parts.join('+');
}

function pack(entry, mods) {
  const electronMods = mods.map(name => name === 'super' ? 'meta' : name);
  const hyprlandSet = new Set(mods);
  const selfMod = KEY_AS_MOD[entry.key];
  if (selfMod) hyprlandSet.add(selfMod);
  const hyprlandMods = MOD_ORDER.filter(name => hyprlandSet.has(name)).map(name => HYPRLAND_MOD[name]).join('+');
  return {
    key: entry.key,
    mods,
    electron: { keyCode: entry.electron, modifiers: electronMods },
    hyprland: { key: entry.hyprland, mods: hyprlandMods },
    linux: entry.linux,
    combo: comboOf(entry.key, mods),
  };
}

function parseCombo(text) {
  const trimmed = String(text).trim();
  if (!trimmed || trimmed.includes('\0')) throw Error('invalid_key');
  const parts = trimmed.split('+').map(part => part.trim());
  if (parts.some(part => !part)) throw Error('invalid_key');
  if (parts.length === 1) return pack(tokenKey(parts[0]), []);
  const keyPart = parts[parts.length - 1];
  const modParts = parts.slice(0, -1);
  return pack(tokenKey(keyPart), uniqueMods(modParts));
}

function normalizeModifiers(value) {
  return parseModifiers(value);
}

function normalizeKey(input) {
  if (input == null) throw Error('invalid_key');
  if (typeof input === 'object' && !Array.isArray(input)) {
    const keyPart = input.key ?? input.name;
    if (keyPart == null || keyPart === '') throw Error('invalid_key');
    if (String(keyPart).includes('+') && input.mods == null && input.modifiers == null) return parseCombo(keyPart);
    return pack(tokenKey(keyPart), parseModifiers(input.mods ?? input.modifiers));
  }
  if (typeof input === 'string') return parseCombo(input);
  throw Error('invalid_key');
}

module.exports = {
  normalizeKey,
  normalizeModifiers,
  MOD_ORDER,
  KEYS,
};
