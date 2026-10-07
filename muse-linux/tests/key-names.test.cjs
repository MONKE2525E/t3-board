'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeKey, normalizeModifiers } = require('../src/key-names.cjs');

test('Ctrl+Shift+P and case aliases share one native/browser contract', () => {
  const combo = normalizeKey('Ctrl+Shift+P');
  assert.equal(combo.key, 'p');
  assert.deepEqual(combo.mods, ['control', 'shift']);
  assert.deepEqual(combo.electron, { keyCode: 'p', modifiers: ['control', 'shift'] });
  assert.deepEqual(combo.hyprland, { key: 'p', mods: 'CTRL+SHIFT' });
  assert.equal(combo.linux.name, 'KEY_P');
  assert.equal(combo.linux.code, 25);
  assert.equal(combo.combo, 'Ctrl+Shift+P');
  assert.deepEqual(normalizeKey('control+SHIFT+p').mods, ['control', 'shift']);
  assert.equal(normalizeKey({ key: 'P', modifiers: 'ctrl,shift' }).combo, 'Ctrl+Shift+P');
});

test('Enter/Return Tab Meta/Super/Win arrows home/end/page keys and F-keys', () => {
  assert.equal(normalizeKey('return').key, 'Enter');
  assert.equal(normalizeKey('Enter').hyprland.key, 'Return');
  assert.equal(normalizeKey('enter').electron.keyCode, 'Enter');
  assert.equal(normalizeKey('Tab').key, 'Tab');
  assert.deepEqual(normalizeKey('Meta+Tab').mods, ['super']);
  assert.equal(normalizeKey('Win+Tab').electron.modifiers[0], 'meta');
  assert.equal(normalizeKey('Super+Tab').hyprland.mods, 'SUPER');
  assert.equal(normalizeKey('arrowleft').key, 'Left');
  assert.equal(normalizeKey('pageup').hyprland.key, 'Prior');
  assert.equal(normalizeKey('PageDown').hyprland.key, 'Next');
  assert.equal(normalizeKey('home').key, 'Home');
  assert.equal(normalizeKey('end').key, 'End');
  assert.equal(normalizeKey('F1').key, 'F1');
  assert.equal(normalizeKey('f24').key, 'F24');
  assert.equal(normalizeKey('Backspace').hyprland.key, 'BackSpace');
  assert.deepEqual(normalizeModifiers('ctrl,alt'), ['control', 'alt']);
});

test('standalone Super/Meta/Win and Ctrl/Shift/Alt are left modifier keys', () => {
  const superKey = normalizeKey('Super');
  assert.equal(superKey.key, 'Super');
  assert.deepEqual(superKey.mods, []);
  assert.equal(superKey.linux.name, 'KEY_LEFTMETA');
  assert.equal(superKey.linux.code, 125);
  assert.deepEqual(superKey.electron, { keyCode: 'Meta', modifiers: [] });
  assert.deepEqual(superKey.hyprland, { key: 'Super_L', mods: 'SUPER' });
  assert.equal(superKey.combo, 'Super');
  assert.equal(normalizeKey('Meta').linux.code, 125);
  assert.equal(normalizeKey('Win').key, 'Super');
  assert.equal(normalizeKey('windows').combo, 'Super');
  assert.equal(normalizeKey({ key: 'Super_L' }).linux.code, 125);
  assert.deepEqual(normalizeKey('SUPER+Super_L').hyprland, { key: 'Super_L', mods: 'SUPER' });
  assert.deepEqual(normalizeKey('SUPER+Super_L').mods, ['super']);

  const ctrl = normalizeKey('Ctrl');
  assert.equal(ctrl.key, 'Control');
  assert.equal(ctrl.linux.name, 'KEY_LEFTCTRL');
  assert.equal(ctrl.linux.code, 29);
  assert.equal(ctrl.combo, 'Ctrl');
  assert.deepEqual(ctrl.hyprland, { key: 'Control_L', mods: 'CTRL' });
  assert.equal(normalizeKey('control').key, 'Control');
  assert.equal(normalizeKey('Shift').linux.code, 42);
  assert.equal(normalizeKey('Shift').hyprland.key, 'Shift_L');
  assert.equal(normalizeKey('Alt').linux.code, 56);
  assert.equal(normalizeKey('Alt').hyprland.key, 'Alt_L');

  const chord = normalizeKey('Ctrl+Super');
  assert.equal(chord.key, 'Super');
  assert.deepEqual(chord.mods, ['control']);
  assert.equal(chord.linux.code, 125);
  assert.equal(chord.combo, 'Ctrl+Super');
  assert.deepEqual(chord.hyprland, { key: 'Super_L', mods: 'CTRL+SUPER' });
  assert.deepEqual(normalizeKey('Ctrl+Shift+P').mods, ['control', 'shift']);
  assert.equal(normalizeKey('Ctrl+Shift+P').key, 'p');
});

test('invalid keys and empty combos are refused', () => {
  assert.throws(() => normalizeKey(''), /invalid_key/);
  assert.throws(() => normalizeKey('Ctrl+'), /invalid_key/);
  assert.throws(() => normalizeKey('F25'), /invalid_key/);
  assert.throws(() => normalizeKey({ key: 'Enter', modifiers: 'hyper' }), /invalid_key/);
});
