const {randomUUID}=require('node:crypto');
const {parseForceImage}=require('./screenshot-cache.cjs');
function inside([x,y,w,h],px,py){return px>=x&&py>=y&&px<x+w&&py<y+h;}
function redact(bitmap,[x,y,w,h],rects){
 const sx=bitmap.width/w,sy=bitmap.height/h;
 for(const [rx,ry,rw,rh] of rects){const x0=Math.max(0,Math.floor((rx-x)*sx)),y0=Math.max(0,Math.floor((ry-y)*sy)),x1=Math.min(bitmap.width,Math.ceil((rx+rw-x)*sx)),y1=Math.min(bitmap.height,Math.ceil((ry+rh-y)*sy));for(let row=y0;row<y1;row++)for(let col=x0;col<x1;col++){const i=(row*bitmap.width+col)*4;bitmap.pixels[i]=bitmap.pixels[i+1]=bitmap.pixels[i+2]=0;bitmap.pixels[i+3]=255;}}
 return bitmap;
}
class LayerControl{
 constructor(desktop,helpers){this.d=desktop;this.h=helpers;}
 available(snap){return snap.monitors.flatMap(m=>(this.h.layerSurfaces(snap.layers,m)||[]).filter(s=>!String(s.namespace).startsWith('muse-control-')).map(s=>({...s,monitor:m.name,bounds:[s.x,s.y,s.w,s.h]})));}
 select(snap,args){const matches=this.available(snap).filter(s=>s.namespace===args.layer_namespace&&(!args.monitor||s.monitor===args.monitor));if(matches.length!==1)throw Error('layer_required: list_layers, then provide an exact layer_namespace and monitor');const layer=matches[0],monitor=snap.monitors.find(m=>m.name===layer.monitor);if(!Number.isSafeInteger(Number(layer.pid))||Number(layer.pid)<1)throw Error('layer_identity_unavailable');return {layer,monitor};}
 same(o,snap){const selected=this.select(snap,{layer_namespace:o.layer_namespace,monitor:o.monitor});if(Number(selected.layer.pid)!==o.layer_pid||JSON.stringify(selected.layer.bounds)!==JSON.stringify(o.bounds))throw Error('stale_observation: layer identity or geometry changed');return selected;}
 blocked(snap,monitor){const blocked=this.d.blockedSet(),active=[monitor.activeWorkspace?.id,monitor.specialWorkspace?.id];return snap.clients.filter(c=>c.mapped&&!c.hidden&&c.monitor===monitor.id&&active.includes(c.workspace?.id)&&(blocked.has(c.class)||blocked.has(c.initialClass))).map(this.h.clientRect);}
 async observe(args){
  const d=this.d;d.check(args);parseForceImage(args.force_image);const generation=d.generation,snap=await d.snapshot();d.check(args);const {layer,monitor}=this.select(snap,args),id=randomUUID();
  const o={id,kind:'layer',layer_namespace:layer.namespace,layer_pid:Number(layer.pid),monitor:monitor.name,bounds:layer.bounds,expires:Date.now()+120000};d.observation=o;
  const result={observation_id:id,surface:'layer',layer_namespace:layer.namespace,layer_pid:o.layer_pid,monitor:monitor.name,bounds:layer.bounds,controls:[],captured_at:new Date().toISOString(),coordinate_system:{origin:'top_left',min:0,max:1000,space:'selected_layer',units:'normalized'},guidance:'Layer rectangles may include transparent space. Locate the visible card in the screenshot. Right-click uses action=click, button=right, coordinate as a JSON string [x,y] normalized 0-1000 within bounds. Dispatch alone does not prove dismissal.'};
  if(args.view!=='image'&&!args.image)return result;
  const box=this.h.monitorLogicalSize(monitor),region=[box.x,box.y,box.width,box.height];let png;
  try{if(d.feedback?.captureHidden)await d.feedback.captureHidden(true);d.check(args);png=await d.runFile('grim',['-g',`${box.x},${box.y} ${box.width}x${box.height}`,'-'],{encoding:'buffer',timeout:2500,maxBuffer:20*1024*1024,signal:d.abort?.signal});}
  finally{if(d.feedback?.active&&d.feedback?.captureHidden){try{await d.feedback.captureHidden(false);}catch(e){d.stop();throw e;}}}
  d.check(args);if(generation!==d.generation)throw Error('session_required_or_stopped');if(d.feedback?.captureExpired)throw Error('screenshot_discarded: indicator visibility changed');
  const after=await d.snapshot();d.check(args);this.same(o,after);if(generation!==d.generation)throw Error('session_required_or_stopped');const current=after.monitors.find(m=>m.name===monitor.name);if(JSON.stringify(this.h.monitorLogicalSize(current))!==JSON.stringify(box)||current.scale!==monitor.scale||current.transform!==monitor.transform)throw Error('stale_observation: output geometry changed');
  if(!png.stdout?.length)throw Error('screenshot_failed');const bitmap=d.decodeImage(Buffer.from(png.stdout)),blocked=[...this.blocked(snap,monitor),...this.blocked(after,current)];redact(bitmap,region,blocked);
  const compared=d.screenshots.compare({key:JSON.stringify({session:d.sessionId,layer:o.layer_namespace,pid:o.layer_pid,bounds:o.bounds,region,scale:monitor.scale,transform:monitor.transform}),...bitmap,force:parseForceImage(args.force_image)});
  let image;if(!compared.unchanged)image=blocked.length?require('electron').nativeImage.createFromBitmap(bitmap.pixels,{width:bitmap.width,height:bitmap.height}).toPNG():Buffer.from(png.stdout);
  return {...result,...compared,capture_status:'captured',image_current:true,screenshot_bounds:region,redacted_blocked_windows:blocked.length>0,...(image?{image_transfer:{mime_type:'image/png',filename:`linux-layer-${id}.png`,data_base64:image.toString('base64')}}:{})};
 }
 async control(args,state){
  const d=this.d,o=d.observation;d.check(args);if(!o||o.kind!=='layer'||o.id!==args.observation_id||Date.now()>o.expires)throw Error('stale_observation: observe the layer first');
  if(args.layer_namespace&&args.layer_namespace!==o.layer_namespace||args.monitor&&args.monitor!==o.monitor)throw Error('stale_observation: wrong selected layer');if(!['click','move','double_click','scroll'].includes(args.action))throw Error('layer_action_unsupported: use click, move, double_click or scroll');if(!d.pointer?.available)throw Error('pointer_unavailable');
  const parsed=this.h.parsePointerArgs(args),snap=await d.snapshot();d.check(args);const {monitor}=this.same(o,snap);const point=this.h.windowPoint({at:o.bounds.slice(0,2),size:o.bounds.slice(2)},parsed.coord,monitor);
  if(this.h.pointOnOwnedStop(snap.layers,snap.monitors,point.x,point.y,d.ownedPid()))throw Error('coordinate_blocked: Muse local controls cover this point');if(this.blocked(snap,monitor).some(r=>inside(r,point.x,point.y)))throw Error('app_blocked: a blocked window is behind this point');
  d.emitAction(args.action);state.inputStarted=true;state.receipt={route:'layer_pointer',dispatch_path:'coordinate',surface:'layer',layer_namespace:o.layer_namespace};const receipt=await d.pointer.perform({...parsed,point},d.abort?.signal);state.dispatched=true;d.observation=null;d.emitPointer(receipt.pointer||point,args.action==='click');d.check(args);await d.sleep(150);d.check(args);const after=await d.snapshot();d.check(args);const remains=this.available(after).some(s=>s.namespace===o.layer_namespace&&Number(s.pid)===o.layer_pid&&s.monitor===o.monitor);
  return {dispatched:true,...state.receipt,pointer:receipt.pointer||point,layer_still_present:remains,verification:'Inspect a fresh layer screenshot. A persistent full-screen notification surface may remain after one card disappears; layer_still_present does not prove the card remains.'};
 }
}
module.exports={LayerControl,redact};
