'use strict';
const { performance } = require('node:perf_hooks');
const { fail, check, targetCheck, evidence, receipt, boundary } = require('./common.cjs');
function exactWindow(observed, target) {
  return observed && observed.targetId === target.targetId && observed.sessionId === target.sessionId &&
    observed.generation === target.generation && observed.process?.pid === target.process.pid &&
    observed.process?.startToken === target.process.startToken;
}
/** driver methods are trusted scoped legacy adapters. They must never resolve ambient displays. */
class WindowingClient {
  constructor({ session, driver, authorize, verifyWindow } = {}) {
    this.session = session; this.driver = driver; this.authorize = authorize; this.verifyWindow = verifyWindow;
  }
  async validate(target, ctx, operation) {
    targetCheck(target, this.session, ctx);
    if (!this.driver || !this.authorize) fail('windowing_unavailable');
    await this.authorize(target, operation, ctx);
    const live = await this.driver.inspect(target, ctx);
    if (!exactWindow(live, target)) fail('stale_target');
    return live;
  }
  async list(ctx) {
    check(ctx, 'window.list');
    if (!this.driver || ctx.sessionId !== this.session.id) fail('windowing_unavailable');
    const start = performance.now(); const result = await this.driver.list(ctx);
    return { ...evidence(result.target || { sessionId: this.session.id, kind: 'window', targetId: 'window-picker', generation: 0,
      ownership: this.session.ownership }, ctx, result.facts, start, result.coverage), source: 'window', producer: 'muse.windowing.v1' };
  }
  async action(target, operation, params, ctx) {
    await this.validate(target, ctx, operation);
    if (typeof this.driver[operation] !== 'function') fail('window_operation_unavailable');
    const reply = await boundary(ctx, `window.${operation}`, target, () => this.driver[operation](target, params, ctx));
    // Graceful close may leave an unsaved dialog. Return unknown unless a specific verifier establishes the effect.
    let proof;
    try { proof = await this.verifyWindow?.(target, operation, params, ctx); } catch { proof = undefined; }
    return receipt(`window.${operation}`, { path: 'window', dispatch: 'possible', primitiveDispatches: 'unknown',
      effect: proof?.verified ? 'verified' : 'unknown', evidence: proof?.evidence || [], acknowledgement: reply });
  }
  activate(target, ctx) { return this.action(target, 'activate', {}, ctx); }
  close(target, ctx) { return this.action(target, 'close', { graceful: true }, ctx); }
  move(target, workspace, follow, ctx) {
    if (typeof workspace !== 'string' || !/^[a-zA-Z0-9_:-]{1,64}$/u.test(workspace) || typeof follow !== 'boolean') fail('invalid_workspace');
    return this.action(target, 'move', { workspace, follow }, ctx);
  }
}
class InputClient {
  constructor({ session, driver, authorize, verifyCoordinate, verifyKeyTarget } = {}) {
    this.session = session; this.driver = driver; this.authorize = authorize;
    this.verifyCoordinate = verifyCoordinate; this.verifyKeyTarget = verifyKeyTarget;
  }
  async coordinate(ref, ctx, operation) {
    targetCheck(ref.target, this.session, ctx);
    if (!this.driver || !this.authorize || !this.verifyCoordinate || !ref.captureId || !ref.transformId ||
        !Array.isArray(ref.point) || ref.point.length !== 2 || !ref.point.every(Number.isFinite) ||
        !['capture_px', 'window_normalized'].includes(ref.space)) fail('physical_target_unavailable');
    for (const key of ['sessionGeneration', 'grantGeneration', 'targetGeneration', 'semanticRevision', 'geometryRevision']) {
      if (ref.revision?.[key] !== ctx.revision[key]) fail('stale_coordinates');
    }
    await this.authorize(ref.target, operation, ctx);
    const proof = await this.verifyCoordinate(ref, ctx);
    if (!proof || proof.captureId !== ref.captureId || proof.transformId !== ref.transformId ||
        !exactWindow(proof.target, ref.target) || proof.occluded !== false || proof.hit !== true ||
        proof.geometryCurrent !== true || proof.transformVerified !== true || !proof.point?.every(Number.isFinite)) fail('physical_target_unavailable');
    return proof;
  }
  async click(ref, button, ctx) {
    if (!['left', 'right', 'middle'].includes(button)) fail('invalid_button');
    const proof = await this.coordinate(ref, ctx, 'click');
    const result = await boundary(ctx, 'input.click', ref.target, () => this.driver.click(proof, button, ctx));
    return receipt('input.click', { path: 'physical', dispatch: 'possible', primitiveDispatches: 'unknown', acknowledgement: result });
  }
  async wheel(ref, axis, delta, ctx) {
    if (!['x', 'y'].includes(axis) || !Number.isFinite(delta) || Math.abs(delta) > 10000 || delta === 0) fail('invalid_scroll');
    const proof = await this.coordinate(ref, ctx, 'scroll');
    const result = await boundary(ctx, 'input.wheel', ref.target, () => this.driver.wheel(proof, axis, delta, ctx));
    return receipt('input.wheel', { path: 'physical', dispatch: 'possible', primitiveDispatches: 'unknown', acknowledgement: result });
  }
  async key(target, chord, ctx) {
    targetCheck(target, this.session, ctx);
    if (typeof chord !== 'string' || chord.length > 128 || !chord.length || /[\x00-\x1f]/u.test(chord)) fail('invalid_chord');
    if (!this.authorize || !this.verifyKeyTarget || !this.driver) fail('key_target_unavailable');
    await this.authorize(target, 'press', ctx);
    const proof = await this.verifyKeyTarget(target, ctx);
    if (!exactWindow(proof?.target, target) || !proof?.deliveryVerified || proof.xwaylandToXwayland === true) fail('key_target_unavailable');
    const result = await boundary(ctx, 'input.key', target, () => this.driver.key(proof, chord, ctx));
    return receipt('input.key', { path: 'physical', dispatch: 'possible', primitiveDispatches: 'unknown', acknowledgement: result });
  }
  async releaseOwned(ctx) {
    // The driver tracks only its own held keys/buttons. No intended input during cleanup.
    if (!this.driver?.releaseOwned) return { state: 'unknown', ownedInputReleased: false, reasonCodes: ['release_unavailable'] };
    return this.driver.releaseOwned(ctx);
  }
}
module.exports = { WindowingClient, InputClient, exactWindow };
