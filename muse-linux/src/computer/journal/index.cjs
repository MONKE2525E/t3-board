'use strict';

const { randomUUID, createHmac } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const safe = require('./safe.cjs');
const { FileJournalStorage } = require('./storage.cjs');

const clone = value => JSON.parse(JSON.stringify(value));
const keyFor = key => [safe.id(key.deviceId), safe.id(key.runId), safe.id(key.invokeId), key.actionId ? safe.id(key.actionId) : ''].join('|');
const defaultClock = { now: () => performance.now(), utc: () => new Date().toISOString(), domain: 'main' };

/** Durable dispatch ledger and metadata-only trace. All calls are main-private. */
class ReceiptJournal {
  constructor({ directory, storage, deviceId, clock = defaultClock, ioTimeoutMs = 2000,
    recordBytes = 8192, segmentBytes = 1024 * 1024, metadataBytes = 32 * 1024 * 1024,
    retentionMs = 7 * 86400000, dedupRetentionMs = 30 * 86400000,
    maxRuns = 4096, maxActionsPerRun = 128, maxRemoteInvokes = 32768, queueLimit = 256 } = {}) {
    this.deviceId = safe.id(deviceId);
    this.storage = storage || new FileJournalStorage({ directory, maxBytes: metadataBytes });
    this.clock = { now: () => clock.now(), domain: safe.id(clock.domain), utc: () => new Date(clock.utc()).toISOString() };
    this.options = { ioTimeoutMs, recordBytes, segmentBytes, metadataBytes, retentionMs, dedupRetentionMs, maxRuns, maxActionsPerRun, maxRemoteInvokes, queueLimit };
    for (const value of Object.values(this.options)) if (!Number.isFinite(value) || value <= 0) throw safe.failure('invalid_request');
    this.status = { state: 'durable', throughSeq: 0, codes: [] };
    this.queue = Promise.resolve(); this.queued = 0; this.closed = false; this.poisoned = false;
    this.actions = new WeakMap(); this.attempts = new WeakMap(); this.reservations = new Map();
    this.memoryReceipts = new Map(); this.memoryInvocations = new Map(); this.events = []; this.gaps = []; this.unknownRanges = [];
    this.ready = this._io(() => this._initialize());
    this.ready.catch(() => {});
  }
  _degrade(code, unavailable = false) {
    this.status.state = unavailable ? 'unavailable' : this.status.state === 'unavailable' ? 'unavailable' : 'degraded';
    if (!this.status.codes.includes(code)) this.status.codes.push(code);
  }
  async _io(work, maxMs = this.options.ioTimeoutMs) {
    if (this.poisoned) throw safe.failure('journal_unavailable');
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
        timer = setTimeout(() => { this.hung = true; this.poisoned = true; this._degrade('journal_timeout', true); reject(safe.failure('journal_timeout')); }, Math.max(1, Math.min(maxMs, this.options.ioTimeoutMs)));
      })]);
    } finally { clearTimeout(timer); }
  }
  async _initialize() {
    try {
      this.key = await this.storage.open();
      if (!Buffer.isBuffer(this.key) || this.key.length !== 32) throw safe.failure('key_invalid');
      let envelope;
      try { envelope = JSON.parse((await this.storage.read('ledger.json')).toString()); }
      catch (error) {
        if (error.code !== 'ENOENT' || this.storage.fresh !== true) throw safe.failure('ledger_invalid');
        this.state = { schema: 'muse.ledger.v1', deviceId: this.deviceId, seq: 0, corruptionRanges: [], runs: {}, deliveries: {}, invocations: {}, operations: {} };
        await this._commit(this.state, 'initialize');
      }
      if (envelope) {
        if (!safe.equalMac(envelope.mac, safe.mac(this.key, envelope.state)) || envelope.state.schema !== 'muse.ledger.v1' || envelope.state.deviceId !== this.deviceId || !Number.isSafeInteger(envelope.state.seq) || envelope.state.seq < 0) throw safe.failure('ledger_invalid');
        this.state = envelope.state;
        if (!this.state.runs || !this.state.deliveries || !this.state.invocations || !this.state.operations) throw safe.failure('ledger_invalid');
      }
      this.status.throughSeq = this.state.seq;
      await this._scan(true);
      for (const operation of Object.values(this.state.operations)) {
        if (!operation.receipt) operation.recovered = true;
      }
      for (const invocation of Object.values(this.state.invocations)) if (!invocation.receipt) invocation.recovered = true;
      await this._expire();
      await this.storage.reserve(0);
      return this;
    } catch (error) { this.poisoned = true; this._degrade(safe.code(error.code) === 'unknown' ? 'journal_unavailable' : error.code, true); throw safe.failure(error.code && safe.code(error.code) !== 'unknown' ? error.code : 'journal_unavailable'); }
  }
  _serial(work) {
    if (this.queued >= this.options.queueLimit) return Promise.reject(safe.failure('queue_full'));
    this.queued++;
    const result = this.queue.then(async () => {
      await this.ready;
      if (this.closed || this.poisoned) throw safe.failure('journal_unavailable');
      return work();
    });
    this.queue = result.catch(() => {}).finally(() => { this.queued--; });
    return result;
  }
  async _commit(state, purpose) {
    const data = JSON.stringify({ state, mac: safe.mac(this.key, state) });
    if (Buffer.byteLength(data) + this._reserved() > this.options.metadataBytes / 2) throw safe.failure('journal_full');
    await this.storage.atomicWrite('ledger.json', data, purpose);
    this.state = state;
    this.status.throughSeq = state.seq;
  }
  _reserved() { return [...this.reservations.values()].reduce((sum, value) => sum + value.bytes, 0); }
  async _update(work, purpose) {
    const state = clone(this.state);
    const result = work(state);
    try { await this._io(() => this._commit(state, purpose)); }
    catch (error) { this._degrade('journal_write_failed', true); this.poisoned = true; throw safe.failure(error.code === 'journal_timeout' ? error.code : 'journal_write_failed'); }
    return result;
  }
  async _event(kind, context, payload, purpose) {
    const event = { schema: 'muse.journal.v1', seq: this.state.seq + 1, runId: safe.id(context.runId), producer: 'main', kind, safePayload: payload, interval: { monoMs: this.clock.now(), clockDomain: safe.id(this.clock.domain), utc: this.clock.utc() } };
    for (const field of ['invokeId', 'actionId', 'parentActionId']) if (context[field]) event[field] = safe.id(context[field]);
    if (Number.isSafeInteger(context.stepIndex)) event.stepIndex = context.stepIndex;
    const line = JSON.stringify({ event, mac: safe.mac(this.key, event) }) + '\n';
    if (Buffer.byteLength(line) > this.options.recordBytes) throw safe.failure('record_too_large');
    await this._update(state => { state.seq = event.seq; }, purpose + ':sequence');
    try {
      await this._io(async () => {
        const segments = await this.storage.segments();
        const last = segments.at(-1);
        const name = !last || last.bytes + Buffer.byteLength(line) > this.options.segmentBytes ? 'segment-' + String(event.seq).padStart(12, '0') + '.jsonl' : last.name;
        await this.storage.append(name, line);
        this.events.push(event);
        await this._retain();
      });
    } catch (error) { this.gaps = mergeGaps([...this.gaps, [event.seq, event.seq]]); this._degrade('journal_write_failed'); }
    return event.seq;
  }
  async registerRun(runId, manifest = []) {
    return this._serial(async () => {
      safe.id(runId);
      if (!Array.isArray(manifest) || manifest.length > 32) throw safe.failure('invalid_request');
      manifest = manifest.map(p => ({ id: safe.id(p.id), validator: safe.id(p.validator), validatorVersion: safe.number(p.validatorVersion), target: safe.target(p.target), argsMac: /^[a-f0-9]{64}$/.test(p.argsMac) ? p.argsMac : undefined }));
      if (manifest.some(p => !p.argsMac || !p.validatorVersion)) throw safe.failure('invalid_request');
      if (this.state.runs[runId]) throw safe.failure(this.state.runs[runId].retired ? 'run_retired' : 'dedup_collision');
      if (Object.keys(this.state.runs).length >= this.options.maxRuns) throw safe.failure('journal_full');
      await this._update(state => { state.runs[runId] = { createdMs: Date.parse(this.clock.utc()), startSeq: state.seq + 1, retired: false, manifest, reducer: null }; }, 'run');
      await this._event('run.begin', { runId }, { requirementIds: manifest.map(p => p.id) }, 'run');
      return { id: runId, kind: 'run' };
    });
  }
  async parameterMac(params) { await this.ready; return safe.mac(this.key, params, 1024 * 1024); }
  async lookup(key, parameterMac) {
    await this.ready;
    // Reading an in-memory terminal result remains possible after a persistence failure.
    if (this.poisoned) return this._lookup(key, parameterMac);
    return this._serial(async () => { await this._expire(); return this._lookup(key, parameterMac); });
  }
  _lookup(key, parameterMac) {
    let encoded = keyFor(key);
    if (key.deviceId !== this.deviceId) return { state: 'expired' };
    if (!key.actionId) {
      const delivery = this.state.deliveries[safe.id(key.invokeId)];
      if (delivery) {
        if (!safe.equalMac(delivery.parameterMac, parameterMac)) return { state: 'collision' };
        if (delivery.retired) return { state: 'expired' };
        key = { deviceId: this.deviceId, runId: delivery.runId, invokeId: key.invokeId };
        encoded = keyFor(key);
      }
    }
    const run = this.state.runs[key.runId];
    if (!run || run.retired) return { state: 'expired' };
    const operation = key.actionId ? this.state.operations[encoded] : this.state.invocations[encoded];
    if (!operation) return { state: 'new' };
    if (!safe.equalMac(operation.parameterMac, parameterMac)) return { state: 'collision' };
    if (operation.expired) return { state: 'expired' };
    const receipt = (key.actionId ? this.memoryReceipts : this.memoryInvocations).get(encoded) || operation.receipt;
    if (receipt) return { state: 'receipt', receipt: clone(receipt) };
    const attempted = key.actionId ? operation.attempts.length : Object.values(this.state.operations).some(op => op.runId === key.runId && op.invokeId === key.invokeId && op.attempts.length);
    return { state: operation.recovered || attempted ? 'unfinished' : 'pending' };
  }
  async admit(req, reserveBytes) {
    try {
      return await this._serial(async () => {
        await this._expire();
        const run = this.state.runs[safe.id(req.runId)];
        if (req.deviceId !== this.deviceId || !run || run.retired) throw safe.failure('run_unknown');
        if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 1024 || reserveBytes > 256 * 1024) throw safe.failure('invalid_request');
        const reservationId = keyFor({ deviceId: req.deviceId, runId: req.runId, invokeId: req.invokeId });
        const parameterMac = safe.mac(this.key, { command: req.command, params: req.params }, 1024 * 1024);
        const existing = this.reservations.get(reservationId);
        const invocation = this.state.invocations[reservationId];
        const delivered = this.state.deliveries[req.invokeId];
        if (delivered && !safe.equalMac(delivered.parameterMac, parameterMac)) throw safe.failure('dedup_collision');
        if (delivered && (delivered.runId !== req.runId || delivered.retired)) throw safe.failure('dedup_expired');
        if (invocation && !safe.equalMac(invocation.parameterMac, parameterMac)) throw safe.failure('dedup_collision');
        if (existing && !invocation?.receipt && !invocation?.recovered) throw safe.failure('dedup_pending');
        if (invocation) throw safe.failure('dedup_expired');
        if (Object.keys(this.state.deliveries).length >= this.options.maxRemoteInvokes) throw safe.failure('journal_full');
        if (this.reservations.size >= this.options.queueLimit) throw safe.failure('journal_full');
        const bytes = Buffer.byteLength(JSON.stringify(this.state)) + this._reserved() + reserveBytes;
        if (bytes > this.options.metadataBytes / 2) throw safe.failure('journal_full');
        await this._io(() => this.storage.reserve(this._reserved() + reserveBytes));
        // Probe actual durable storage before admission. Dispatch still needs a second fsync.
        await this._update(state => {
          state.invocations[reservationId] = { deviceId: req.deviceId, runId: req.runId, invokeId: req.invokeId, parameterMac, plan: req.command === 'computer.plan', startedMs: Date.parse(this.clock.utc()) };
          state.deliveries[req.invokeId] = { runId: req.runId, parameterMac, retired: false };
        }, 'admission');
        this.reservations.set(reservationId, { bytes: reserveBytes, remaining: reserveBytes, runId: req.runId });
        return { accepted: true, reserveBytes };
      });
    } catch (error) { return { accepted: false, reserveBytes: 0, failure: error.failure || safe.failure('journal_unavailable').failure }; }
  }
  async begin(context, summary) {
    return this._serial(async () => {
      const request = safe.summary(summary);
      await this._expire();
      const key = { deviceId: context.deviceId || this.deviceId, runId: safe.id(context.runId), invokeId: safe.id(context.invokeId), actionId: safe.id(context.actionId) };
      const encoded = keyFor(key);
      const duplicate = this._lookup(key, request.parameterMac);
      if (duplicate.state !== 'new') throw safe.failure(duplicate.state === 'collision' ? 'dedup_collision' : 'dedup_expired');
      const reservationId = keyFor({ ...key, actionId: undefined });
      const reservation = this.reservations.get(reservationId);
      if (!reservation) throw safe.failure('reservation_missing');
      const invocation = this.state.invocations[reservationId];
      if (!invocation || invocation.receipt || invocation.recovered) throw safe.failure('dedup_expired');
      const beginBytes = Buffer.byteLength(JSON.stringify(request)) + 512;
      if (reservation.remaining < beginBytes + 1024) throw safe.failure('journal_full');
      if (Object.values(this.state.operations).filter(op => op.runId === key.runId).length >= this.options.maxActionsPerRun) throw safe.failure('journal_full');
      await this._update(state => { state.operations[encoded] = { ...key, parameterMac: request.parameterMac, summary: request, before: safe.revision(context.revision), attempts: [], startedMs: Date.parse(this.clock.utc()) }; }, 'begin');
      reservation.remaining -= beginBytes;
      const handle = Object.freeze({ id: randomUUID(), kind: 'action' });
      this.actions.set(handle, { encoded, context: { runId: key.runId, invokeId: key.invokeId, actionId: key.actionId, parentActionId: context.parentActionId, stepIndex: context.stepIndex }, reservationId });
      await this._event('action.begin', key, request, 'begin');
      return handle;
    });
  }
  async beforeEffect(handle, attempt) {
    return this._serial(async () => {
      const active = this.actions.get(handle);
      if (!active || this.state.operations[active.encoded].receipt) throw safe.failure('invalid_request');
      const reservation = this.reservations.get(active.reservationId);
      if (!reservation) throw safe.failure('reservation_missing');
      const entry = { id: randomUUID(), primitive: safe.primitives.has(attempt.primitive) ? attempt.primitive : 'unknown', substep: safe.operations.has(attempt.substep) ? attempt.substep : 'unknown', target: safe.target(attempt.target), revision: safe.revision(attempt.revision), dispatch: 'possible', effect: 'unknown', intentSeq: this.state.seq + 1 };
      const bytes = Buffer.byteLength(JSON.stringify(entry)) + 256;
      if (reservation.remaining < bytes + 1024) throw safe.failure('journal_full');
      const start = this.clock.now();
      // Atomic replacement + file fsync + directory fsync must finish before resolving.
      await this._update(state => {
        state.operations[active.encoded].attempts.push(entry);
        // Keep invalidation after the mutating run's operation details expire.
        for (const run of Object.values(state.runs)) if (run.reducer) {
          for (const predicate of run.manifest) if (predicate.target?.sessionId === entry.target?.sessionId && predicate.target?.kind === entry.target?.kind && predicate.target?.targetId === entry.target?.targetId) {
            (run.reducer.mutationThroughSeq ||= {})[predicate.id] = entry.intentSeq;
          }
        }
      }, 'intent');
      reservation.remaining -= bytes;
      const token = Object.freeze({ id: entry.id, kind: 'attempt' });
      this.attempts.set(token, { action: active, id: entry.id });
      await this._event('attempt.intent', active.context, { ...entry, journalFsyncMs: this.clock.now() - start }, 'intent');
      if (this.poisoned) throw safe.failure('journal_unavailable');
      return token;
    });
  }
  async endAttempt(handle, outcome) {
    return this._serial(async () => {
      const active = this.attempts.get(handle);
      if (!active) throw safe.failure('invalid_request');
      const operation = this.state.operations[active.action.encoded];
      const previous = operation.attempts.find(a => a.id === active.id);
      if (!previous || previous.ended) throw safe.failure('invalid_request');
      const terminal = safe.attempt({ ...previous, ...outcome, id: previous.id, target: previous.target, primitive: previous.primitive, substep: previous.substep });
      terminal.intentSeq = previous.intentSeq;
      try {
        await this._update(state => { Object.assign(state.operations[active.action.encoded].attempts.find(a => a.id === active.id), terminal, { ended: true }); }, 'attempt_end');
        await this._event('attempt.end', active.action.context, terminal, 'attempt_end');
      } catch (error) { this._degrade('persistence_degraded'); }
    });
  }
  async end(handle, receipt) {
    // Terminal input facts survive even when the writer is poisoned after dispatch.
    await this.ready;
    const active = this.actions.get(handle);
    if (!active) throw safe.failure('invalid_request');
    let terminal = safe.receipt(receipt);
    const operation = this.state.operations[active.encoded];
    if (terminal.runId !== operation.runId || terminal.invokeId !== operation.invokeId || terminal.actionId !== operation.actionId) throw safe.failure('invalid_request');
    if (operation.attempts.length && terminal.dispatch === 'not_started') {
      terminal.dispatch = 'possible'; terminal.effect = 'unknown'; terminal.replay = 'forbidden';
    }
    terminal.journal = { throughSeq: this.state.seq, integrity: this.integrity(operation.runId) };
    terminal.persistence = this.status.state;
    this.memoryReceipts.set(active.encoded, terminal);
    const singleInvocation = !this.state.invocations[active.reservationId]?.plan;
    if (singleInvocation) this.memoryInvocations.set(active.reservationId, { receipt: terminal, artifacts: terminal.artifacts });
    try {
      terminal = await this._serial(async () => {
        const compact = require('./projection.cjs').compactResult(terminal);
        const reservation = this.reservations.get(active.reservationId);
        if (reservation) {
          const release = Math.min(reservation.bytes, Buffer.byteLength(JSON.stringify(terminal)) + 4096);
          await this._io(() => this.storage.reserve(this._reserved() - release));
          reservation.bytes -= release;
          reservation.remaining = Math.max(0, reservation.remaining - release);
        }
        terminal.journal.throughSeq = this.state.seq + 1;
        await this._update(state => {
          state.operations[active.encoded].receipt = terminal;
          if (singleInvocation) state.invocations[active.reservationId].receipt = { receipt: terminal, artifacts: terminal.artifacts };
        }, 'terminal');
        await this._event('action.end', active.context, compact, 'terminal');
        terminal.persistence = this.status.state;
        terminal.journal = { throughSeq: this.state.seq, integrity: this.integrity(operation.runId) };
        return terminal;
      });
    } catch (error) { terminal.persistence = 'degraded'; terminal.journal.integrity = 'unknown'; this._degrade('persistence_degraded'); }
    this.memoryReceipts.set(active.encoded, terminal);
    if (singleInvocation) this.memoryInvocations.set(active.reservationId, { receipt: terminal, artifacts: terminal.artifacts });
    this.actions.delete(handle);
    return clone(terminal);
  }
  async releaseAdmission(req) {
    await this.ready;
    this.reservations.delete(keyFor({ deviceId: req.deviceId || this.deviceId, runId: req.runId, invokeId: req.invokeId }));
    if (!this.poisoned) await this._serial(() => this._io(() => this.storage.reserve(this._reserved())));
  }
  async lookupInvocation(invokeId, parameterMac) {
    await this.ready;
    const delivery = this.state.deliveries[safe.id(invokeId)];
    if (!delivery) return { state: 'new' };
    return this.lookup({ deviceId: this.deviceId, runId: delivery.runId, invokeId }, parameterMac);
  }
  lookupDelivery(invokeId, parameterMac) { return this.lookupInvocation(invokeId, parameterMac); }
  /** Read-only startup fence. Terminal unverified receipts are not crash-pending. */
  async checkUnfinished({ runId, target }) {
    return this._serial(() => {
      safe.id(runId);
      const selected = safe.target(target);
      if (!selected) throw safe.failure('invalid_request');
      const run = this.state.runs[runId];
      if (!run || run.retired) throw safe.failure('run_unknown');
      const unfinishedActionIds = Object.values(this.state.operations).filter(operation => operation.runId === runId && operation.recovered && !operation.receipt && operation.attempts.some(attempt => safe.sameTarget(attempt.target, selected) && (attempt.dispatch !== 'not_started' || attempt.effect !== 'none_proven'))).map(operation => operation.actionId);
      return { blocked: unfinishedActionIds.length > 0, unfinishedActionIds: [...new Set(unfinishedActionIds)] };
    });
  }
  async invocationMac(req) { return this.parameterMac({ command: req.command, params: req.params }); }
  readTrace(req) { return this.read(req); }
  /** Finalize multi-action invocations only after their skipped suffix is accounted for. */
  async finishInvocation(req, result) {
    await this.ready;
    const encoded = keyFor({ deviceId: req.deviceId || this.deviceId, runId: req.runId, invokeId: req.invokeId });
    const projected = { receipt: require('./projection.cjs').compactResult(result.receipt || result), artifacts: (result.artifacts || []).map(safe.artifact) };
    if (!this.state.invocations[encoded]) throw safe.failure('invalid_request');
    this.memoryInvocations.set(encoded, projected);
    try { await this._serial(() => this._update(state => { state.invocations[encoded].receipt = projected; }, 'invocation_terminal')); }
    catch (error) { this._degrade('persistence_degraded'); }
    await this.releaseAdmission(req);
    return clone(projected);
  }
  /** Page terminal details directly from the bounded ledger, independently of trace eviction. */
  async readAction({ runId, actionId, section = 'attempts', offset = 0, limit = 16, maxBytes = 8192 }) {
    await this.ready;
    safe.id(runId); safe.id(actionId);
    if (!['attempts', 'assertions', 'artifacts'].includes(section) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw safe.failure('invalid_request');
    if (!this.poisoned) await this._serial(() => this._io(() => this._scan()));
    const operation = Object.values(this.state.operations).find(op => op.runId === runId && op.actionId === actionId);
    if (!operation) throw safe.failure('dedup_expired');
    const receipt = this.memoryReceipts.get(keyFor(operation)) || operation.receipt;
    if (!receipt) return { runId, actionId, execution: 'unfinished', dispatch: operation.attempts.length ? 'possible' : 'not_started', effect: 'unknown', replay: 'forbidden', persistence: this.status.state, attempts: operation.attempts.slice(offset, offset + 1), integrity: this.integrity() };
    const core = require('./projection.cjs').compactResult({ ...receipt, attempts: [], assertions: [], artifacts: [], journal: { throughSeq: this.state.seq, integrity: this.integrity(runId) }, persistence: this.status.state });
    const page = { receipt: core, section, offset, total: receipt[section].length, items: [] };
    const cap = Math.max(1024, Math.min(32768, maxBytes));
    for (const item of receipt[section].slice(offset, offset + Math.max(1, Math.min(100, limit)))) {
      const next = { ...page, items: [...page.items, item], nextOffset: offset + page.items.length + 1 };
      if (Buffer.byteLength(JSON.stringify(next)) > cap) break;
      page.items.push(clone(item));
    }
    if (offset + page.items.length < page.total) page.nextOffset = offset + page.items.length;
    if (page.nextOffset === offset) return { runId, actionId, failure: safe.failure('result_overflow').failure, replay: 'forbidden' };
    return page;
  }
  async retireRun(runId) {
    return this._serial(async () => {
      if (!this.state.runs[runId]) throw safe.failure('run_unknown');
      await this._update(state => {
        state.runs[runId].retired = true; state.runs[runId].manifest = []; state.runs[runId].reducer = null;
        for (const [key, op] of Object.entries(state.operations)) if (op.runId === runId) delete state.operations[key];
        for (const [key, op] of Object.entries(state.invocations)) if (op.runId === runId) delete state.invocations[key];
        for (const delivery of Object.values(state.deliveries)) if (delivery.runId === runId) delivery.retired = true;
      }, 'retire');
      for (const [key, reservation] of this.reservations) if (reservation.runId === runId) this.reservations.delete(key);
    });
  }
  async _expire() {
    const now = Date.parse(this.clock.utc());
    if (Object.values(this.state.runs).some(r => !r.retired && now - r.createdMs > this.options.dedupRetentionMs)) {
      const state = clone(this.state);
      for (const [runId, run] of Object.entries(state.runs)) if (!run.retired && now - run.createdMs > this.options.dedupRetentionMs) {
        run.retired = true; run.manifest = []; run.reducer = null;
        for (const [key, operation] of Object.entries(state.operations)) if (operation.runId === runId) delete state.operations[key];
        for (const [key, invocation] of Object.entries(state.invocations)) if (invocation.runId === runId) delete state.invocations[key];
        for (const delivery of Object.values(state.deliveries)) if (delivery.runId === runId) delivery.retired = true;
      }
      await this._io(() => this._commit(state, 'expire'));
    }
  }
  async _retain() {
    const segments = await this.storage.segments();
    let bytes = segments.reduce((sum, segment) => sum + segment.bytes, 0);
    const now = Date.parse(this.clock.utc());
    for (const segment of segments) {
      if (bytes <= this.options.metadataBytes / 2 && now - segment.mtimeMs <= this.options.retentionMs) break;
      await this.storage.remove(segment.name);
      bytes -= segment.bytes;
      const first = Number(segment.name.slice(8, 20));
      const next = segments[segments.indexOf(segment) + 1];
      const last = next ? Number(next.name.slice(8, 20)) - 1 : this.state.seq;
      this.gaps = mergeGaps([...this.gaps, [first, last]]);
      this.events = this.events.filter(event => event.seq < first || event.seq > last);
    }
  }
  async _scan(repairTail = false) {
    const events = []; const gaps = []; const unknownRanges = [...(this.state.corruptionRanges || [])];
    const segments = await this.storage.segments();
    for (const segment of segments) {
      const first = Number(segment.name.slice(8, 20));
      const next = segments[segments.indexOf(segment) + 1];
      const last = next ? Number(next.name.slice(8, 20)) - 1 : this.state.seq;
      const bytes = await this.storage.read(segment.name);
      const complete = bytes.lastIndexOf(10) + 1;
      if (complete < bytes.length) {
        unknownRanges.push([first, last]);
        if (repairTail && segment === segments.at(-1)) await this.storage.truncate(segment.name, complete);
      }
      for (const line of bytes.subarray(0, complete).toString('utf8').split('\n').filter(Boolean)) {
        try {
          if (Buffer.byteLength(line) > this.options.recordBytes) throw safe.failure('record_corrupt');
          const item = JSON.parse(line);
          if (!item.event || !safe.equalMac(item.mac, safe.mac(this.key, item.event))) throw safe.failure('record_corrupt');
          const event = item.event;
          if (!Number.isSafeInteger(event.seq) || event.seq < 1 || event.seq > this.state.seq) throw safe.failure('record_corrupt');
          safe.id(event.runId);
          if (event.schema !== 'muse.journal.v1') { events.push({ schema: 'unknown', seq: event.seq, runId: event.runId, producer: 'unknown', kind: 'unknown', safePayload: {} }); unknownRanges.push([event.seq, event.seq]); }
          else events.push(event);
        } catch (error) { unknownRanges.push([first, last]); }
      }
    }
    events.sort((a, b) => a.seq - b.seq);
    const unique = []; let previous = 0;
    for (const event of events) {
      if (event.seq <= previous) { unknownRanges.push([event.seq, event.seq]); continue; }
      if (event.seq > previous + 1) gaps.push([previous + 1, event.seq - 1]);
      unique.push(event); previous = event.seq;
    }
    if (previous < this.state.seq) gaps.push([previous + 1, this.state.seq]);
    this.events = unique; this.gaps = mergeGaps(gaps); this.unknownRanges = mergeGaps(unknownRanges);
    if (this.unknownRanges.length > 512) this.unknownRanges = [[1, this.state.seq]];
    if (JSON.stringify(this.state.corruptionRanges || []) !== JSON.stringify(this.unknownRanges)) {
      const state = clone(this.state); state.corruptionRanges = this.unknownRanges;
      await this._commit(state, 'corruption');
    }
    await this._retain();
  }
  integrity(runId, highWater = this.state.seq) {
    const start = runId ? this.state.runs[runId]?.startSeq || 1 : 1;
    const intersects = ([a, b]) => b >= start && a <= highWater;
    return this.unknownRanges.some(intersects) ? 'unknown' : this.gaps.some(intersects) ? 'gapped' : 'complete';
  }
  async recover() {
    return this._serial(async () => {
      await this._io(() => this._scan(true));
      const unfinishedActionIds = [];
      for (const operation of Object.values(this.state.operations)) if (!operation.receipt) { operation.recovered = true; unfinishedActionIds.push(operation.actionId); }
      for (const invocation of Object.values(this.state.invocations)) if (!invocation.receipt) invocation.recovered = true;
      return { unfinishedActionIds, gaps: clone(this.gaps), integrity: this.integrity() };
    });
  }
  async startupReview() {
    return this._serial(async () => {
      const throughSeq = this.state.startupReviewedThroughSeq || 0;
      const actions = Object.values(this.state.operations).filter(op => op.attempts.some(a => a.intentSeq > throughSeq) &&
        (!op.receipt || ['unknown', 'partial_verified'].includes(op.receipt.effect))).map(op => ({
        runId: op.runId, actionId: op.actionId, execution: op.receipt?.execution || 'unfinished',
        effect: op.receipt?.effect || 'unknown', target: clone(op.summary.target),
      }));
      return { throughSeq: this.state.seq, integrity: this.integrity(), actions };
    });
  }
  // Main-local acknowledgement starts a new task; it never verifies an old effect.
  async acknowledgeStartupReview(throughSeq) {
    return this._serial(async () => {
      if (!Number.isSafeInteger(throughSeq) || throughSeq < 0 || throughSeq > this.state.seq) throw safe.failure('invalid_request');
      await this._update(state => { state.startupReviewedThroughSeq = Math.max(state.startupReviewedThroughSeq || 0, throughSeq); }, 'startup_review');
    });
  }
  _cursor(value) {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return body + '.' + createHmac('sha256', this.key).update('cursor:' + body).digest('hex');
  }
  _decodeCursor(cursor, runId) {
    if (typeof cursor !== 'string' || cursor.length > 1024) throw safe.failure('cursor_invalid');
    const [body, mac, extra] = cursor.split('.');
    if (extra || !safe.equalMac(mac, createHmac('sha256', this.key).update('cursor:' + body).digest('hex'))) throw safe.failure('cursor_invalid');
    const value = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (value.runId !== runId || !Number.isSafeInteger(value.next) || !Number.isSafeInteger(value.highWater) || value.next < 1 || value.highWater > this.state.seq || value.next > value.highWater + 1) throw safe.failure('cursor_invalid');
    return value;
  }
  async read({ runId, cursor, limit = 50, maxBytes = 32768 }) {
    return this._serial(async () => {
      safe.id(runId);
      await this._io(() => this._scan());
      const page = { events: [], earliestSeq: this.events[0]?.seq || this.state.seq + 1, highWaterSeq: this.state.seq, more: false, gaps: clone(this.gaps), integrity: this.integrity(runId) };
      let seek = { runId, next: 1, highWater: this.state.seq };
      try { if (cursor) seek = this._decodeCursor(cursor, runId); }
      catch (error) { page.integrity = 'unknown'; page.failure = safe.failure('cursor_invalid').failure; return page; }
      page.highWaterSeq = seek.highWater;
      const runStart = this.state.runs[runId]?.startSeq || 1;
      page.integrity = this.integrity(runId, seek.highWater);
      page.gaps = page.gaps.filter(([start, end]) => start <= seek.highWater && end >= runStart).map(([start, end]) => [Math.max(start, runStart), Math.min(end, seek.highWater)]);
      if (cursor && seek.next < page.earliestSeq) { page.integrity = 'gapped'; page.failure = safe.failure('cursor_expired').failure; return page; }
      const count = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 50));
      const cap = Math.max(1024, Math.min(32768, Number.isSafeInteger(maxBytes) ? maxBytes : 32768));
      if (Buffer.byteLength(JSON.stringify(page)) > cap) return { events: [], earliestSeq: page.earliestSeq, highWaterSeq: page.highWaterSeq, more: false, gaps: [], omittedGaps: page.gaps.length, integrity: 'unknown', failure: safe.failure('result_overflow').failure };
      const matching = this.events.filter(event => event.runId === runId && event.seq >= seek.next && event.seq <= seek.highWater);
      for (const event of matching) {
        const candidate = { ...page, events: [...page.events, event], more: true, nextCursor: this._cursor({ ...seek, next: event.seq + 1 }) };
        if (page.events.length >= count || Buffer.byteLength(JSON.stringify(candidate)) > cap) break;
        page.events.push(clone(event));
      }
      page.more = page.events.length < matching.length;
      if (page.more && !page.events.length) { page.failure = safe.failure('result_overflow').failure; page.integrity = 'unknown'; }
      else if (page.more) page.nextCursor = this._cursor({ ...seek, next: page.events.at(-1).seq + 1 });
      return page;
    });
  }
  async flush(budget) {
    try { await this._serial(() => this._io(() => this.storage.syncDirectory(), budget ? budget.deadlineMonoMs - this.clock.now() : undefined)); }
    catch (error) { this._degrade('journal_sync_failed'); }
    return clone(this.status);
  }
  async close() {
    await this.queue;
    this.closed = true;
    // Never unlock a hung writer: it could still replace a ledger after another writer starts.
    if (!this.hung) await this.storage.close();
  }
}
function mergeGaps(gaps) {
  const out = [];
  for (const [start, end] of gaps.filter(([a, b]) => a <= b).sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

module.exports = { ReceiptJournal, FileJournalStorage, ...require('./projection.cjs') };
Object.defineProperty(module.exports, 'RunReducer', { enumerable: true, get: () => require('./reducer.cjs').RunReducer });
