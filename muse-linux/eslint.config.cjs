const rules = { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }], 'no-undef': 'error' };
const nodeGlobals = {
  require: 'readonly', module: 'readonly', exports: 'readonly', __dirname: 'readonly', __filename: 'readonly',
  process: 'readonly', Buffer: 'readonly', console: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', clearImmediate: 'readonly', queueMicrotask: 'readonly',
  fetch: 'readonly', AbortSignal: 'readonly', AbortController: 'readonly', WebSocket: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly', crypto: 'readonly', performance: 'readonly',
  structuredClone: 'readonly', atob: 'readonly', btoa: 'readonly',
};
const browserGlobals = {
  window: 'readonly', document: 'readonly', location: 'readonly', navigator: 'readonly', console: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', requestIdleCallback: 'readonly',
  cancelIdleCallback: 'readonly', queueMicrotask: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  fetch: 'readonly', AbortSignal: 'readonly', AbortController: 'readonly', Event: 'readonly', CustomEvent: 'readonly',
  MutationObserver: 'readonly', ResizeObserver: 'readonly', IntersectionObserver: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly', matchMedia: 'readonly', getComputedStyle: 'readonly',
  crypto: 'readonly', atob: 'readonly', btoa: 'readonly', Image: 'readonly', Blob: 'readonly', File: 'readonly',
  FileReader: 'readonly', FormData: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
  HTMLElement: 'readonly', Node: 'readonly', customElements: 'readonly', CSS: 'readonly',
};
module.exports = [
  { files: ['**/*.cjs'], languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: nodeGlobals }, rules },
  { files: ['src/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: browserGlobals }, rules },
];
