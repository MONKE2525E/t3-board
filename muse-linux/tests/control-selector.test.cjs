const test = require('node:test');
const assert = require('node:assert/strict');
const { elementNumber } = require('../src/control-selector.cjs');
test('selectors accept string-wire numbers and only unique enabled observed labels', () => {
  const observation = { controls: [{ element_number: 1, label: 'Save note' }, { element_number: 2, label: 'Save note', disabled: true }] };
  assert.equal(elementNumber(observation, { element_number: '2' }), 2);
  assert.equal(elementNumber(observation, { element_label: ' SAVE NOTE ' }), 1);
  observation.controls[1].disabled = false;
  assert.throws(() => elementNumber(observation, { element_label: 'Save note' }), /ambiguous_control/);
  assert.throws(() => elementNumber(observation, { element_label: 'not observed' }), /control_not_found/);
  assert.throws(() => elementNumber(observation, { element_number: '1', element_label: 'Save note' }), /ambiguous_selector/);
  for (const element_number of ['0','-1','1.5','1001']) assert.throws(() => elementNumber(observation,{ element_number }), /element_number_required/);
});
