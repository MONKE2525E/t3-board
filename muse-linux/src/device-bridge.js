(() => {
  if (window.__museLinuxBridgeStarted || location.origin !== 'https://muse.ai') return;
  window.__museLinuxBridgeStarted = true;
  let config, active, unregister = [], busy = false, registering = false, nextAttempt = 0;
  const seenInvokes = new Map();
  let previousScreenshot = null;
  const parallel = command => ['environment.describe','terminal.read','terminal.list','terminal.resize','claude.read','claude.list','computer.trace.read','computer.run.result','computer.evidence.read'].includes(command);
  const filename = value => String(value || 'file').replace(/[^a-zA-Z0-9._-]/g,'_').slice(-160) || 'file';

  const findRpc = () => {
    let root;
    for (const element of document.querySelectorAll('body *')) {
      const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
      if (key) { root = element[key]; break; }
    }
    if (root) while (root.return) root = root.return;
    const stack = root ? [root] : [], seen = new Set();
    while (stack.length && seen.size < 30000) {
      const node = stack.pop(); if (!node || seen.has(node)) continue; seen.add(node);
      const value = node.memoizedProps?.value;
      if (value?.isReady && value.connectionAuthority && typeof value.sendRequest === 'function' && typeof value.onClientInvoke === 'function') return value;
      if (node.sibling) stack.push(node.sibling); if (node.child) stack.push(node.child);
    }
    return null;
  };

  const cleanup = () => { for (const fn of unregister) fn(); unregister = []; active = null; previousScreenshot = null; };
  const register = async rpc => {
    cleanup();
    for (const command of Object.keys(config.commands)) {
      unregister.push(rpc.onClientInvoke(command, async (payload, meta) => {
        const id = payload.invoke_id;
        const limit = command==='files.import'?12000000:['files.write','files.edit'].includes(command)?1600000:['computer.batch','computer.control'].includes(command)||/^(terminal|claude)\./.test(command)?131072:16384;
        if (typeof id !== 'string' || !id || id.length > 128 || !meta?.websocketConnectionID) return;
        const send = response => rpc.sendRequest('client.invoke.result', response, { expectedConnectionId: meta.websocketConnectionID });
        for (const [key,entry] of seenInvokes) if (entry.expires<Date.now() && entry.response) seenInvokes.delete(key);
        if ((seenInvokes.size>=4096 && !seenInvokes.has(id)) || payload.command_id !== command || typeof payload.params_json !== 'string' || payload.params_json.length > limit) {
          await send({invoke_id:id,ok:false,error:{code:'invalid_or_throttled',message:'Invalid request or too many recent local requests.'}}).catch(()=>window.museLinuxDevice.status('waiting')); return;
        }
        const identity = command + '\0' + payload.params_json;
        if (seenInvokes.has(id)) {
          const prior = seenInvokes.get(id);
          if (prior.identity !== identity) await send({invoke_id:id,ok:false,error:{code:'invoke_id_collision',message:'This invocation ID already belongs to a different request. No input was dispatched.'}}).catch(()=>window.museLinuxDevice.status('waiting'));
          else await send(await prior.done).catch(()=>window.museLinuxDevice.status('waiting'));
          return;
        }
        let complete;
        const entry={identity,expires:Date.now()+300000,done:new Promise(resolve=>{complete=resolve;})};
        seenInvokes.set(id, entry);
        let response, acquired = false;
        try {
          if (busy && !parallel(command)) throw Error('busy: another local command is running');
          const params = JSON.parse(payload.params_json);
          if (!params || typeof params !== 'object' || Array.isArray(params)) throw Error('invalid_params');
          if (!parallel(command)) { busy = true; acquired = true; }
          const timeout = Number.isFinite(payload.timeout_ms) ? Math.max(1000,Math.min(180000,payload.timeout_ms)) : 60000;
          const result = await window.museLinuxDevice.invoke({ invokeId:id, command, params, deadline:Date.now()+timeout-500 });
          const screenshot = (result.observation?.screenshot_id || result.observation?.capture_status) ? result.observation : result;
          if (result.image_transfer || screenshot.image_transfer) {
            const image = result.image_transfer || screenshot.image_transfer;
            const path = `linux-companion/${config.id}/${crypto.randomUUID()}-${filename(image.filename)}`;
            delete result.image_transfer;
            delete screenshot.image_transfer;
            try {
              await rpc.sendRequest('fs.write', { path, data_base64: image.data_base64, overwrite: false, append: false, create_parent: true }, { expectedConnectionId: meta.websocketConnectionID });
              result.image = { path, mime_type: image.mime_type, note: 'Open this image file on the Muse VM for visual decisions.' };
              previousScreenshot = screenshot.screenshot_id ? {id:screenshot.screenshot_id,connection:meta.websocketConnectionID,path,mime_type:image.mime_type} : null;
            } catch (error) {
              screenshot.screenshot_available = false;
              screenshot.image_transfer_error = String(error.message).slice(0,200);
              screenshot.image_recovery_required = 'Request screen.snap with force_image="true". Image transfer failed; preceding input receipts remain valid. Do not replay input actions.';
            }
          } else if (screenshot.unchanged === true || screenshot.previous_screenshot_id) {
            if (previousScreenshot?.id === (screenshot.screenshot_id || screenshot.previous_screenshot_id) && previousScreenshot.connection === meta.websocketConnectionID) {
              screenshot.previous_image = {path:previousScreenshot.path,mime_type:previousScreenshot.mime_type};
              screenshot.screenshot_available = true;
            } else {
              screenshot.screenshot_available = false;
              if(screenshot.capture_status !== 'unavailable') screenshot.image_recovery_required = 'Request screen.snap with force_image="true". The previous image was not transferred on this connection. Do not replay input actions.';
            }
          }
          if(result.file_transfer){
            const file=result.file_transfer;
            const path=`linux-companion/${config.id}/${crypto.randomUUID()}-${filename(file.filename)}`;
            await rpc.sendRequest('fs.write',{path,data_base64:file.data_base64,overwrite:false,append:false,create_parent:true},{expectedConnectionId:meta.websocketConnectionID});
            delete result.file_transfer;
            result.uploaded_path=path;
            result.file={path,mime_type:file.mime_type||'application/octet-stream',note:'File transferred to the Muse VM.'};
          }
          response = { invoke_id: id, ok: true, payload_json: JSON.stringify(result) };
        } catch (error) {
          response = { invoke_id: id, ok: false, error: { code: 'linux_command_failed', message: String(error.message).slice(0,500) } };
        } finally { if (acquired) busy = false; }
        entry.response=response; complete(response);
        try { await send(response); } catch { window.museLinuxDevice.status('waiting'); }
      }));
    }
    const result = await rpc.sendRequest('client.register_capabilities', {
      client_id: config.id, platform: 'linux', display_name: 'Muse for Linux', version: config.version,
      capabilities: { data_sources: {}, device_commands: config.commands, hatch_app_commands: {}, rendering: {} },
    });
    if(result.rejected_ids?.length){
      const previousCount=Object.keys(config.commands).length;
      for(const id of result.rejected_ids)delete config.commands[id];
      if(!Object.keys(config.commands).length||Object.keys(config.commands).length===previousCount){cleanup();config=null;window.museLinuxDevice.status('rejected');nextAttempt=Date.now()+30000;return;}
      cleanup();await register(rpc);return;
    }
    if(!Object.keys(config.commands).length || result.accepted_device_commands!==Object.keys(config.commands).length){cleanup();config=null;window.museLinuxDevice.status('rejected');nextAttempt=Date.now()+30000;return;}
    active = rpc; window.museLinuxDevice.status('connected');
    await rpc.sendRequest('node.heartbeat', { node_id: config.id });
  };

  const tick = async () => {
    if (registering || Date.now() < nextAttempt) return;
    registering = true;
    try {
      config ??= JSON.parse(JSON.stringify(await window.museLinuxDevice.config()));
      const rpc = findRpc();
      if (!rpc) { cleanup(); window.museLinuxDevice.status('waiting'); return; }
      if (active?.sendRequest !== rpc.sendRequest || active?.connectionAuthority !== rpc.connectionAuthority) await register(rpc);
      else await rpc.sendRequest('node.heartbeat', { node_id: config.id });
    } catch { cleanup(); nextAttempt = Date.now() + 10000; window.museLinuxDevice.status('waiting'); }
    finally { registering = false; }
  };
  void tick();
  const interval = setInterval(tick, 5000);
  window.addEventListener('beforeunload', () => { clearInterval(interval); cleanup(); });
})()
