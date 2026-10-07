const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {createRequire}=require('node:module');
const filename=path.join(__dirname,'../src/device.cjs');
const realRequire=createRequire(filename),fixture={exports:{}};
vm.runInThisContext('(function(require,module,__dirname){'+fs.readFileSync(filename,'utf8')+'\n})',{filename})(id=>id==='electron'?{app:{getPath:()=>'/tmp/muse-settings-trust'}}:realRequire(id),fixture,path.dirname(filename));
const {LinuxDevice}=fixture.exports;
const url=pathToFileURL(path.join(__dirname,'../src/settings.html')).href;
function panelFixture(){
  const mainFrame={url:url+'?tab=computer'};
  const webContents={mainFrame};
  const panel={webContents,isDestroyed:()=>false};
  const device=new LinuxDevice({parent:()=>null});
  return {device,panel,event:{sender:webContents,senderFrame:mainFrame}};
}
test('only the embedded settings main frame can access local settings IPC',()=>{
  const {device,panel,event}=panelFixture();
  assert.equal(device.trusted(event,panel),true);
  assert.equal(device.trusted({...event,sender:{}},panel),false);
  assert.equal(device.trusted({...event,senderFrame:{url}},panel),false);
  event.senderFrame.url='https://muse.ai';assert.equal(device.trusted(event,panel),false);
  event.senderFrame.url=pathToFileURL(path.join(__dirname,'../src/offline.html')).href;
  assert.equal(device.trusted(event,panel),false);
});
test('destroyed and absent settings panels refuse IPC',()=>{
  const {device,panel,event}=panelFixture();
  assert.equal(device.trusted(event,undefined),false);
  panel.isDestroyed=()=>true;assert.equal(device.trusted(event,panel),false);
});
test('remote Muse has only its own origin-scoped desktop entry points',()=>{
  const {device,panel,event}=panelFixture();
  event.senderFrame.url='https://muse.ai/chat';
  assert.equal(device.trusted(event,panel,'https://muse.ai'),true);
  event.senderFrame.url='https://example.com';assert.equal(device.trusted(event,panel,'https://muse.ai'),false);
  event.senderFrame.url='https://muse.ai.example.com';assert.equal(device.trusted(event,panel,'https://muse.ai'),false);
});
