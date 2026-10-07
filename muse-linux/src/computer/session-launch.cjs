'use strict';
const C = require('./contracts.cjs');
const { classifyFailure } = require('./recovery.cjs');

const error = (kind, code = kind) => Object.assign(Error(code), { kind, code });
function sessionTarget(session) {
  if (session?.mode !== 'isolated_desktop' || session.ownership !== 'owned' || !session.display?.instanceId) throw error('stale_target');
  return C.validateTargetRef({ sessionId: session.id, kind: 'session', targetId: session.id,
    generation: session.generation, ownership: 'owned', compositorInstance: session.display.instanceId });
}
function createSessionLaunchAdapter({ manager, session }) {
  const target = sessionTarget(session);
  const check = (op, ctx) => {
    ctx.progress.check('preflight');
    if (session.state !== 'ready' || ctx.session !== session || !C.sameTarget(target, sessionTarget(session)) || !C.sameTarget(op.target, target)) throw error('stale_target');
    if (op.kind !== 'launchApp') throw error('invalid_request', 'unsupported_operation');
    const app = Object.hasOwn(manager.options?.apps || {}, op.appId) && manager.options.apps[op.appId];
    if (!app || app.internalOnly) throw error('permission_denied');
  };
  return {
    async preflight(op, ctx) {
      try { check(op, ctx); return { eligible: true, revision: ctx.revision, evidence: [], noEffectProven: true }; }
      catch (cause) { return { eligible: false, revision: ctx.revision, evidence: [], noEffectProven: true, failure: classifyFailure(cause, { phase: 'preflight' }) }; }
    },
    async perform(op, ctx) {
      check(op, ctx);
      const handle = await ctx.dispatch.beforeEffect({ primitive: 'Session.launch', substep: 'launchApp', target });
      let client;
      try {
        check(op, ctx);
        client = await manager.launch(session.id, { appId: op.appId, args: [] }, ctx);
        if (client?.sessionId !== session.id || client.ownership !== 'owned' || !Number.isSafeInteger(client.process?.pid) || client.process.pid <= 0 || typeof client.process.startToken !== 'string') throw error('internal_defect', 'adapter_contract_violation');
      } catch (cause) {
        const failure = classifyFailure(cause, { phase: 'dispatch', attempts: [{ effect: 'unknown' }] });
        await ctx.dispatch.afterEffect(handle, { state: 'lost', noEffectProven: false, failure });
        return { target, before: ctx.revision, dispatch: 'possible', effect: 'unknown', attempts: [], evidence: [], timings: ctx.progress.timings(), failure };
      }
      await ctx.dispatch.afterEffect(handle, { state: 'accepted', noEffectProven: false });
      return { target, before: ctx.revision, after: ctx.revision, dispatch: 'acknowledged', effect: 'unknown', attempts: [], evidence: [], timings: ctx.progress.timings(),
        launch: { process: { ...client.process }, instance: 'created_or_reused', window_verified: false } };
    },
    async probe() { return []; },
    async quiesce() { return { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }; },
  };
}
module.exports = { sessionTarget, createSessionLaunchAdapter };
