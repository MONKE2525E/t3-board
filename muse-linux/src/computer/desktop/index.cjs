'use strict';
const { AccessibilityClient } = require('./accessibility-client.cjs');
const { WindowingClient, InputClient } = require('./drivers.cjs');
const { fail, targetCheck, receipt } = require('./common.cjs');
/** Concrete ActionAdapter. Construct per session; all policy/drivers are trusted main-process injections. */
class DesktopController {
  constructor({ session, accessibility, windowing, input, authorize, pointerRefForElement, probe } = {}) {
    this.session = session; this.accessibility = accessibility; this.windowing = windowing; this.input = input;
    this.authorize = authorize; this.pointerRefForElement = pointerRefForElement; this.probeEvidence = probe;
  }
  capabilities(target) {
    if (!this.session || target.sessionId !== this.session.id || target.kind !== 'window') return { supported: false };
    return { supported: true, semantic: !!this.accessibility, windowing: !!this.windowing, physical: !!this.input,
      operations: ['query', 'click', 'invoke', 'focus', 'editText', 'select', 'setChecked', 'reveal', 'press',
        'activateWindow', 'closeWindow', 'moveWindow', 'scroll'] };
  }
  async preflight(op, ctx) {
    const target = op.ref?.target || op.target;
    targetCheck(target, this.session, ctx);
    if (!this.authorize) fail('permission_policy_unavailable');
    await this.authorize(target, op.kind, ctx);
    if (op.ref?.source === 'atspi') {
      const live = await this.accessibility.resolve(op.ref, ctx);
      return { eligible: true, revision: { ...ctx.revision }, evidence: [], target, live, path: 'atspi' };
    }
    if (['activateWindow', 'closeWindow', 'moveWindow'].includes(op.kind)) await this.windowing.validate(target, ctx,
      { activateWindow: 'activate', closeWindow: 'close', moveWindow: 'move' }[op.kind]);
    return { eligible: true, revision: { ...ctx.revision }, evidence: [], target };
  }
  async perform(op, ctx) {
    const result = await this.executeOperation(op, ctx);
    return { ...result, target: op.ref?.target || op.target, before: { ...ctx.revision }, after: { ...ctx.revision },
      ...(result.execution === 'failed' || result.execution === 'rejected' ? { failure: { kind: result.code === 'text_mismatch' ? 'assertion_failed' : 'backend_unavailable',
        code: result.code || 'desktop_operation_failed', phase: 'desktop', evidenceIds: [], requiredNext: 'read_authoritative_state' } } : {}) };
  }
  async executeOperation(op, ctx) {
    const preflight = await this.preflight(op, ctx);
    switch (op.kind) {
      case 'query': {
        const query = op.query;
        if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['role', 'name', 'states', 'rootRefId', 'exact', 'limit', 'scope'].includes(key)) ||
            typeof query.exact !== 'boolean' || !['visible', 'structural'].includes(query.scope) ||
            !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 256 ||
            (query.role !== undefined && (typeof query.role !== 'string' || query.role.length > 128)) ||
            (query.name !== undefined && (typeof query.name !== 'string' || query.name.length > 512)) ||
            (query.rootRefId !== undefined && (typeof query.rootRefId !== 'string' || !query.rootRefId || query.rootRefId.length > 128)) ||
            (query.states !== undefined && (!query.states || typeof query.states !== 'object' || Array.isArray(query.states) ||
              Object.entries(query.states).some(([state, value]) => !['enabled', 'sensitive', 'editable', 'readOnly', 'showing', 'visible',
                'checked', 'indeterminate', 'selected', 'focused', 'multiline', 'singleline'].includes(state) || typeof value !== 'boolean')))) fail('unsupported_query');
        const ancestor = query.rootRefId ? this.accessibility.refs.get(query.rootRefId) : undefined;
        if (query.rootRefId) {
          if (!ancestor) fail('stale_ref');
          this.accessibility.stored(ancestor.ref, ctx);
          if (ancestor.ref.target.targetId !== op.target.targetId) fail('stale_ref');
          await this.accessibility.resolve(ancestor.ref, ctx);
        }
        const observed = await this.accessibility.observe(op.target, { scope: query.scope, maxNodes: 2000, maxDepth: 12,
          ...(ancestor ? { rootRef: ancestor.ref } : {}) }, ctx);
        const matches = observed.nodes.filter(node => {
          if (query.role && node.role !== query.role || query.name !== undefined &&
              (query.exact ? node.name !== query.name : !node.name.includes(query.name)) ||
              Object.entries(query.states || {}).some(([state, value]) => node.states.includes(state) !== value)) return false;
          return true;
        });
        const max = query.limit;
        return receipt('atspi.query', { attempted: false, dispatch: 'not_started', effect: 'none_proven', evidence: [observed],
          matches: matches.slice(0, max).map(node => node.ref), complete: observed.coverage.complete && matches.length <= max,
          absence: matches.length === 0 && observed.coverage.complete ? 'verified_absent' : 'unknown' });
      }
      case 'click': {
        if (!op.ref.source) return this.input.click(op.ref, op.button, ctx);
        if (op.button !== 'left') return this.physicalElement(op, ctx);
        const action = ['click', 'press', 'toggle'].find(name => preflight.live.actions.includes(name));
        if (!action) return this.physicalElement(op, ctx);
        // Once invoke is called, no failure receipt or throw can trigger another route.
        return this.accessibility.invoke(op.ref, action, ctx);
      }
      case 'invoke': return this.accessibility.invoke(op.ref, op.actionName, ctx);
      case 'focus': return this.accessibility.focus(op.ref, ctx);
      case 'editText': return this.accessibility.edit(op.ref, op.edit, ctx);
      case 'select': return this.accessibility.select(op.ref, op.itemRefs, op.mode, ctx);
      case 'reveal': return this.accessibility.reveal(op.ref, op.edge, ctx);
      case 'setChecked': {
        if (typeof op.checked !== 'boolean' || preflight.live.states.includes('indeterminate')) fail('checked_state_unknown');
        if (preflight.live.states.includes('checked') === op.checked) return receipt('atspi.setChecked', {
          attempted: false, dispatch: 'not_started', effect: 'verified' });
        if (!preflight.live.actions.includes('toggle')) fail('semantic_unavailable');
        const result = await this.accessibility.invoke(op.ref, 'toggle', ctx);
        if (result.attempted === false) return result;
        try {
          const fresh = await this.accessibility.renewForRead(op.ref, ctx);
          const live = await this.accessibility.resolve(fresh, ctx);
          const verified = !live.states.includes('indeterminate') && live.states.includes('checked') === op.checked;
          return { ...result, effect: verified ? 'verified' : 'unknown', renewedRef: fresh };
        } catch { return result; }
      }
      case 'scroll':
        // Component.ScrollTo is reveal; Value alone never authorizes incremental scroll.
        if (op.ref.source) fail('semantic_incremental_scroll_unavailable');
        return this.input.wheel(op.ref, op.axis, op.delta, ctx);
      case 'press': return this.input.key(op.target, op.chord, ctx);
      case 'activateWindow': return this.windowing.activate(op.target, ctx);
      case 'closeWindow': return this.windowing.close(op.target, ctx);
      case 'moveWindow': return this.windowing.move(op.target, op.workspace, op.follow, ctx);
      default: fail('desktop_operation_unavailable');
    }
  }
  async physicalElement(op, ctx) {
    if (!this.pointerRefForElement || !this.input) return receipt('atspi.click', { execution: 'rejected', dispatch: 'not_started',
      effect: 'none_proven', attempted: false, unavailable: true, code: 'semantic_unavailable' });
    const coordinate = await this.pointerRefForElement(op.ref, ctx);
    if (!coordinate) fail('physical_target_unavailable');
    return this.input.click(coordinate, op.button, ctx);
  }
  async probe(predicates, target, ctx) {
    targetCheck(target, this.session, ctx);
    if (!this.probeEvidence) fail('desktop_probe_unavailable');
    return this.probeEvidence(predicates, target, ctx);
  }
  async quiesce(ctx) {
    const worker = await this.accessibility?.stop(ctx);
    const input = this.input ? await this.input.releaseOwned(ctx) : { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] };
    if (worker?.quiescence?.state === 'unknown') return { state: 'unknown', ownedInputReleased: input.ownedInputReleased,
      reasonCodes: [...new Set([...(input.reasonCodes || []), ...worker.quiescence.reasonCodes])] };
    return input;
  }
  async detach(ctx) { await this.quiesce(ctx); }
}
module.exports = { DesktopController, AccessibilityClient, WindowingClient, InputClient };
