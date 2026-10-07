'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BrowserController } = require('../../src/computer/browser/index.cjs');
const { startFixture } = require('../computer-browser/fixture.cjs');
const { context, policy } = require('../computer-browser/helpers.cjs');
const { normalizeBrowserEvidence } = require('../../src/computer/state/index.cjs');

test('current browser summary reads visible main content before hidden navigation', { skip: process.env.MUSE_BROWSER_REAL !== '1', timeout: 30000 }, async () => {
  const fixture = await startFixture();
  const controller = new BrowserController({ policy, fixtureOrigins: [fixture.origin] });
  try {
    const readyUntil = Date.now() + 10000;
    while (!await fixture.evaluate('document.readyState === "complete" && !!window.fixture')) {
      if (Date.now() >= readyUntil) throw new Error('owned fixture did not finish initial navigation');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await fixture.evaluate(`document.body.innerHTML = '<nav><h1 hidden>Stale destination</h1><div style="display:none">'+ 'HIDDEN_NAV '.repeat(400)+'</div><span>Global navigation</span></nav><main><h1>Current order status</h1><p>Out for delivery</p><span aria-hidden="true">PRIVATE_HIDDEN</span><a role="button" href="/tracking?sample=1" target="_blank">Track package</a><a href="javascript:alert(1)">Script</a><a href="https://user:secret@example.com">Credentials</a></main>'; true`);
    await fixture.evaluate(`document.querySelector('main h1').insertAdjacentHTML('beforeend','<span hidden>STALE_SECRET</span><span aria-hidden="true">HIDDEN_ALIAS</span>'); true`);
    await fixture.evaluate(`document.querySelector('main h1').setAttribute('aria-label','Accessible alias'); true`);
    await fixture.evaluate(`document.querySelector('main').insertAdjacentHTML('beforeend','<h2>Visible shipping<span hidden>STALE_LABEL</span></h2>'); true`);
    assert.equal((await controller.connect({ mode: 'chrome_consent', endpoint: fixture.endpoint }, context())).state, 'connected');
    const [choice] = await controller.listForLocalPicker(context());
    const lease = await controller.attach(choice.selectionToken, context());
    const observed = await controller.observe({ lease, sources: ['dom'] }, context());
    const document = observed.state.evidence.flatMap(e => e.facts).find(f => f.predicate === 'document').value;
    assert.deepEqual(document.headings, ['Current order status', 'Visible shipping']);
    assert.match(document.textExcerpt, /Out for delivery/);
    assert.doesNotMatch(document.textExcerpt, /HIDDEN_NAV|PRIVATE_HIDDEN|Global navigation|Stale destination|STALE_SECRET|HIDDEN_ALIAS/);
    assert(observed.refs.elements.length > 0);
    const elements = observed.state.evidence.flatMap(e => e.facts).find(f => f.predicate === 'elements').value;
    assert.deepEqual(elements.find(e => e.name === 'Track package').navigation, { url: fixture.origin + '/tracking?sample=1', target: '_blank' });
    assert.equal(elements.find(e => e.name === 'Script').navigation, undefined);
    assert.equal(elements.find(e => e.name === 'Credentials').navigation, undefined);
    const heading = elements.find(e => e.role === 'heading' && e.states.visible);
    assert.equal(heading.name, 'Accessible alias');
    assert.equal(heading.headingText, 'Current order status');
    assert(elements.some(e => e.role === 'heading' && e.name === 'Visible shipping'));
    const normalized = normalizeBrowserEvidence(observed.state.evidence[0], { refs: observed.refs.elements });
    assert(normalized.facts.some(f => f.predicate === 'document.heading' && f.value.text === 'Current order status'));
    assert(!normalized.facts.some(f => f.predicate === 'document.heading' && /STALE_SECRET|HIDDEN_ALIAS|Accessible alias|STALE_LABEL/.test(f.value.text)));
  } finally { await controller.detach().catch(() => {}); await fixture.close(); }
});
