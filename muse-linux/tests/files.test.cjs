const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LocalFiles } = require('../src/local-files.cjs');

test('folder grant bounds reads, rejects symlinks and credentials, and requires write approval', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'muse-files-test-')); t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const root = path.join(temp,'approved'); await fs.mkdir(root); await fs.writeFile(path.join(root,'note.txt'),'original');
  const outside = path.join(temp,'outside.txt'); await fs.writeFile(outside,'outside'); await fs.symlink(outside,path.join(root,'link.txt')); await fs.writeFile(path.join(root,'.env'),'secret');
  let folder = null, allowed = false, approvals = 0;
  const files = new LocalFiles({ folder:()=>folder,approve:async()=>{ approvals++; return allowed; } });
  await assert.rejects(files.read({path:path.join(root,'note.txt')}),/disabled/);
  folder = root;
  assert.equal((await files.read({path:path.join(root,'note.txt')})).content,'original');
  assert.equal((await files.list({})).entries.some(e=>e.name==='.env'),false);
  await assert.rejects(files.read({path:outside}),/path_denied/);
  await assert.rejects(files.read({path:path.join(root,'link.txt')}),/symlink_denied/);
  await assert.rejects(files.read({path:path.join(root,'.env')}),/path_denied/);
  await assert.rejects(files.write({path:path.join(root,'note.txt'),content:'denied'}),/permission_denied/);
  assert.equal(await fs.readFile(path.join(root,'note.txt'),'utf8'),'original');
  allowed = true; await files.write({path:path.join(root,'note.txt'),content:'approved'});
  assert.equal(approvals,2); assert.equal((await files.read({path:path.join(root,'note.txt')})).content,'approved');
  folder = null; await assert.rejects(files.list({path:root}),/disabled/);
});

test('revocation during write approval prevents mutation',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'muse-files-revoke-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let folder=root;const file=path.join(root,'note.txt');await fs.writeFile(file,'unchanged');
  const files=new LocalFiles({folder:()=>folder,approve:async()=>{folder=null;return true;}});
  await assert.rejects(files.write({path:file,content:'changed'}),/disabled/);
  assert.equal(await fs.readFile(file,'utf8'),'unchanged');
});
