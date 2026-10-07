const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isMuseUrl, isAppNavigation, isExternalUrl, browserUserAgent, permissionLabel } = require('../src/policy.cjs');

test('Muse trust checks reject impersonation, insecure URLs and credential-bearing URLs', () => {
  for (const url of ['https://muse.ai/', 'https://auth.muse.ai/oidc/muse/']) assert.equal(isMuseUrl(url), true);
  for (const url of ['https://muse.ai.attacker.test', 'https://attacker.test/muse.ai', 'http://muse.ai', 'https://muse.ai:8443', 'https://user:secret@muse.ai/', 'javascript:alert(1)', 'file:///etc/passwd']) assert.equal(isMuseUrl(url), false, url);
});

test('authentication can stay in-app while unrelated destinations leave it', () => {
  for (const url of ['https://auth.meta.com/oidc', 'https://accounts.google.com/o/oauth2/auth', 'https://muse.ai/oidc/callback']) assert.equal(isAppNavigation(url), true);
  for (const url of ['https://auth.meta.com.attacker.test', 'https://example.com/', 'https://www.facebook.com:444/']) assert.equal(isAppNavigation(url), false);
});

test('external opening excludes local files, executable schemes and URL credentials', () => {
  assert.equal(isExternalUrl('https://example.com/report'), true);
  for (const url of ['file:///tmp/a', 'javascript:alert(1)', 'data:text/html,a', 'https://user:password@example.com', 'not a URL']) assert.equal(isExternalUrl(url), false);
});

test('the browser agent retains the real Linux Chromium version', () => {
  const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 muse-linux/0.1.0 Chrome/152.0.0.0 Electron/44.5.1 Safari/537.36';
  assert.equal(browserUserAgent(ua), 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36');
});

test('only known media capabilities get an explicit permission request', () => {
  assert.equal(permissionLabel('media', { mediaTypes: ['audio'] }), 'use your microphone');
  assert.equal(permissionLabel('media', { mediaTypes: ['video'] }), 'use your camera and microphone');
  assert.equal(permissionLabel('media', { mediaTypes: ['unknown'] }), null);
  assert.equal(permissionLabel('media'), null);
  assert.equal(permissionLabel('display-capture'), null);
  assert.equal(permissionLabel('usb'), null);
});
