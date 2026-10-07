function elementNumber(observation, args) {
  if (args.element_number != null && args.element_number !== '') {
    if (args.element_label) throw Error('ambiguous_selector: use element_number or element_label');
    const n = Number(args.element_number);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw Error('element_number_required');
    return n;
  }
  if (args.element_label == null || args.element_label === '') return null;
  if (typeof args.element_label !== 'string' || args.element_label.length > 150) throw Error('invalid_element_label');
  const wanted = args.element_label.trim().toLocaleLowerCase();
  const controls = observation?.controls || [];
  const matches = controls.filter(c => String(c.label || '').trim().toLocaleLowerCase() === wanted && !c.disabled);
  if (matches.length > 1) throw Error('ambiguous_control: use an element_number from the observation');
  if (matches.length !== 1) throw Error('control_not_found: observe the target again');
  return matches[0].element_number;
}

module.exports = { elementNumber };
