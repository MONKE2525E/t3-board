const ACTIONS = new Set(['move', 'click', 'perform_action', 'double_click', 'drag', 'scroll', 'focus', 'type', 'key', 'wait']);
const FIELDS = new Set(['action', 'action_name', 'element_number', 'element_label', 'coordinate', 'start_coordinate', 'end_coordinate', 'button', 'text', 'replace_all', 'key', 'modifiers', 'scroll_direction', 'scroll_amount', 'duration']);

function parseActions(value) {
  let actions = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > 65536) throw Error('batch_too_large');
    try { actions = JSON.parse(value); } catch { throw Error('invalid_actions: use a JSON-encoded array of action objects'); }
  }
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 16) throw Error('invalid_actions: use 1-16 actions');
  return actions.map(step => {
    if (!step || typeof step !== 'object' || Array.isArray(step) || !ACTIONS.has(step.action)) throw Error('invalid_batch_action');
    if (Object.keys(step).some(key => !FIELDS.has(key))) throw Error('invalid_batch_field: target and observation belong to the whole batch');
    if (step.text != null && (typeof step.text !== 'string' || step.text.length > 4096 || step.text.includes('\0'))) throw Error('invalid_text');
    return structuredClone(step);
  });
}

async function runBatch(backend, args) {
  const actions = parseActions(args.actions);
  const outcomes = [];
  let observationId = args.observation_id;
  if (!observationId || observationId !== backend.observation?.id) throw Error('stale_observation: observe before starting a batch');
  const windowId = args.window_id || backend.observation?.window_id;
  let error, attempted = 0;
  for (const step of actions) {
    attempted++;
    try {
      const result = await backend.control({ ...step, window_id: windowId, observation_id: observationId, __deadline: args.__deadline }, { deferObservation: true });
      if (result.observation?.observation_id) observationId = result.observation.observation_id;
      outcomes.push({ action: step.action, dispatched: result.dispatched === true, ...(result.route ? {route:result.route} : {}), ...(result.dispatch_path ? {dispatch_path:result.dispatch_path} : {}), ...(result.action_name ? {action_name:result.action_name} : {}), ...(result.pointer ? { pointer: result.pointer } : {}), ...(result.error ? { error: result.error, uncertain: true } : {}) });
      if (result.error) { error = result.error; break; }
    } catch (failure) { error = failure.message || 'batch_action_failed'; break; }
  }
  let observation, observationError;
  try {
    await backend.settleBatch?.(args);
    observation = backend.requireSession
      ? await backend.observe({view:args.view,force_image:args.force_image})
      : await backend.observe({ window_id: windowId, view: args.view, force_image:args.force_image, __deadline: args.__deadline });
  } catch (failure) { observationError = failure.message || 'observation_unavailable'; }
  const image = observation?.image_transfer;
  if (image) delete observation.image_transfer;
  return {
    completed: outcomes.filter(outcome => outcome.dispatched).length, total: actions.length, attempted, outcomes,
    stopped: !!error, ...(error ? { error, failed_action: actions[attempted - 1]?.action, failed_action_may_have_partial_effects: true } : {}),
    ...(observation ? { observation } : { observation_error: observationError }),
    ...(image ? { image_transfer: image } : {}),
    task_success: false, retryable: false,
    verification: 'Inspect the final observation. Completed means input dispatched, not task success. Do not replay the batch after partial completion or an uncertain outcome.',
  };
}

module.exports = { parseActions, runBatch };
