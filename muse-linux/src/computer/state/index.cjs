const { CaptureCoordinator } = require('./capture.cjs');
const { Reconciler, evidenceHeader } = require('./reconciler.cjs');
const { RefStore } = require('./refs.cjs');
const { AssertionRegistry, BUILTINS } = require('./assertions.cjs');
const { wrapLegacyObservation, evidenceFromTextRead, adapterEvidenceProvider, normalizeAdapterEvidence, normalizeBrowserEvidence, normalizeDesktopEvidence, normalizeAdapterReceipt, expectationsForOperation } = require('./normalization.cjs');
const { assertTransform, transformPoint } = require('./coordinates.cjs');
const { eligibility, exhaustive, assertEvidence } = require('./evidence.cjs');

module.exports = { CaptureCoordinator, Reconciler, RefStore, AssertionRegistry, BUILTINS,
  evidenceHeader, wrapLegacyObservation, evidenceFromTextRead, adapterEvidenceProvider, normalizeAdapterEvidence,
  normalizeBrowserEvidence, normalizeDesktopEvidence, normalizeAdapterReceipt, expectationsForOperation,
  assertTransform, transformPoint, eligibility, exhaustive, assertEvidence };
