const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const forbidden = /^(?:\.ssh|\.gnupg|\.aws|\.kube|\.config|\.local|\.git|\.npmrc|\.netrc|\.env(?:\..*)?|credentials(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;
const limit = 256 * 1024;
const binaryLimit = 8 * 1024 * 1024;
const copyLimit = 32 * 1024 * 1024;
const searchDepth = 8;
const searchFiles = 2000;
const searchResults = 50;
const searchMs = 2500;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW;

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function blocked(target) {
  return target.split(path.sep).some(part => part && forbidden.test(part));
}

function literalHas(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function endpoints(args) {
  return { from: args.from || args.path, to: args.to || args.destination };
}

function pathList(args) {
  if (typeof args.paths === 'string') {
    let parsed;
    try { parsed = JSON.parse(args.paths); } catch (e) { throw Error(`paths_required: JSON array of absolute paths (${e.message})`); }
    if (!Array.isArray(parsed)) throw Error('paths_required: JSON array of absolute paths');
    return parsed;
  }
  if (Array.isArray(args.paths)) return args.paths;
  if (typeof args.path === 'string') return [args.path];
  throw Error('absolute_path_required');
}

function mapOpen(e) {
  if (e.code === 'ELOOP') throw Error('symlink_denied');
  if (e.code === 'EEXIST') throw Error('destination_exists: no overwrite performed');
  if (e.code === 'EISDIR') throw Error('regular_file_required');
  throw e;
}

class LocalFiles {
  constructor({ folder, approve, trash }) { this.folder = folder; this.approve = approve; this.trash = trash; }

  async resolve(value, write = false) {
    const root = this.folder(); if (!root) throw Error('filesystem_access_disabled: select a folder in Linux settings');
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw Error('absolute_path_required');
    const requested = path.resolve(value);
    if (!within(root, requested) || blocked(requested)) throw Error('path_denied');
    let realRoot;
    try { realRoot = await fs.realpath(root); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ELOOP') throw Error('folder_changed: select it again in Linux settings');
      throw e;
    }
    if (realRoot !== root) throw Error('folder_changed: select it again in Linux settings');
    const parent = await fs.realpath(path.dirname(requested));
    if (requested !== root && !within(root, parent)) throw Error('symlink_outside_approved_folder');
    let target = requested;
    try {
      const stat = await fs.lstat(requested);
      if (stat.isSymbolicLink()) throw Error('symlink_denied');
      target = await fs.realpath(requested);
      if (!within(root, target) || blocked(target)) throw Error('path_denied');
    } catch (e) { if (!(write && e.code === 'ENOENT')) throw e; }
    if (this.folder() !== root) throw Error('permission_revoked');
    return { root, target };
  }

  alive(root) {
    const current = this.folder();
    if (!current) throw Error('filesystem_access_disabled: select a folder in Linux settings');
    if (current !== root) throw Error('permission_revoked');
  }

  async confirm(pathValue, description, write = false) {
    const before = await this.resolve(pathValue, write);
    if (!await this.approve(before.target, description)) throw Error('permission_denied');
    const after = await this.resolve(pathValue, write);
    if (before.root !== after.root || before.target !== after.target) throw Error('permission_revoked');
    return after;
  }

  async open(target, flags, mode) {
    try { return await fs.open(target, flags, mode); } catch (e) { mapOpen(e); }
  }

  async regular(target) {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw Error('symlink_denied');
    if (!stat.isFile()) throw Error('regular_file_required');
    return stat;
  }

  async stat(args) {
    const { target } = await this.resolve(args.path);
    const s = await fs.lstat(target);
    if (s.isSymbolicLink()) throw Error('symlink_denied');
    return { path:target, type:s.isDirectory()?'directory':s.isFile()?'file':'other', size_bytes:s.size, modified_at:s.mtime.toISOString() };
  }

  async mkdir(args) {
    const after = await this.confirm(args.path, 'Create a folder', true);
    await fs.mkdir(after.target, { mode:0o700 });
    return { ok:true, path:after.target };
  }

  async move(args) {
    const { from: srcPath, to: dstPath } = endpoints(args);
    const from = await this.resolve(srcPath), to = await this.resolve(dstPath, true);
    if (from.target === from.root || to.target === to.root) throw Error('cannot_move_granted_root');
    if (!await this.approve(from.target, `Move to ${to.target}`)) throw Error('permission_denied');
    const again = await this.resolve(srcPath), next = await this.resolve(dstPath, true);
    if (from.root !== again.root || to.root !== next.root || from.target !== again.target || to.target !== next.target) throw Error('permission_revoked');
    try { await fs.lstat(next.target); throw Error('destination_exists: no overwrite performed'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await this.regular(again.target);
    try { await fs.link(again.target, next.target); } catch (e) {
      if (e.code === 'EXDEV') throw Error('same_filesystem_required: cannot move across devices');
      if (e.code === 'EEXIST') throw Error('destination_exists: no overwrite performed');
      throw e;
    }
    try { await fs.unlink(again.target); } catch (e) {
      await fs.unlink(next.target).catch(cleanup => { if (cleanup) throw e; });
      throw e;
    }
    return { ok:true, path:next.target, from_path:again.target, to_path:next.target };
  }

  async copy(args) {
    const { from: srcPath, to: dstPath } = endpoints(args);
    const from = await this.resolve(srcPath), to = await this.resolve(dstPath, true);
    if (from.target === from.root || to.target === to.root) throw Error('cannot_copy_granted_root');
    if (!await this.approve(from.target, `Copy to ${to.target}`)) throw Error('permission_denied');
    const again = await this.resolve(srcPath), next = await this.resolve(dstPath, true);
    if (from.root !== again.root || to.root !== next.root || from.target !== again.target || to.target !== next.target) throw Error('permission_revoked');
    await this.regular(again.target);
    const src = await this.open(again.target, READ);
    let dest, copied = 0;
    try {
      const s = await src.stat();
      if (!s.isFile() || s.size > copyLimit) throw Error('regular_file_required: maximum copy size 32 MiB');
      this.alive(again.root);
      dest = await this.open(next.target, WRITE_NEW, 0o600);
      try {
        const bytes = Buffer.alloc(s.size + 1);
        const { bytesRead } = await src.read(bytes, 0, bytes.length, 0);
        if (bytesRead > s.size) throw Error('file_changed_or_permission_revoked');
        await dest.write(bytes, 0, bytesRead, 0);
        await dest.sync();
        copied = bytesRead;
      } catch (e) {
        await dest.close().catch(closeErr => { if (closeErr) { /* dest still unlinked below */ } });
        dest = null;
        await fs.unlink(next.target).catch(unlinkErr => { if (unlinkErr && unlinkErr.code !== 'ENOENT') throw e; });
        throw e;
      }
    } finally {
      await src.close().catch(closeErr => { if (closeErr) { /* source fd released on process exit */ } });
      if (dest) await dest.close().catch(closeErr => { if (closeErr) { /* dest fd released on process exit */ } });
    }
    return { ok:true, path:next.target, from_path:again.target, to_path:next.target, size_bytes:copied };
  }

  async remove(args) {
    const paths = pathList(args);
    if (paths.length < 1 || paths.length > 32 || paths.some(item => typeof item !== 'string')) throw Error('invalid_paths');
    if (paths.length === 1) return this.removeOne(paths[0]);
    const results = [];
    for (const item of paths) {
      try { results.push(await this.removeOne(item)); }
      catch (e) {
        if (/filesystem_access_disabled|permission_revoked|folder_changed/.test(e.message)) throw e;
        results.push({ ok:false, path:item, error:String(e.message).slice(0,200) });
      }
    }
    const removed = results.filter(item => item.ok).length;
    return { ok:removed > 0, requested_count:paths.length, removed_count:removed, failed_count:paths.length - removed, results };
  }

  async removeOne(filePath) {
    const before = await this.resolve(filePath);
    if (before.target === before.root || typeof this.trash !== 'function') throw Error('trash_unavailable');
    await this.regular(before.target);
    if (!await this.approve(before.target, 'Move this file to Trash')) throw Error('permission_denied');
    const after = await this.resolve(filePath);
    if (before.root !== after.root || before.target !== after.target) throw Error('permission_revoked');
    await this.regular(after.target);
    await this.trash(after.target);
    return { ok:true, path:after.target, trashed:true };
  }

  async export(args) {
    const { root, target } = await this.resolve(args.path);
    const handle = await this.open(target, READ);
    try {
      const s = await handle.stat(); if (!s.isFile() || s.size > binaryLimit) throw Error('regular_file_required: maximum export size 8 MiB');
      const bytes = Buffer.alloc(s.size + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > s.size || this.folder() !== root) throw Error('file_changed_or_permission_revoked');
      const filename = path.basename(target).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'file';
      return { path:target, size_bytes:bytesRead, file_transfer:{ data_base64:bytes.subarray(0, bytesRead).toString('base64'), filename } };
    } finally { await handle.close(); }
  }

  async import(args) {
    if (typeof args.data_base64 !== 'string' || args.data_base64.length > 12 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data_base64)) throw Error('invalid_binary_data');
    const bytes = Buffer.from(args.data_base64, 'base64'); if (bytes.length > binaryLimit) throw Error('file_too_large: maximum 8 MiB');
    const after = await this.confirm(args.path, `Write ${bytes.length} bytes of binary data`, true);
    const handle = await this.open(after.target, WRITE_NEW, 0o600);
    try {
      try { await handle.writeFile(bytes); await handle.sync(); }
      catch (e) {
        await fs.unlink(after.target).catch(unlinkErr => { if (unlinkErr && unlinkErr.code !== 'ENOENT') throw e; });
        throw e;
      }
    } finally { await handle.close(); }
    return { ok:true, path:after.target, size_bytes:bytes.length };
  }

  async list(args = {}) {
    const { root, target } = await this.resolve(args.path || this.folder());
    const directory = await fs.opendir(target); const entries = [];
    try {
      for await (const e of directory) {
        this.alive(root);
        if (forbidden.test(e.name)) continue;
        entries.push({ name:e.name, path:path.join(target, e.name), type:e.isSymbolicLink()?'symlink (access denied)':e.isDirectory()?'directory':'file' });
        if (entries.length >= 200) return { path:target, entries, truncated:true };
      }
    } finally { await directory.close().catch(e => { if (e) { /* dir fd already closed */ } }); }
    return { path:target, entries, truncated:false };
  }

  async read(args) {
    const { root, target } = await this.resolve(args.path);
    return this.readText(root, target);
  }

  async readText(root, target) {
    const handle = await this.open(target, READ);
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > limit) throw Error('text_file_required: maximum size 256 KiB');
      const buffer = Buffer.alloc(limit + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > limit) throw Error('file_too_large');
      const bytes = buffer.subarray(0, bytesRead), content = bytes.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(bytes) || content.includes('\0')) throw Error('utf8_text_required');
      this.alive(root);
      return { path:target, content, size_bytes:bytesRead, truncated:false };
    } finally { await handle.close(); }
  }

  async write(args) {
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > limit || args.content.includes('\0')) throw Error('invalid_content: maximum 256 KiB of UTF-8 text');
    const before = await this.resolve(args.path, true);
    if (!await this.approve(before.target, args.content)) throw Error('permission_denied');
    const after = await this.resolve(args.path, true);
    if (before.root !== after.root || before.target !== after.target) throw Error('target_changed: no write performed');
    try { const existing = await fs.lstat(after.target); if (existing.isSymbolicLink()) throw Error('symlink_denied'); if (!existing.isFile()) throw Error('regular_file_required'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const handle = await this.open(after.target, WRITE, 0o600);
    try {
      const stat = await handle.stat(); if (!stat.isFile()) throw Error('regular_file_required');
      this.alive(after.root);
      await handle.truncate(0); await handle.writeFile(args.content, 'utf8'); await handle.sync();
    } finally { await handle.close(); }
    return { ok:true, path:after.target, size_bytes:Buffer.byteLength(args.content) };
  }

  async edit(args) {
    if (typeof args.old_text !== 'string' || typeof args.new_text !== 'string' || args.old_text.length < 1 || args.old_text.includes('\0') || args.new_text.includes('\0')) throw Error('invalid_edit: old_text and new_text must be UTF-8 without NUL');
    if (Buffer.byteLength(args.new_text) > limit) throw Error('invalid_content: maximum 256 KiB of UTF-8 text');
    const before = await this.resolve(args.path);
    const first = await this.readText(before.root, before.target);
    const once = first.content.indexOf(args.old_text);
    if (once < 0) throw Error('old_text_not_found');
    if (first.content.indexOf(args.old_text, once + 1) >= 0) throw Error('old_text_not_unique: include more surrounding context');
    if (!await this.approve(before.target, `Replace one unique snippet (${Buffer.byteLength(args.old_text)} -> ${Buffer.byteLength(args.new_text)} bytes)`)) throw Error('permission_denied');
    const after = await this.resolve(args.path);
    if (before.root !== after.root || before.target !== after.target) throw Error('permission_revoked');
    const again = await this.readText(after.root, after.target);
    const index = again.content.indexOf(args.old_text);
    if (index < 0 || again.content.indexOf(args.old_text, index + 1) >= 0) throw Error('target_changed: no write performed');
    const content = again.content.slice(0, index) + args.new_text + again.content.slice(index + args.old_text.length);
    if (Buffer.byteLength(content) > limit) throw Error('invalid_content: maximum 256 KiB of UTF-8 text');
    const handle = await this.open(after.target, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(); if (!stat.isFile()) throw Error('regular_file_required');
      this.alive(after.root);
      await handle.truncate(0); await handle.writeFile(content, 'utf8'); await handle.sync();
    } finally { await handle.close(); }
    return { ok:true, path:after.target, bytes_written:Buffer.byteLength(content), replacements:1 };
  }

  async search(args) {
    if (typeof args.query !== 'string' || args.query.length < 1 || args.query.length > 200 || args.query.includes('\0')) throw Error('invalid_query: 1 to 200 literal characters');
    const query = args.query;
    const cap = Math.min(searchResults, Math.max(1, Math.floor(Number(args.limit)) || searchResults));
    const { root, target } = await this.resolve(args.path || this.folder());
    const started = Date.now();
    const entries = [];
    let scanned = 0, truncated = false, reason;
    const stop = why => { truncated = true; reason = reason || why; return false; };
    const still = () => this.alive(root);
    const consider = async (filePath, name, isDirectory, size) => {
      still();
      scanned += 1;
      if (scanned > searchFiles) return stop('scan_limit');
      if (Date.now() - started > searchMs) return stop('timeout');
      const nameHit = literalHas(name, query);
      let contentHit = false, snippet;
      if (!isDirectory && size <= limit) {
        try {
          const handle = await this.open(filePath, READ);
          try {
            const buf = Buffer.alloc(Math.min(size, limit) + 1);
            const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
            if (bytesRead <= limit) {
              const bytes = buf.subarray(0, bytesRead), text = bytes.toString('utf8');
              if (Buffer.from(text, 'utf8').equals(bytes) && !text.includes('\0') && literalHas(text, query)) {
                contentHit = true;
                const at = text.toLowerCase().indexOf(query.toLowerCase());
                snippet = text.slice(Math.max(0, at - 40), Math.max(0, at - 40) + 120);
              }
            }
          } finally { await handle.close(); }
        } catch (e) { if (e.message === 'permission_revoked' || e.message.startsWith('filesystem_access_disabled')) throw e; }
      }
      if (nameHit || contentHit) {
        if (entries.length >= cap) return stop('match_limit');
        entries.push({ name, path:filePath, match:nameHit && contentHit ? 'name_and_content' : nameHit ? 'name' : 'content', is_directory:!!isDirectory, size_bytes:size, ...(snippet ? { snippet } : {}) });
      }
      return true;
    };
    const walk = async (dirPath, depth) => {
      still();
      if (truncated) return;
      if (Date.now() - started > searchMs) { stop('timeout'); return; }
      if (depth > searchDepth) { stop('depth_limit'); return; }
      let directory;
      try { directory = await fs.opendir(dirPath); } catch (e) { if (e.code === 'EACCES' || e.code === 'ENOTDIR' || e.code === 'ENOENT') return; throw e; }
      try {
        for await (const e of directory) {
          if (truncated) break;
          still();
          if (forbidden.test(e.name) || e.name === '.' || e.name === '..') continue;
          const child = path.join(dirPath, e.name);
          if (!within(root, child) || blocked(child)) continue;
          let st;
          try { st = await fs.lstat(child); } catch (e) { if (e.code === 'ENOENT' || e.code === 'EACCES') continue; throw e; }
          if (st.isSymbolicLink()) continue;
          if (st.isDirectory()) {
            if (!await consider(child, e.name, true, st.size)) break;
            if (truncated) break;
            if (depth < searchDepth) await walk(child, depth + 1);
            else stop('depth_limit');
          } else if (st.isFile()) {
            if (!await consider(child, e.name, false, st.size)) break;
          } else {
            scanned += 1;
            if (scanned > searchFiles) { stop('scan_limit'); break; }
          }
        }
      } finally { if (directory) await directory.close().catch(e => { if (e) { /* dir fd already closed */ } }); }
    };
    const start = await fs.lstat(target);
    if (start.isSymbolicLink()) throw Error('symlink_denied');
    if (start.isFile()) await consider(target, path.basename(target), false, start.size);
    else if (start.isDirectory()) await walk(target, 0);
    else throw Error('regular_file_or_directory_required');
    still();
    return { path:target, query, match_count:entries.length, scanned_count:scanned, truncated, ...(truncated ? { reason } : {}), entries };
  }
}

module.exports = { LocalFiles, within, limits:{ text:limit, binary:binaryLimit, copy:copyLimit, search:{ depth:searchDepth, files:searchFiles, results:searchResults, ms:searchMs } } };
