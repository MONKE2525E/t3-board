'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { failure } = require('./safe.cjs');

/** Main-private filesystem adapter. fault(point) is an optional test-only hook. */
class FileJournalStorage {
  constructor({ directory, fault = async () => {}, maxBytes = 32 * 1024 * 1024 } = {}) {
    if (!directory || !path.isAbsolute(directory)) throw failure('unsafe_path');
    this.directory = path.resolve(directory);
    this.fault = fault;
    this.maxBytes = maxBytes;
    this.lock = undefined;
  }
  file(name) {
    if (!/^(ledger\.json|key|reserve\.bin|writer\.lock|segment-\d{12}\.jsonl|tmp-[a-f0-9-]+)$/.test(name)) throw failure('unsafe_path');
    return path.join(this.directory, name);
  }
  async checkDirectory() {
    // Check each ancestor. realpath alone would accept a symlink supplied by a caller.
    let current = path.parse(this.directory).root;
    for (const part of this.directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { const stat = await fs.lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('unsafe_path'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await fs.mkdir(current, { mode: 0o700 }); }
    }
    const stat = await fs.lstat(this.directory);
    if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw failure('unsafe_path');
  }
  async open() {
    await this.checkDirectory();
    const lockPath = this.file('writer.lock');
    try { this.lock = await fs.open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = JSON.parse((await this.read('writer.lock')).toString());
      // A stale lock can be removed only after the original process lifetime ended.
      let alive = true;
      try { alive = await processToken(owner.pid) === owner.startToken; }
      catch (cause) { if (cause.code === 'ENOENT' || cause.code === 'ESRCH') alive = false; else throw failure('writer_busy'); }
      if (alive) throw failure('writer_busy');
      await fs.unlink(lockPath);
      this.lock = await fs.open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    }
    this.lockToken = randomUUID();
    await this.lock.writeFile(JSON.stringify({ pid: process.pid, startToken: await processToken(process.pid), token: this.lockToken }));
    await this.lock.sync();
    await this.syncDirectory();
    const names = await fs.readdir(this.directory);
    for (const name of names.filter(n => /^tmp-[a-f0-9-]+$/.test(n))) {
      await this.assertFile(name);
      await fs.unlink(this.file(name));
    }
    const keyExists = names.includes('key');
    this.fresh = !keyExists;
    if (!keyExists && names.some(n => n === 'ledger.json' || n.startsWith('segment-'))) throw failure('key_missing');
    if (!keyExists) await this.atomicWrite('key', randomBytes(32), 'key');
    const key = await this.read('key');
    if (key.length !== 32) throw failure('key_invalid');
    return key;
  }
  async assertFile(name) {
    const stat = await fs.lstat(this.file(name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw failure('unsafe_path');
    if (stat.size > this.maxBytes) throw failure('journal_full');
    return stat;
  }
  async read(name) {
    await this.assertFile(name);
    const handle = await fs.open(this.file(name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return await handle.readFile(); } finally { await handle.close(); }
  }
  async syncDirectory() {
    const directory = await fs.open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async atomicWrite(name, data, purpose = 'ledger') {
    if (Buffer.byteLength(data) > this.maxBytes) throw failure('journal_full');
    const temporary = 'tmp-' + randomUUID();
    let handle;
    try {
      try { await this.assertFile(name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      handle = await fs.open(this.file(temporary), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await this.fault(purpose + ':write');
      await handle.writeFile(data);
      await this.fault(purpose + ':sync');
      await handle.sync();
      await handle.close(); handle = undefined;
      await this.fault(purpose + ':rename');
      await fs.rename(this.file(temporary), this.file(name));
      await this.fault(purpose + ':directory_sync');
      await this.syncDirectory();
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(this.file(temporary)).catch(() => {});
    }
  }
  async append(name, data) {
    let created = false;
    try { await this.assertFile(name); } catch (error) { if (error.code !== 'ENOENT') throw error; created = true; }
    const handle = await fs.open(this.file(name), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await this.fault('diagnostic:write'); await handle.writeFile(data); await this.fault('diagnostic:sync'); await handle.sync(); }
    finally { await handle.close(); }
    if (created) await this.syncDirectory();
  }
  async reserve(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes / 2) throw failure('journal_full');
    let created = false;
    try { await this.assertFile('reserve.bin'); } catch (error) { if (error.code !== 'ENOENT') throw error; created = true; }
    const handle = await fs.open(this.file('reserve.bin'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const previous = (await handle.stat()).size;
      if (bytes < previous) await handle.truncate(bytes);
      else {
        const block = Buffer.alloc(Math.min(65536, bytes - previous));
        let offset = previous;
        while (offset < bytes) {
          await this.fault('reserve:write');
          const result = await handle.write(block, 0, Math.min(block.length, bytes - offset), offset);
          if (!result.bytesWritten) throw failure('journal_write_failed');
          offset += result.bytesWritten;
        }
      }
      await handle.sync();
    } finally { await handle.close(); }
    if (created) await this.syncDirectory();
  }
  async segments() {
    const names = (await fs.readdir(this.directory)).filter(n => /^segment-\d{12}\.jsonl$/.test(n)).sort();
    const out = [];
    for (const name of names) { const stat = await this.assertFile(name); out.push({ name, bytes: stat.size, mtimeMs: stat.mtimeMs }); }
    return out;
  }
  async remove(name) { await this.assertFile(name); await fs.unlink(this.file(name)); await this.syncDirectory(); }
  async truncate(name, bytes) {
    await this.assertFile(name);
    const handle = await fs.open(this.file(name), constants.O_WRONLY | constants.O_NOFOLLOW);
    try { await handle.truncate(bytes); await handle.sync(); } finally { await handle.close(); }
  }
  async close() {
    if (!this.lock) return;
    await this.lock.close(); this.lock = undefined;
    const owner = JSON.parse((await this.read('writer.lock')).toString());
    if (owner.token !== this.lockToken) throw failure('writer_busy');
    await fs.unlink(this.file('writer.lock'));
    await this.syncDirectory();
  }
}
async function processToken(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw failure('writer_busy');
  const text = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
  return text.slice(text.lastIndexOf(')') + 2).split(' ')[19];
}
module.exports = { FileJournalStorage };
