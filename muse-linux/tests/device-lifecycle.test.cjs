const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const filename=path.join(__dirname,'../src/device.cjs');
const realRequire=createRequire(filename);
const moduleFixture={exports:{}};
vm.runInThisContext('(function(require,module,__dirname){'+fs.readFileSync(filename,'utf8')+'\n})',{filename})(id=>id==='electron'?{app:{getPath:()=>'/tmp/muse-device-fixture'}}:realRequire(id),moduleFixture,path.dirname(filename));
const {LinuxDevice}=moduleFixture.exports;
function fixture(){
  const device=new LinuxDevice({parent:()=>null});device.state={commandPolicy:'allow'};
  device.browser={stop(){this.sessionId=null;}};device.desktop={stop(){this.sessionId=null;}};device.updateActivity=()=>{};
  return device;
}
const request=(command,params={})=>({command,params,deadline:Date.now()+10000});
test('changing computer permissions waits for cleanup before the local settings reply',async()=>{
  const device=fixture();let finish,settled=false,stopped=false;
  const cleanup=new Promise(resolve=>{finish=resolve;});
  device.computer={stopSync(){stopped=true;return cleanup;}};
  device.preferences={validate(){},async set(){}};
  const saving=device.setPreference('browserPolicy','allow').then(()=>{settled=true;});
  await Promise.resolve();await Promise.resolve();
  assert.equal(stopped,true);assert.equal(device.state.browserPolicy,'allow');assert.equal(settled,false);
  finish();await saving;assert.equal(settled,true);
});
test('device Stop preserves acknowledged batch progress through the wire boundary',async()=>{
  const device=fixture();device.computerMode='desktop';
  device.desktop.batch=async()=>{device.stopProcesses();return {completed:1,outcomes:[{action:'key',dispatched:true}],retryable:false};};
  const result=await device.invoke(request('computer.batch',{actions:'[{"action":"key","key":"Tab"}]'}));
  assert.equal(result.completed,1);assert.equal(result.outcomes[0].dispatched,true);assert.equal(result.stopped,true);assert.equal(result.retryable,false);assert.match(result.verification,/Do not replay/);
});
for(const command of ['computer.action','computer.plan'])test(`device Stop preserves ${command} receipt through the wire boundary`,async()=>{
  const device=fixture();
  const receipt={dispatch:'possible',effect:'unknown',execution:'unfinished',actionId:'owned-action'};
  const result={receipt};
  device.computer={status:()=>({state:'ready'}),stopSync(){},[command==='computer.action'?'action':'plan']:async()=>{device.stopProcesses();return result;}};
  const output=await device.invoke(request(command,{request:'{}'}));
  assert.deepEqual(output.receipt,receipt);assert.equal(output.stopped,true);assert.equal(output.retryable,false);
});
test('agent cannot end a paused isolated session to bypass local Resume',async()=>{
  const device=fixture();let stops=0;
  device.computer={status:()=>({state:'paused',mode:'isolated_desktop'}),async stop(){stops++;}};
  const output=await device.invoke(request('computer.session',{action:'end'}));
  assert.equal(output.ended,false);assert.equal(output.required_next,'wait_for_local_user');assert.equal(stops,0);
});
test('Stop during pending computer session prevents a late success and mode assignment',async()=>{
  const device=fixture();let release;
  device.desktop.session=()=>new Promise(resolve=>{release=()=>{device.desktop.sessionId='late-id';resolve({session_id:'late-id'});};});
  const pending=device.invoke(request('computer.session',{action:'start',scope:'desktop'}));
  device.stopProcesses();release();
  await assert.rejects(pending,/stopped_by_user/);assert.equal(device.computerMode,null);assert.equal(device.desktop.sessionId,null);
});
test('terminal reads remain available during pending Bash execution',async()=>{
  const device=fixture();let finish;
  device.commands={run:()=>new Promise(resolve=>{finish=resolve;})};device.terminals={read:async()=>({output:'poll'})};
  const run=device.invoke(request('system.run',{argv:'["bash"]'}));
  assert.equal((await device.invoke(request('terminal.read',{terminal_id:'owned'}))).output,'poll');
  finish({exit_code:0});assert.equal((await run).exit_code,0);
});
test('a session backend failure cleans up its partially created session',async()=>{
  const device=fixture();device.desktop.session=async()=>{device.desktop.sessionId='orphan';throw Error('windows_query_failed');};
  await assert.rejects(device.invoke(request('computer.session',{action:'start',scope:'desktop'})),/windows_query_failed/);
  assert.equal(device.desktop.sessionId,null);assert.equal(device.computerMode,null);
});
test('transient waiting preserves tasks and repeated misses share one disconnect timer',()=>{
  const device=fixture();let stops=0;device.commands={stop:()=>{stops++;}};
  device.setConnection('waiting');const timer=device.disconnectTimer;device.setConnection('waiting');
  assert.equal(stops,0);assert.equal(device.disconnectTimer,timer);
  device.setConnection('connected');assert.equal(device.disconnectTimer,null);
  device.setConnection('rejected');assert.equal(stops,1);
});
test('allow policy cannot override an aborted request or destroyed device',async()=>{
  const device=fixture(),controller=new AbortController();controller.abort();
  assert.equal(await device.permission('commandPolicy','','','',Date.now()+10000,controller.signal),false);
  device.destroyed=true;assert.equal(await device.permission('commandPolicy','','','',Date.now()+10000),false);
  await assert.rejects(device.invoke(request('terminal.list')),/device_disconnected/);
});

test('desktop Pause blocks new commands, terminal writes and approval bypass while permitting polls',async()=>{
  const device=fixture();let mutations=0;
  device.desktop.paused=true;device.desktop.pauseReceipt=extra=>({...extra,paused:true,requires_user_resume:true,interrupted:true});
  device.commands={run:async()=>{mutations++;}};device.terminals={write:async()=>{mutations++;},read:async()=>({output:'poll'})};
  device.desktop.session=async()=>{mutations++;};
  for(const [command,params] of [['system.run',{argv:'["bash"]'}],['terminal.write',{terminal_id:'owned',text:'command\n'}],['computer.session',{action:'start',scope:'browser'}]]){
    const result=await device.invoke(request(command,params));assert.equal(result.requires_user_resume,true);assert.equal(result.dispatched,false);
  }
  assert.equal((await device.invoke(request('terminal.read',{terminal_id:'owned'}))).output,'poll');assert.equal(mutations,0);
});

test('ending a paused session cannot bypass local Resume with Always allow',async()=>{
  const device=fixture();device.state.desktopPolicy='allow';device.computerMode='desktop';
  device.desktop.sessionId='paused-owned';device.desktop.paused=true;
  device.desktop.pauseReceipt=extra=>({...extra,paused:true,requires_user_resume:true,interrupted:true});
  let starts=0,stops=0;
  device.desktop.stop=()=>{stops++;device.desktop.paused=false;device.desktop.sessionId=null;};
  device.desktop.session=async()=>{starts++;return{session_id:'replacement'};};
  for(const action of ['end','start']){
    const result=await device.invoke(request('computer.session',{action,scope:'desktop'}));
    assert.equal(result.requires_user_resume,true);assert.equal(result.dispatched,false);
  }
  assert.equal(starts,0);assert.equal(stops,0);assert.equal(device.desktop.sessionId,'paused-owned');assert.equal(device.computerMode,'desktop');
});

test('teardown of a paused desktop grant requires new local approval after reconnect',async()=>{
  const device=fixture();let saved=0;device.save=async()=>{saved++;};
  for(const key of ['browserPolicy','desktopPolicy','commandPolicy','fileWritePolicy'])device.state[key]='allow';
  const {NativeDesktop}=realRequire('./native-desktop.cjs');
  device.desktop=new NativeDesktop({allowed:()=>true,permission:async()=>true,onStateChange:(status,transition)=>device.desktopStateChanged(status,transition)});
  device.desktop.sessionId='paused-owned';device.desktop.paused=true;
  device.stopProcesses();
  assert.equal(device.desktop.status().state,'idle');
  for(const key of ['browserPolicy','desktopPolicy','commandPolicy','fileWritePolicy']){
    assert.equal(device.state[key],'ask');assert.equal(device.preferences.values[key],'ask');
  }
  assert.equal(saved,1);
  let permissionRequested=false;
  device.permission=async key=>{permissionRequested=device.state[key]==='ask';return false;};
  device.desktop.session=async()=>{assert.equal(await device.permission('desktopPolicy'),false);throw Error('permission_denied');};
  await assert.rejects(device.invoke(request('computer.session',{action:'start',scope:'desktop'})),/permission_denied/);
  assert.equal(permissionRequested,true);
});

test('wire observations are bounded without changing internal controls or element identities',async()=>{
  const device=fixture();device.computerMode='desktop';
  const raw={observation_id:'stable',controls:Array.from({length:500},(_,i)=>({element_number:i+1,role:'button',label:'Button '+i,value:'x'.repeat(1000),bounds:[0,i,30,20]}))};
  device.desktop.observe=async()=>raw;
  const first=await device.invoke(request('computer.observe'));
  assert(Buffer.byteLength(JSON.stringify(first))<=12288);assert(first.more);assert.equal(raw.controls.length,500);assert.equal(raw.controls[0].value.length,1000);
  const page=await device.invoke(request('computer.observe',{control_offset:String(first.next_offset),control_limit:'2'}));
  assert.equal(page.controls[0].element_number,first.next_offset+1);
  device.desktop.batch=async()=>({completed:1,outcomes:[{dispatched:true}],observation:raw});
  const batch=await device.invoke(request('computer.batch',{actions:'[]'}));assert.equal(batch.completed,1);assert(Buffer.byteLength(JSON.stringify(batch.observation))<=12288);
});
test('invalid observation output options reject before dispatching input',async()=>{
  const device=fixture();device.computerMode='desktop';let calls=0;device.desktop.control=async()=>{calls++;return{};};
  await assert.rejects(device.invoke(request('computer.control',{action:'key',key:'Enter',detail:'huge'})),/invalid_detail/);
  await assert.rejects(device.invoke(request('computer.control',{action:'key',key:'Enter',control_offset:'-1'})),/invalid_offset/);
  assert.equal(calls,0);
});
