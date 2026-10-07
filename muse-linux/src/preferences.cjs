const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const POLICY = new Set(['ask', 'allow', 'deny']);
const THEMES = new Set(['system', 'light', 'dark']);
const LANGUAGES = new Set(['auto', 'en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ru', 'ar', 'hi', 'nl', 'pl', 'uk']);
const SHORTCUT = /^(?:(?:Control|Ctrl|Alt|Shift|Super|Meta)\+){1,4}(?:[A-Z0-9]|Space|F(?:[1-9]|1[0-2]))$/;
const ID = /^[a-f0-9-]{36}$/;

const defaults = {
  browserPolicy: 'deny',
  desktopPolicy: 'ask',
  commandPolicy: 'deny',
  fileWritePolicy: 'ask',
  folder: null,
  rememberFolder: true,
  dictationEnabled: false,
  dictationLanguage: 'auto',
  dictationAutoSend: false,
  theme: 'system',
  quickShortcut: '',
  dictationShortcut: '',
  startAtLogin: false,
  blockedApps: [],
  keepAwake: false,
};

const policyKeys = ['browserPolicy', 'desktopPolicy', 'commandPolicy', 'fileWritePolicy'];

function cloneValues(source = defaults) {
  return { ...source, blockedApps: [...(source.blockedApps || [])] };
}

class Preferences {
  constructor(file) {
    this.file = file;
    this.id = randomUUID();
    this.values = cloneValues();
    this.queue = Promise.resolve();
  }

  enqueue(operation) {
    const run = this.queue.catch(() => {}).then(operation);
    this.queue = run;
    return run;
  }

  async load() {
    return this.enqueue(async () => {
      let stored = null;
      try {
        const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
      } catch {}

      this.id = ID.test(stored?.id || '') ? stored.id : randomUUID();
      this.values = cloneValues();

      if (stored) {
        for (const key of Object.keys(defaults)) {
          if (!Object.hasOwn(stored, key)) continue;
          try {
            this.validate(key, stored[key]);
            this.values[key] = key === 'blockedApps' ? [...stored[key]] : stored[key];
          } catch {}
        }
        if (!Object.hasOwn(stored, 'browserPolicy')) {
          this.values.browserPolicy = stored.browserEnabled === true
            ? (stored.browserAutoApprove === true ? 'allow' : 'ask')
            : 'deny';
        }
        if (stored.rememberFolder !== true) this.values.folder = null;
      }

      if (this.values.folder) {
        try {
          if (await fs.realpath(this.values.folder) !== this.values.folder) this.values.folder = null;
        } catch { this.values.folder = null; }
      }

      await this.writeSnapshot(this.snapshot());
      return this.values;
    });
  }

  validate(key, value) {
    if (!Object.hasOwn(defaults, key)) throw Error('unknown_setting');
    if (policyKeys.includes(key)) {
      if (!POLICY.has(value)) throw Error('invalid_permission');
      return;
    }
    if (key === 'theme') {
      if (!THEMES.has(value)) throw Error('invalid_theme');
      return;
    }
    if (key === 'folder') {
      if (value !== null && (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))) {
        throw Error('invalid_folder');
      }
      return;
    }
    if (key === 'blockedApps') {
      if (!Array.isArray(value) || value.length > 100 || value.some(x => typeof x !== 'string' || x.length > 200 || /[\x00-\x1f]/.test(x))) {
        throw Error('invalid_app_list');
      }
      return;
    }
    if (key === 'dictationLanguage') {
      if (!LANGUAGES.has(value)) throw Error('invalid_language');
      return;
    }
    if (key === 'quickShortcut' || key === 'dictationShortcut') {
      if (typeof value !== 'string' || value.length > 80 || (value && !SHORTCUT.test(value))) {
        throw Error('invalid_shortcut');
      }
      return;
    }
    if (typeof defaults[key] === 'boolean') {
      if (typeof value !== 'boolean') throw Error('invalid_setting');
      return;
    }
    throw Error('invalid_setting');
  }

  async set(key, value) {
    this.validate(key, value);
    this.values[key] = key === 'blockedApps' ? [...value] : value;
    await this.save();
  }

  snapshot() {
    return {
      id: this.id,
      ...this.values,
      blockedApps: [...this.values.blockedApps],
      folder: this.values.rememberFolder === true ? this.values.folder : null,
      browserEnabled: this.values.browserPolicy !== 'deny',
      browserAutoApprove: this.values.browserPolicy === 'allow',
    };
  }

  save() {
    const snapshot = this.snapshot();
    return this.enqueue(() => this.writeSnapshot(snapshot));
  }

  async writeSnapshot(snapshot) {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.${randomUUID()}.new`;
    try {
      await fs.writeFile(temp, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
      await fs.chmod(temp, 0o600);
      const handle = await fs.open(temp, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, this.file);
    } catch (error) {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
  }
}

module.exports = { Preferences, defaults };
