const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const crypto=require('node:crypto');
const source=fs.readFileSync(require('node:path').join(__dirname,'../src/device-bridge.js'),'utf8');
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(commands,nativeResult,reject=[]){
  const handlers=new Map(),requests=[],states=[],localRequests=[];let tick,now=Date.now(),invocations=0;
  const rpc={isReady:true,connectionAuthority:{},onClientInvoke:(id,fn)=>{handlers.set(id,fn);return()=>handlers.delete(id);},sendRequest:async(method,params,opts)=>{
    requests.push({method,params:structuredClone(params),opts});
    if(method==='client.register_capabilities')return {accepted_device_commands:Object.keys(params.capabilities.device_commands).filter(id=>!reject.includes(id)).length,rejected_ids:reject.filter(id=>Object.hasOwn(params.capabilities.device_commands,id))};
    return {};
  }};
  const element={__reactFiber$test:{memoizedProps:{value:rpc}}};
  const context={location:{origin:'https://muse.ai'},document:{querySelectorAll:()=>[element]},crypto,console,structuredClone,setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{},setTimeout,Date:{now:()=>now},window:{addEventListener:()=>{},museLinuxDevice:{config:async()=>({id:'fixture-device',version:'test',commands}),status:s=>states.push(s),invoke:async request=>{localRequests.push(request);invocations++;return typeof nativeResult==='function'?nativeResult():structuredClone(nativeResult);}}}};
  vm.runInNewContext(source,context);
  return {rpc,handlers,requests,states,localRequests,tick:()=>tick(),advance:ms=>{now+=ms;},invocations:()=>invocations};
}
test('stable invocation identity reaches main and a changed duplicate never replays input',async()=>{
  const f=fixture({'computer.control':{}},{dispatched:true,receipt:{effect:'unknown'}});await settle();
  const invoke=params_json=>f.handlers.get('computer.control')({invoke_id:'identity-1',command_id:'computer.control',params_json,timeout_ms:10000},{websocketConnectionID:'fixture-connection'});
  await invoke('{"action":"click"}');await invoke('{"action":"type","text":"different"}');
  assert.equal(f.localRequests[0].invokeId,'identity-1');assert.equal(f.invocations(),1);
  assert.equal(f.requests.filter(r=>r.method==='client.invoke.result').at(-1).params.error.code,'invoke_id_collision');
});
test('binary local export becomes a VM file reference without base64 in the result',async()=>{
  const f=fixture({'files.upload':{}},{size_bytes:3,file_transfer:{filename:'../note.txt',data_base64:'YWJj'}});
  await settle();assert.equal(f.states.at(-1),'connected');
  await f.handlers.get('files.upload')({invoke_id:'upload-1',command_id:'files.upload',params_json:'{"path":"/fixture/note.txt"}',timeout_ms:10000},{websocketConnectionID:'fixture-connection'});
  const write=f.requests.find(r=>r.method==='fs.write');
  assert.match(write.params.path,/^linux-companion\/fixture-device\/[0-9a-f-]+-\.\._note\.txt$/);
  assert.equal(write.params.overwrite,false);assert.equal(write.params.data_base64,'YWJj');
  assert.equal(write.opts.expectedConnectionId,'fixture-connection');
  const receipt=f.requests.find(r=>r.method==='client.invoke.result');
  const result=JSON.parse(receipt.params.payload_json);
  assert.equal(receipt.params.ok,true);assert.equal(result.file.path,write.params.path);assert.equal(result.file_transfer,undefined);assert.equal(JSON.stringify(result).includes('YWJj'),false);
  assert.equal(result.uploaded_path,write.params.path);
});
test('total rejection retries the original nonempty command set',async()=>{
  const f=fixture({'terminal.read':{}},{},['terminal.read']);await settle();
  assert.equal(f.states.at(-1),'rejected');f.advance(31000);await f.tick();
  assert.equal(f.states.includes('connected'),false);
  assert.ok(f.requests.filter(r=>r.method==='client.register_capabilities').every(r=>Object.keys(r.params.capabilities.device_commands).length===1));
});
test('polling above 100 requests and duplicates always receives a receipt without reexecution',async()=>{
  const f=fixture({'terminal.read':{}},{output:'owned fixture'});await settle();
  const invoke=id=>f.handlers.get('terminal.read')({invoke_id:id,command_id:'terminal.read',params_json:'{}'},{websocketConnectionID:'fixture-connection'});
  for(let i=0;i<120;i++)await invoke('poll-'+i);
  await invoke('poll-0');
  assert.equal(f.invocations(),120);assert.equal(f.requests.filter(r=>r.method==='client.invoke.result').length,121);
  f.advance(300001);await invoke('poll-0');assert.equal(f.invocations(),121);
});
test('read polling can complete while a mutating command is pending',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});let first=true;
  const f=fixture({'system.run':{},'terminal.read':{}},()=>{if(first){first=false;return pending;}return {output:'poll ok'};});await settle();
  const invoke=command=>f.handlers.get(command)({invoke_id:command,command_id:command,params_json:'{}'},{websocketConnectionID:'fixture-connection'});
  const run=invoke('system.run');await settle();await invoke('terminal.read');
  assert.equal(f.requests.filter(r=>r.method==='client.invoke.result').at(-1).params.ok,true);
  finish({exit_code:0});await run;
});
test('gateway rejects an extra command without taking accepted browser commands offline',async()=>{
  const f=fixture({'computer.observe':{},'terminal.start':{}},{},['terminal.start']);
  await settle();
  assert.equal(f.states.at(-1),'connected');
  assert.equal(f.handlers.has('computer.observe'),true);
  assert.equal(f.handlers.has('terminal.start'),false);
  assert.equal(f.requests.filter(r=>r.method==='client.register_capabilities').length,2);
});

test('unchanged screenshot refers only to a successfully uploaded baseline on the same connection',async()=>{
  let n=0;const f=fixture({'screen.snap':{}},()=>n++===0?{screenshot_id:'frame-1',unchanged:false,image_transfer:{filename:'fixture.png',mime_type:'image/png',data_base64:'YWJj'}}:{screenshot_id:'frame-1',unchanged:true});await settle();
  const invoke=(id,connection='fixture-connection')=>f.handlers.get('screen.snap')({invoke_id:id,command_id:'screen.snap',params_json:'{}'},{websocketConnectionID:connection});
  await invoke('image-first');await invoke('image-same');const receipts=f.requests.filter(r=>r.method==='client.invoke.result').map(r=>JSON.parse(r.params.payload_json));assert.equal(f.requests.filter(r=>r.method==='fs.write').length,1);assert.equal(receipts[1].unchanged,true);assert.equal(receipts[1].screenshot_available,true);assert.equal(receipts[1].previous_image.path,receipts[0].image.path);assert.equal(receipts[1].image,undefined);assert.equal(receipts[1].image_transfer,undefined);
  await invoke('image-new-connection','other-connection');const last=JSON.parse(f.requests.filter(r=>r.method==='client.invoke.result').at(-1).params.payload_json);assert.equal(last.screenshot_available,false);assert.match(last.image_recovery_required,/force_image/);assert.equal(last.previous_image,undefined);assert.equal(f.invocations(),3);
});

test('an unchanged image without an uploaded baseline requests capture recovery without repeating input',async()=>{
  const f=fixture({'computer.control':{}},{dispatched:true,observation:{screenshot_id:'missing',unchanged:true,controls:[]}});await settle();await f.handlers.get('computer.control')({invoke_id:'missing-image',command_id:'computer.control',params_json:'{"action":"click"}'},{websocketConnectionID:'fixture-connection'});const result=JSON.parse(f.requests.find(r=>r.method==='client.invoke.result').params.payload_json);assert.equal(result.dispatched,true);assert.equal(result.observation.screenshot_available,false);assert.match(result.observation.image_recovery_required,/Do not replay input/);assert.equal(f.invocations(),1);assert.equal(f.requests.some(r=>r.method==='fs.write'),false);
});

test('post-action nested screenshot is uploaded and omitted from the text receipt',async()=>{
  let n=0;const f=fixture({'computer.control':{}},()=>({dispatched:true,observation:n++===0?{screenshot_id:'nested',unchanged:false,image_transfer:{filename:'fixture.png',mime_type:'image/png',data_base64:'YWJj'}}:{screenshot_id:'nested',unchanged:true}}));await settle();
  const invoke=id=>f.handlers.get('computer.control')({invoke_id:id,command_id:'computer.control',params_json:'{"action":"click"}'},{websocketConnectionID:'fixture-connection'});
  await invoke('nested-first');await invoke('nested-same');const results=f.requests.filter(r=>r.method==='client.invoke.result').map(r=>JSON.parse(r.params.payload_json));
  assert.equal(f.requests.filter(r=>r.method==='fs.write').length,1);assert.equal(JSON.stringify(results[0]).includes('YWJj'),false);assert.equal(results[0].observation.image_transfer,undefined);assert.equal(results[1].observation.previous_image.path,results[0].image.path);assert.equal(results[1].observation.screenshot_available,true);assert.equal(f.invocations(),2);
});

test('image upload failure preserves dispatched input and requires read-only recovery',async()=>{
 let n=0;const f=fixture({'computer.control':{}},()=>({dispatched:true,observation:n++===0?{screenshot_id:'failed',unchanged:false,image_transfer:{filename:'fixture.png',mime_type:'image/png',data_base64:'YWJj'}}:{screenshot_id:'failed',unchanged:true}}));await settle();const send=f.rpc.sendRequest;f.rpc.sendRequest=async(method,...args)=>{if(method==='fs.write')throw Error('transfer timeout');return send(method,...args);};
 const invoke=id=>f.handlers.get('computer.control')({invoke_id:id,command_id:'computer.control',params_json:'{"action":"click"}'},{websocketConnectionID:'fixture-connection'});await invoke('failed-image');await invoke('after-failed-image');const results=f.requests.filter(r=>r.method==='client.invoke.result');for(const receipt of results){assert.equal(receipt.params.ok,true);const r=JSON.parse(receipt.params.payload_json);assert.equal(r.dispatched,true);assert.equal(r.observation.screenshot_available,false);assert.match(r.observation.image_recovery_required,/Do not replay input/);assert.equal(r.observation.previous_image,undefined);assert.equal(JSON.stringify(r).includes('YWJj'),false);}assert.equal(f.invocations(),2);
});

test('covered-window observation may refer to stale pixels without claiming unchanged',async()=>{
 let n=0;const f=fixture({'screen.snap':{}},()=>n++===0?{screenshot_id:'prior',unchanged:false,image_transfer:{filename:'fixture.png',mime_type:'image/png',data_base64:'YWJj'}}:{capture_status:'unavailable',previous_screenshot_id:'prior',unchanged:null,image_current:false,capture_error:'window_obscured: omarchy-notifications'});await settle();const invoke=id=>f.handlers.get('screen.snap')({invoke_id:id,command_id:'screen.snap',params_json:'{}'},{websocketConnectionID:'fixture-connection'});await invoke('visible');await invoke('covered');const r=JSON.parse(f.requests.filter(x=>x.method==='client.invoke.result').at(-1).params.payload_json);assert.equal(r.unchanged,null);assert.equal(r.image_current,false);assert.equal(r.screenshot_available,true);assert.ok(r.previous_image.path);assert.equal(r.image_recovery_required,undefined);assert.equal(f.requests.filter(x=>x.method==='fs.write').length,1);
});
