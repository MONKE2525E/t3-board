const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { LocalFiles, within } = require('../src/local-files.cjs');

const BASE = '/tmp/muse-port-d6c9/parity/files';

async function fixture(t, options = {}) {
  await fs.mkdir(BASE, { recursive:true });
  const root = await fs.mkdtemp(path.join(BASE, 't-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  let folder = root, allowed = options.allowed !== false, approvals = 0;
  const trashed = [];
  const files = new LocalFiles({
    folder:() => folder,
    approve:async () => { approvals += 1; return allowed; },
    trash:options.trash === undefined ? async target => { trashed.push(target); await fs.unlink(target); } : options.trash,
  });
  return { root, files, trashed, approvals:() => approvals, setFolder:value => { folder = value; }, setAllowed:value => { allowed = value; } };
}

test('within allows the granted root and / only as a full-scope grant', () => {
  assert.equal(within('/approved', '/approved'), true);
  assert.equal(within('/approved', '/approved/note.txt'), true);
  assert.equal(within('/approved', '/approved-other'), false);
  assert.equal(within('/approved', '/'), false);
  assert.equal(within('/', '/etc/passwd'), true);
  assert.equal(within('/', '/'), true);
});

test('full-scope / still denies credential path components without reading them', async () => {
  const files = new LocalFiles({ folder:() => '/', approve:async () => true });
  await assert.rejects(files.read({ path:'/root/.ssh/id_rsa' }), /path_denied/);
  await assert.rejects(files.stat({ path:'/etc/.env' }), /path_denied/);
});

test('binary import/export roundtrip, no-clobber, and oversized export', async t => {
  const { root, files } = await fixture(t);
  const dest = path.join(root, 'blob.bin');
  const payload = Buffer.from([0, 1, 255, 10, 0x80, 0x7f, 65]);
  const imported = await files.import({ path:dest, data_base64:payload.toString('base64') });
  assert.equal(imported.size_bytes, payload.length);
  const exported = await files.export({ path:dest });
  assert.equal(exported.size_bytes, payload.length);
  assert.equal(exported.file_transfer.filename, 'blob.bin');
  assert.deepEqual(Buffer.from(exported.file_transfer.data_base64, 'base64'), payload);
  await assert.rejects(files.import({ path:dest, data_base64:payload.toString('base64') }), /destination_exists/);
  assert.deepEqual(await fs.readFile(dest), payload);
  const huge = path.join(root, 'huge.bin');
  const handle = await fs.open(huge, 'w');
  await handle.truncate(8 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(files.export({ path:huge }), /8 MiB/);
});

test('mkdir, move from/to aliases, copy, and trash never permanently delete', async t => {
  const { root, files, trashed } = await fixture(t);
  const folder = path.join(root, 'docs');
  const created = await files.mkdir({ path:folder });
  assert.equal(created.ok, true);
  const src = path.join(folder, 'note.txt');
  await files.write({ path:src, content:'hello' });
  const moved = await files.move({ from:src, to:path.join(folder, 'renamed.txt') });
  assert.equal(moved.path, path.join(folder, 'renamed.txt'));
  assert.equal(moved.from_path, src);
  await assert.rejects(fs.access(src), /ENOENT/);
  const copyTo = path.join(folder, 'copy.txt');
  const copied = await files.copy({ path:moved.path, destination:copyTo });
  assert.equal(copied.ok, true);
  assert.equal(await fs.readFile(copyTo, 'utf8'), 'hello');
  assert.equal(await fs.readFile(moved.path, 'utf8'), 'hello');
  await assert.rejects(files.copy({ from:moved.path, to:copyTo }), /destination_exists/);
  await assert.rejects(files.move({ path:moved.path, destination:copyTo }), /destination_exists/);
  await assert.rejects(files.move({ path:folder, destination:path.join(root, 'other') }), /regular_file_required/);
  const removed = await files.remove({ path:copyTo });
  assert.equal(removed.trashed, true);
  assert.deepEqual(trashed, [copyTo]);
  await assert.rejects(fs.access(copyTo), /ENOENT/);
  assert.equal(await fs.readFile(moved.path, 'utf8'), 'hello');
});

test('remove uses the trash callback only', async t => {
  const { root, files } = await fixture(t, { trash:async () => { throw Error('trash exploded'); } });
  const file = path.join(root, 'keep.txt');
  await fs.writeFile(file, 'keep');
  await assert.rejects(files.remove({ path:file }), /trash exploded/);
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
  const noTrash = new LocalFiles({ folder:() => root, approve:async () => true });
  await assert.rejects(noTrash.remove({ path:file }), /trash_unavailable/);
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});

test('JSON trash array trashes listed files and keeps others', async t => {
  const { root, files, trashed } = await fixture(t);
  const a = path.join(root, 'a.txt'), b = path.join(root, 'b.txt'), c = path.join(root, 'c.txt');
  await fs.writeFile(a, 'a'); await fs.writeFile(b, 'b'); await fs.writeFile(c, 'c');
  const result = await files.remove({ paths: JSON.stringify([a, b]) });
  assert.equal(result.removed_count, 2);
  assert.equal(result.failed_count, 0);
  assert.deepEqual(trashed, [a, b]);
  assert.equal(await fs.readFile(c, 'utf8'), 'c');
});

test('grant revocation during approval prevents mkdir, import, move, copy, edit, and remove', async t => {
  const root = await fs.mkdtemp(path.join(BASE, 'rev-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const note = path.join(root, 'note.txt');
  await fs.writeFile(note, 'unchanged');
  const dest = path.join(root, 'dest.txt');
  const bin = path.join(root, 'new.bin');
  const dir = path.join(root, 'folder');
  for (const method of ['mkdir', 'import', 'move', 'copy', 'edit', 'remove']) {
    let folder = root;
    const files = new LocalFiles({
      folder:() => folder,
      approve:async () => { folder = null; return true; },
      trash:async () => { throw Error('should not trash'); },
    });
    if (method === 'mkdir') await assert.rejects(files.mkdir({ path:dir }), /disabled/);
    if (method === 'import') await assert.rejects(files.import({ path:bin, data_base64:Buffer.from('ab').toString('base64') }), /disabled/);
    if (method === 'move') await assert.rejects(files.move({ from:note, to:dest }), /disabled/);
    if (method === 'copy') await assert.rejects(files.copy({ from:note, to:dest }), /disabled/);
    if (method === 'edit') await assert.rejects(files.edit({ path:note, old_text:'unchanged', new_text:'changed' }), /disabled/);
    if (method === 'remove') await assert.rejects(files.remove({ path:note }), /disabled/);
    assert.equal(await fs.readFile(note, 'utf8'), 'unchanged');
    await assert.rejects(fs.access(dir), /ENOENT/);
    await assert.rejects(fs.access(bin), /ENOENT/);
    await assert.rejects(fs.access(dest), /ENOENT/);
  }
});

test('edit replaces exactly one snippet and refuses zero or multiple matches', async t => {
  const { root, files } = await fixture(t);
  const file = path.join(root, 'edit.txt');
  await fs.writeFile(file, 'alpha beta alpha');
  await assert.rejects(files.edit({ path:file, old_text:'alpha', new_text:'gamma' }), /not_unique/);
  assert.equal(await fs.readFile(file, 'utf8'), 'alpha beta alpha');
  await assert.rejects(files.edit({ path:file, old_text:'missing', new_text:'x' }), /not_found/);
  const result = await files.edit({ path:file, old_text:'alpha beta alpha', new_text:'gamma' });
  assert.equal(result.replacements, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'gamma');
});

test('search matches literal filename and utf8 content, honors limit, and excludes symlink and credentials', async t => {
  const { root, files, setFolder } = await fixture(t);
  await fs.mkdir(path.join(root, 'sub'));
  await fs.writeFile(path.join(root, 'alpha.txt'), 'needle in hay');
  await fs.writeFile(path.join(root, 'sub', 'other.md'), 'nothing here');
  await fs.writeFile(path.join(root, 'sub', 'needle-name.txt'), 'file');
  await fs.writeFile(path.join(root, '.env'), 'needle secret');
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 255, 10]));
  await fs.symlink(path.join(root, 'alpha.txt'), path.join(root, 'link-needle.txt'));
  await fs.writeFile(path.join(root, 'regex.txt'), 'not a regex target');
  const found = await files.search({ query:'needle' });
  const names = found.entries.map(e => e.name).sort();
  assert.deepEqual(names, ['alpha.txt', 'needle-name.txt']);
  assert.equal(found.entries.find(e => e.name === 'alpha.txt').match, 'content');
  assert.equal(found.entries.find(e => e.name === 'needle-name.txt').match, 'name');
  assert.equal(found.truncated, false);
  const regex = await files.search({ query:'.*' });
  assert.equal(regex.entries.some(e => e.name === 'regex.txt'), false);
  const limited = await files.search({ query:'e', limit:1 });
  assert.equal(limited.entries.length, 1);
  assert.equal(limited.truncated, true);
  assert.equal(limited.reason, 'match_limit');
  await assert.rejects(files.search({ query:'needle', path:path.join(root, 'link-needle.txt') }), /symlink_denied/);
  setFolder(null);
  await assert.rejects(files.search({ query:'needle' }), /disabled/);
});

test('search fails closed if the grant is revoked during the walk', async t => {
  const { root } = await fixture(t);
  for (let i = 0; i < 12; i += 1) await fs.writeFile(path.join(root, `f${i}.txt`), `content ${i} unique-walk-token`);
  let calls = 0;
  const files = new LocalFiles({
    folder:() => { calls += 1; return calls > 8 ? null : root; },
    approve:async () => true,
  });
  await assert.rejects(files.search({ query:'unique-walk-token' }), /disabled|revoked/);
});

test('content search skips files over 256 KiB and does not follow symlink directories', async t => {
  const { root, files } = await fixture(t);
  const big = path.join(root, 'big.txt');
  await fs.writeFile(big, `${'x'.repeat(256 * 1024 + 8)}UNIQUE_NEEDLE`);
  await fs.writeFile(path.join(root, 'small.txt'), 'UNIQUE_NEEDLE in a small file');
  const outside = path.join(path.dirname(root), 'outside-secret.txt');
  await fs.writeFile(outside, 'UNIQUE_NEEDLE outside');
  t.after(() => fs.rm(outside, { force:true }));
  await fs.symlink(path.dirname(root), path.join(root, 'escape'));
  const found = await files.search({ query:'UNIQUE_NEEDLE' });
  assert.equal(found.entries.some(e => e.name === 'small.txt'), true);
  assert.equal(found.entries.some(e => e.name === 'big.txt'), false);
  assert.equal(found.entries.some(e => e.path === outside), false);
});
