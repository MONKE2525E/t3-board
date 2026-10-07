const HOME_URL = 'https://muse.ai/';
const AUTH_HOSTS = new Set([
  'auth.muse.ai', 'auth.meta.com', 'accountscenter.meta.com',
  'www.facebook.com', 'facebook.com', 'www.instagram.com',
  'accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com',
]);

function parseWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function isMuseUrl(value) {
  const url = parseWebUrl(value);
  return Boolean(url && (url.hostname === 'muse.ai' || url.hostname.endsWith('.muse.ai')) && (!url.port || url.port === '443'));
}

function isAppNavigation(value) {
  const url = parseWebUrl(value);
  return Boolean(url && (!url.port || url.port === '443') && (isMuseUrl(value) || AUTH_HOSTS.has(url.hostname)));
}

function isExternalUrl(value) {
  return Boolean(typeof value === 'string' && value.length <= 8192 && parseWebUrl(value));
}

function browserUserAgent(value) {
  return value.replace(/\sElectron\/\S+/g, '').replace(/\smuse-linux\/\S+/gi, '').replace(/\sMuse-for-Linux\/\S+/gi, '');
}

function permissionLabel(permission, details = {}) {
  if (permission === 'notifications') return 'show desktop notifications';
  if (permission === 'clipboard-read') return 'read your clipboard';
  if (permission === 'geolocation') return 'use your location';
  if (permission === 'media') {
    const types = details.mediaTypes || [];
    if (!types.length || types.some(type => !['audio', 'video'].includes(type))) return null;
    return types.includes('video') ? 'use your camera and microphone' : 'use your microphone';
  }
  return null;
}

module.exports = { HOME_URL, isMuseUrl, isAppNavigation, isExternalUrl, browserUserAgent, permissionLabel };
