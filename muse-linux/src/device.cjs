const { app, BrowserWindow, dialog, ipcMain, session, shell, nativeTheme, globalShortcut, Tray, Menu, powerSaveBlocker } = require('electron');
const { parseForceImage } = require('./screenshot-cache.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { deviceSpecs } = require('./device-specs.cjs');
const { LocalBrowser } = require('./local-browser.cjs');
const { LocalFiles } = require('./local-files.cjs');
const { HOME_URL } = require('./policy.cjs');
const { Preferences } = require('./preferences.cjs');
const { NativeDesktop, defaultRun } = require('./native-desktop.cjs');
const { KeyboardInput } = require('./keyboard-input.cjs');
const { AppLauncher } = require('./app-launcher.cjs');
const { Dictation } = require('./dictation.cjs');
const { Commands } = require('./commands.cjs');
const { Terminals } = require('./terminals.cjs');
const { ClaudeSessions } = require('./claude-sessions.cjs');
const { SettingsPanel } = require('./settings-panel.cjs');
const { DesktopOverlay } = require('./desktop-overlay.cjs');
const { WaylandPointer } = require('./wayland-pointer.cjs');
const { DesktopActivity } = require('./desktop-activity.cjs');
const { DesktopContext } = require('./desktop-context.cjs');
const { compactObservation, validateObservationOptions } = require('./observation-output.cjs');
const { ComputerRuntime } = require('./computer/index.cjs');

class LinuxDevice {
  constructor({ parent, museSession, icon }) {
    this.parent = parent; this.museSession = museSession; this.icon = icon;
    this.state = { browserEnabled:false, browserAutoApprove:false, folder:null, connection:'waiting' };
    this.settingsPath = path.join(app.getPath('userData'),'linux-permissions.json');
    this.preferences = new Preferences(this.settingsPath);
    this.handlers = []; this.busy = false; this.stopGeneration = 0;
  }

  trusted(event, window, expectedOrigin) {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
    try { const url = new URL(event.senderFrame.url); return expectedOrigin ? url.origin === expectedOrigin : url.href.split('?')[0] === pathToFileURL(path.join(__dirname,'settings.html')).href; } catch { return false; }
  }

  handle(channel, window, fn, origin) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!this.trusted(event,window(),origin)) throw Error('Untrusted local request');
      return fn(...args);
    });
    this.handlers.push(channel);
  }

  async save() {
    return this.preferences.save();
  }

  async start() {
    await this.preferences.load();this.id=this.preferences.id;
    this.state = { ...this.preferences.values,connection:'waiting' };
    this.nativeDirectory=app.isPackaged?path.join(process.resourcesPath,'native'):path.join(__dirname,'../native/bin');
    this.desktopAvailable=!!process.env.HYPRLAND_INSTANCE_SIGNATURE;
    try{for(const helper of ['muse-accessibility','muse-control-overlay','muse-pointer','muse-keyboard','muse-activity'])await fs.access(path.join(this.nativeDirectory,helper));}catch{this.desktopAvailable=false;}
    if (this.destroyed) return;
    const browserSession = session.fromPartition('persist:muse-local-browser');
    browserSession.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.on('will-download',(_event,item)=>item.setSaveDialogOptions({defaultPath:path.join(app.getPath('downloads'),path.basename(item.getFilename()))}));
    this.browser = new LocalBrowser({ parent:this.parent,session:browserSession,enabled:()=>this.state.browserPolicy!=='deny',approved:()=>this.state.browserPolicy==='allow',icon:this.icon,onChange:()=>this.updateActivity(),readFile:async file=>{const result=await this.files.export({path:file});return result.file_transfer;} });
    this.desktopOverlay=new DesktopOverlay({helper:path.join(this.nativeDirectory,'muse-control-overlay'),logo:this.icon,onPause:()=>{void this.computer?.pause().catch(()=>{});},onResume:()=>{void this.computer?.resumeByUser().catch(()=>{});},onStop:()=>{void this.stopBrowser().catch(()=>{});},onFailure:()=>this.desktop?.stop()});
    this.pointer=new WaylandPointer({helper:path.join(this.nativeDirectory,'muse-pointer'),onMove:point=>this.desktopOverlay.pointer(point),onFailure:()=>this.desktop?.stop()});
    this.keyboard=new KeyboardInput({helper:path.join(this.nativeDirectory,'muse-keyboard')});
    this.apps=new AppLauncher();
    this.desktopActivity=new DesktopActivity({helper:path.join(this.nativeDirectory,'muse-activity'),onInput:()=>this.desktop?.physicalInput(),onFailure:()=>this.desktop?.activityLost()});
    this.desktopContext=new DesktopContext({runFile:defaultRun,blocked:()=>[...(this.desktop?.blockedSet() || [])]});
    this.desktop = new NativeDesktop({helper:path.join(this.nativeDirectory,'muse-accessibility'),pointer:this.pointer,feedback:this.desktopOverlay,keyboard:this.keyboard,apps:this.apps,activity:this.desktopActivity,context:this.desktopContext,allowed:()=>this.desktopAvailable&&this.state.desktopPolicy!=='deny',blocked:()=>this.state.blockedApps,permission:(task,deadline,signal)=>this.permission('desktopPolicy','Muse computer use',`Allow Muse to use apps for this task?`,task,deadline,signal),onChange:task=>{this.nativeTask=task;this.updateActivity();},onStateChange:(status,transition)=>this.desktopStateChanged(status,transition)});
    this.files = new LocalFiles({ folder:()=>this.destroyed || (this.busy && this.invocationGeneration !== this.stopGeneration) ? null : this.state.folder,approve:async (file,content) => {
      return this.permission('fileWritePolicy','Muse file access','Allow this file change?',`${file}\n\n${content.slice(0,1600)}`,this.invocationDeadline);
    },trash:file=>shell.trashItem(file) });
    this.commands=new Commands({permission:(command,deadline)=>this.permission('commandPolicy','Muse run command','Allow Muse to run this command?',command,deadline),resolve:async cwd=>this.files.resolve(cwd||this.state.folder)});
    this.terminals=new Terminals({permission:(command,deadline)=>this.permission('commandPolicy','Muse code execution','Allow Muse to start this terminal?',command,deadline),resolve:async cwd=>this.files.resolve(cwd||this.state.folder),nativeDirectory:this.nativeDirectory,onChange:()=>this.updateActivity()});
    this.claude=new ClaudeSessions({terminals:this.terminals,resolve:async cwd=>this.files.resolve(cwd||this.state.folder)});
    this.computer=new ComputerRuntime({deviceId:this.id,directory:app.getPath('userData'),nativeDirectory:this.nativeDirectory,
      policy:()=>this.state,permission:(key,task,deadline,signal)=>this.permission(key,'Muse computer use','Allow Muse to use this control session?',String(task||'').slice(0,160),deadline,signal),
      resolveFile:file=>this.files.resolve(file),
      localBrowser:this.browser,desktop:this.desktop,onChange:()=>this.updateActivity()});
    await this.computer.ready;
    this.desktop.semanticTree=target=>this.computer.session?.mode==='real_desktop'?this.computer.nativeTree(target):Promise.reject(Error('session_required'));
    this.claudeAvailable=await exec('claude',['--version'],{timeout:4000,maxBuffer:4096,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}}).then(()=>true,()=>false);
    if(this.destroyed)return;
    this.dictation=new Dictation({directory:path.join(app.getPath('userData'),'speech'),engine:path.join(this.nativeDirectory,'whisper-cli'),enabled:()=>this.state.dictationEnabled,language:()=>this.state.dictationLanguage,insert:text=>this.insertDictation(text),onChange:()=>this.updateActivity()});
    await this.dictation.initialize();
    if(this.destroyed)return;
    await this.applyBehavior();
    if(this.destroyed)return;
    this.handle('muse-settings-state',()=>this.settingsPanel,()=>this.settingsState());
    this.handle('muse-settings-browser-connection',()=>this.settingsPanel,request=>this.computer.connection(request));
    this.handle('muse-settings-isolation',()=>this.settingsPanel,request=>this.computer.isolationSettings(request));
    this.handle('muse-settings-control',()=>this.settingsPanel,request=>{
      if(request?.action==='resume')return this.computer.resumeByUser();
      if(request?.action==='review')return this.computer.reviewByUser();
      if(request?.action==='pause')return this.computer.pause();
      throw Error('invalid_control_action');
    });
    this.handle('muse-settings-preference',()=>this.settingsPanel,(key,value)=>this.setPreference(key,value));
    this.handle('muse-settings-speech-download',()=>this.settingsPanel,()=>this.dictation.prepare());
    this.handle('muse-settings-dictate',()=>this.settingsPanel,()=>this.dictation.toggle());
    this.handle('muse-settings-dictation-cancel',()=>this.settingsPanel,()=>this.dictation.cancel());
    this.handle('muse-settings-apps',()=>this.settingsPanel,async()=>{
      const {stdout}=await exec('hyprctl',['-j','clients'],{timeout:3000,maxBuffer:512*1024});
      return [...new Set(JSON.parse(stdout).filter(c=>c.mapped&&c.class&&!['muse-linux','io.muse.linux'].includes(c.class)).map(c=>c.class))].sort().map(app=>({app,blocked:this.state.blockedApps.includes(app)}));
    });
    this.handle('muse-settings-close',()=>this.settingsPanel,()=>this.settingsPanel.hide());
    this.handle('muse-open-settings',this.parent,tab=>{if(!['general','computer','files','dictation','shortcuts',undefined].includes(tab))throw Error('invalid_settings_tab');return this.showSettings(tab);},'https://muse.ai');
    this.handle('muse-toggle-dictation',this.parent,()=>this.dictation.toggle(),'https://muse.ai');
    this.handle('muse-cancel-dictation',this.parent,()=>this.dictation.cancel(),'https://muse.ai');
    this.handle('muse-stop-all',this.parent,()=>this.stopBrowser(),'https://muse.ai');
    this.handle('muse-desktop-pause',this.parent,()=>this.computer.pause(),'https://muse.ai');
    this.handle('muse-desktop-state',this.parent,()=>({dictationEnabled:this.state.dictationEnabled,dictationStatus:this.dictation.state.status,dictationError:this.dictation.state.error,activeTask:this.nativeTask||(this.browser.sessionId?'Browser automation':null),desktopControl:this.desktop.status()}),'https://muse.ai');
    this.handle('muse-settings-browser',()=>this.settingsPanel,async enabled => {
      if (typeof enabled !== 'boolean') throw Error('Invalid permission');
      await this.setPreference('browserPolicy',enabled?'ask':'deny');
    });
    this.handle('muse-settings-auto-approve',()=>this.settingsPanel,async enabled => {
      if (typeof enabled !== 'boolean') throw Error('Invalid permission');
      await this.setPreference('browserPolicy',enabled?'allow':'ask');
    });
    this.handle('muse-settings-folder',()=>this.settingsPanel,async mode => {
      if(mode==='all'){await this.setPreference('folder','/');return;}
      const choice = await dialog.showOpenDialog(this.parent(),{ title:'Choose a folder',defaultPath:app.getPath('documents'),properties:['openDirectory'] });
      if (choice.canceled || !choice.filePaths[0]) return;
      const root = await fs.realpath(choice.filePaths[0]);
      await this.setPreference('folder',root);
    });
    this.handle('muse-settings-revoke-folder',()=>this.settingsPanel,()=>this.setPreference('folder',null));
    this.handle('muse-settings-stop',()=>this.settingsPanel,()=>this.stopBrowser());
    this.handle('muse-device-config',()=>this.bridge,()=>({ id:this.id,version:app.getVersion(),commands:deviceSpecs() }),'https://muse.ai');
    this.handle('muse-device-invoke',()=>this.bridge,request=>this.invoke(request),'https://muse.ai');
    this.statusListener = (event,value) => {
      if (!this.trusted(event,this.bridge,'https://muse.ai') || !['waiting','connected','rejected'].includes(value)) return;
      this.setConnection(value);
    };
    ipcMain.on('muse-device-status',this.statusListener);
    this.stopListener = event => { if (event.sender === this.browser.window?.webContents && event.senderFrame === event.sender.mainFrame) void this.stopBrowser().catch(()=>{}); };
    ipcMain.on('muse-browser-stop',this.stopListener);
    this.bridge = new BrowserWindow({ show:false,title:'Muse Linux device link',webPreferences:{ session:this.museSession,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false,preload:path.join(__dirname,'bridge-preload.cjs') } });
    this.bridge.webContents.setWindowOpenHandler(()=>({ action:'deny' }));
    for (const name of ['will-navigate','will-redirect']) this.bridge.webContents.on(name,(event,url)=>{ try{if(new URL(url).origin!=='https://muse.ai')event.preventDefault();}catch{event.preventDefault();} });
    this.bridge.webContents.on('will-attach-webview',event=>event.preventDefault());
    const source = await fs.readFile(path.join(__dirname,'device-bridge.js'),'utf8');
    if(this.destroyed)return;
    this.bridge.webContents.on('did-finish-load',()=>{
      if (this.bridge?.webContents.getURL().startsWith(HOME_URL)) void this.bridge.webContents.executeJavaScript(source).catch(()=>this.setConnection('waiting'));
    });
    this.bridge.webContents.on('render-process-gone',()=>{ this.setConnection('waiting'); this.stopProcesses(); });
    void this.bridge.loadURL(HOME_URL).catch(()=>this.setConnection('waiting'));
    this.reconnectTimer = setInterval(() => {
      if (this.state.connection !== 'connected' && this.bridge && !this.bridge.isDestroyed() && !this.bridge.webContents.isLoadingMainFrame()) void this.bridge.loadURL(HOME_URL).catch(()=>this.setConnection('waiting'));
    }, 30000);
  }

  setConnection(value) {
    if(this.destroyed)return;
    this.state.connection=value;
    if(value!=='waiting'){clearTimeout(this.disconnectTimer);this.disconnectTimer=null;}
    if(value==='rejected')this.stopProcesses();
    else if(value==='waiting'&&!this.disconnectTimer)this.disconnectTimer=setTimeout(()=>{if(this.state.connection!=='connected')this.stopProcesses();},30000);
  }

  settingsState() {
    return {...this.state,computerControl:this.computer?.status(),browserConnection:this.computer?.browserStatus(),isolation:this.computer?.isolationStatus(),browserEnabled:this.state.browserPolicy!=='deny',browserAutoApprove:this.state.browserPolicy==='allow',desktopAvailable:this.desktopAvailable,desktopIndicator:{active:!!this.desktopOverlay?.active,outputs:this.desktopOverlay?.outputs||0},commandAvailable:true,claudeAvailable:this.claudeAvailable,terminalCount:this.terminals?.list().filter(t=>t.running).length||0,dictation:{...this.dictation.state},activeTask:this.nativeTask||(this.browser.sessionId?'Browser automation':null),shortcutStatus:this.shortcutStatus||{},version:app.getVersion()};
  }

  async permission(key,title,message,detail,deadline,signal) {
    if(this.destroyed || signal?.aborted || (this.busy && this.invocationGeneration!==this.stopGeneration) || this.state[key]==='deny'||!Number.isSafeInteger(deadline)||deadline<=Date.now())return false;
    if(this.state[key]==='allow')return true;
    const controller=new AbortController();this.permissionAbort=controller;
    const signals=[controller.signal,AbortSignal.timeout(deadline-Date.now())];if(signal)signals.push(signal);
    const combined=AbortSignal.any(signals);
    try{
      const answer=await dialog.showMessageBox(this.parent(),{type:'question',title,message,detail,buttons:['Deny','Allow this task'],defaultId:0,cancelId:0,signal:combined});
      return answer.response===1&&!combined.aborted&&!this.destroyed&&Date.now()<deadline&&this.state[key]!=='deny';
    }finally{if(this.permissionAbort===controller)this.permissionAbort=null;}
  }

  async setPreference(key,value) {
    this.preferences.validate(key,value);
    if(key==='folder'||key==='blockedApps'||(['browserPolicy','desktopPolicy','commandPolicy','fileWritePolicy'].includes(key)&&value!=='allow')){this.stopGeneration++;this.permissionAbort?.abort();}
    this.state[key]=key==='blockedApps'?[...value]:value;
    const computerStopped=['browserPolicy','desktopPolicy','blockedApps','folder'].includes(key)?this.computer?.stopSync():undefined;
    if(key==='browserPolicy'&&value!=='allow')this.browser.stop();
    if(key==='desktopPolicy'&&value!=='allow')this.desktop.stop();
    if(key==='commandPolicy'&&value!=='allow'){this.commands.stop();this.claude.stop();this.terminals.stop();}
    if(key==='folder'){this.commands.stop();this.claude.stop();this.terminals.stop();}
    if(key==='blockedApps')this.desktop.stop();
    if(key==='dictationEnabled'&&!value)this.dictation.cancel();
    await this.preferences.set(key,value);
    await computerStopped;
    if(['theme','quickShortcut','dictationShortcut','startAtLogin'].includes(key))await this.applyBehavior();
    this.updateActivity();
  }

  async applyBehavior() {
    nativeTheme.themeSource=this.state.theme;
    this.shortcutStatus={};
    for(const key of ['quickShortcut','dictationShortcut']){
      const previous=this.registeredShortcuts?.[key];if(previous)globalShortcut.unregister(previous);
      this.registeredShortcuts??={};const shortcut=this.state[key];
      if(!shortcut){this.registeredShortcuts[key]='';continue;}
      if(key==='dictationShortcut'&&shortcut===this.state.quickShortcut){this.shortcutStatus[key]='conflict';continue;}
      const callback=key==='quickShortcut'?()=>{const parent=this.parent();parent?.show();parent?.focus();}:()=>{void this.dictation.toggle().catch(error=>{this.dictation.update({error:error.message});});};
      const success=globalShortcut.register(shortcut,callback);
      this.registeredShortcuts[key]=success?shortcut:'';this.shortcutStatus[key]=success?'registered':'unavailable';
    }
    const startup=path.join(app.getPath('appData'),'autostart','io.muse.linux.desktop');
    if(this.state.startAtLogin){
      const executable=process.env.APPIMAGE||process.execPath;
      const quote=value=>'"'+value.replace(/[\\"`$]/g,'\\$&')+'"';
      await fs.mkdir(path.dirname(startup),{recursive:true});
      const launch=quote(executable)+(app.isPackaged?'':` ${quote(path.join(__dirname,'..'))}`);
      await fs.writeFile(startup,['[Desktop Entry]','Type=Application','Name=Muse for Linux',`Exec=env -u ELECTRON_RUN_AS_NODE ${launch}`,'Terminal=false','X-GNOME-Autostart-enabled=true',''].join('\n'),{mode:0o600});
    }else await fs.unlink(startup).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }

  updateActivity() {
    if(this.destroyed)return;
    const speech=this.dictation?.state.status;
    const computer=this.computer?.status();
    const label=speech==='listening'?'Listening for dictation':speech==='transcribing'?'Transcribing dictation':computer?.session_id&&computer.state==='paused'?'Computer use paused':this.nativeTask?'Using your computer':computer?.mode==='isolated_desktop'&&computer.state==='ready'?'Using the separate desktop':computer?.mode==='borrowed_browser'&&computer.state==='ready'?'Using the selected browser':this.browser?.sessionId?'Using the browser':this.terminals?.list().some(t=>t.running)?'Running code':null;
    if(label){
      if(!this.tray){this.tray=new Tray(this.icon);this.tray.on('click',()=>{this.parent()?.show();this.parent()?.focus();});}
      this.tray.setToolTip(`Muse · ${label}`);
      this.tray.setContextMenu(Menu.buildFromTemplate([{label,enabled:false},{label:speech==='listening'?'Finish dictation':'Stop',click:()=>{if(speech==='listening')void this.dictation.finish().catch(()=>{});else{void this.stopBrowser().catch(()=>{});this.dictation.cancel();}}},{type:'separator'},{label:'Open Muse',click:()=>{this.parent()?.show();this.parent()?.focus();}}]));
    }else if(this.tray){this.tray.destroy();this.tray=null;}
    const active=!!this.nativeTask||!!this.browser?.sessionId;
    if(active&&this.state.keepAwake){if(this.awakeId===undefined)this.awakeId=powerSaveBlocker.start('prevent-display-sleep');}
    else if(this.awakeId!==undefined){powerSaveBlocker.stop(this.awakeId);this.awakeId=undefined;}
  }

  async insertDictation(text) {
    const parent=this.parent();
    if(!parent||parent.isDestroyed()||new URL(parent.webContents.getURL()).origin!=='https://muse.ai')throw Error('Open a Muse chat before dictating');
    const result=await parent.webContents.executeJavaScript(`(()=>{const t=document.querySelector('textarea[aria-label="Message"]');if(!t||t.disabled)return false;const value=t.value+(t.value?' ':'')+${JSON.stringify(text)};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,value);t.dispatchEvent(new Event('input',{bubbles:true}));t.focus();return true;})()`);
    if(!result)throw Error('Open a Muse chat before dictating');
    if(this.state.dictationAutoSend){await parent.webContents.executeJavaScript(`(()=>{const b=document.querySelector('button[aria-label="Send"]');if(b&&!b.disabled){b.click();return true;}return false;})()`);}
  }

  async invoke(request) {
    if(this.destroyed)throw Error('device_disconnected');
    if (!request || typeof request.command !== 'string' || !Object.hasOwn(deviceSpecs(),request.command) || !request.params || typeof request.params !== 'object' || Array.isArray(request.params) || JSON.stringify(request.params).length > (request.command==='files.import'?12000000:['files.write','files.edit'].includes(request.command)?1600000:/^computer\./.test(request.command)||/^(terminal|claude)\./.test(request.command)?131072:16384)) throw Error('invalid_command');
    const parallel=['environment.describe','terminal.read','terminal.list','terminal.resize','claude.read','claude.list','computer.trace.read','computer.run.result','computer.evidence.read'].includes(request.command);
    if (this.busy && !parallel) throw Error('busy: another local command is running');
    if (!Number.isSafeInteger(request.deadline) || request.deadline<=Date.now() || request.deadline>Date.now()+180000) throw Error('invalid_request_deadline');
    const generation=this.stopGeneration;
    if(!parallel){this.busy=true;this.invocationDeadline=request.deadline;this.invocationGeneration=generation;}
    try {
      const args = { ...request.params, __deadline:request.deadline };
      const computerOutput = request.command.startsWith('computer.') || request.command === 'screen.snap';
      if (computerOutput) { validateObservationOptions(args); parseForceImage(args.force_image); }
      let result=await this.dispatch(request,args,generation);
      if (computerOutput && result && typeof result === 'object') {
        if (result.observation_id && Array.isArray(result.controls)) result=compactObservation(result,args);
        else if (result.observation?.observation_id && Array.isArray(result.observation.controls)) result={...result,observation:compactObservation(result.observation,args)};
      }
      if(this.destroyed || generation!==this.stopGeneration){
        if(['computer.batch','computer.control','computer.action','computer.plan'].includes(request.command) && (result?.receipt || result?.dispatched===true || Array.isArray(result?.outcomes)))return {...result,stopped:true,error:result.error||'stopped_by_user',retryable:false,verification:'Stop ended this session. Inspect each receipt for dispatch and effect. Do not replay uncertain input.'};
        throw Error('stopped_by_user');
      }
      return result;
    } finally { if(!parallel){this.busy=false;this.invocationDeadline=0;} }
  }

  async dispatch(request,args,generation) {
      if(this.computer){
        if(request.command==='computer.trace.read')return this.computer.trace(args);
        if(request.command==='computer.diagnose')return this.computer.diagnose(args);
        if(request.command==='computer.run.result')return this.computer.runResult(args);
        if(request.command==='computer.evidence.read')return this.computer.readEvidence(args);
        if(request.command==='computer.run.start')return this.computer.startRun(args);
        if(request.command==='computer.session'){
          if(args.action==='status')return this.computer.status();
          if(args.action==='pause')return this.computer.pause();
          if(args.action==='end'){if(this.computer.status().state==='paused')return {ended:false,state:'paused',error:'user_resume_required',dispatched:false,required_next:'wait_for_local_user'};this.browser.stop();this.desktop.stop();return this.computer.stop();}
          if(args.action==='start')return this.computer.start(args);
          throw Error('invalid_session_action');
        }
        if(request.command==='computer.observe'||request.command==='screen.snap')return this.computer.observe({...args,...(request.command==='screen.snap'?{image:true}:{})});
        if(request.command==='computer.control')return args.action==='batch'?this.computer.batch(request,args):this.computer.control(request,args);
        if(request.command==='computer.batch')return this.computer.batch(request,args);
        if(request.command==='computer.action')return this.computer.action(request,args);
        if(request.command==='computer.plan')return this.computer.plan(request,args);
      }
      if(this.desktop?.paused){
        const safe=['environment.describe','computer.control','computer.batch','computer.observe','screen.snap','files.list','files.read','files.stat','files.search','files.export','files.upload','terminal.read','terminal.list','terminal.resize','terminal.close','claude.read','claude.list','claude.interrupt','claude.close'];
        if(!safe.includes(request.command) && !(request.command==='computer.session' && ['status','pause'].includes(args.action)))return this.desktop.pauseReceipt({dispatched:false});
      }
      switch (request.command) {
        case 'environment.describe': return { os:'linux',client:'Muse for Linux',version:app.getVersion(),tool_contract:'0.6.0',computer:{execution_protocol:'muse.action_receipt.v1',session:this.computer.status(),browser_connection:this.computer.browserStatus(),isolated_desktop:this.computer.isolationStatus(),routes:['direct_cdp','persistent_atspi','legacy_physical'],handoff_capability:'local_only',control:this.desktop.status(),desktop_context:this.desktopAvailable?'Use computer.control action=desktop_context for monitor/workspace/focus context and actual keybindings':null, native_apps:this.desktopAvailable&&this.state.desktopPolicy!=='deny',browser:this.state.browserPolicy!=='deny',native_permission:this.state.desktopPolicy,browser_permission:this.state.browserPolicy,blocked_apps:this.state.blockedApps,capabilities:{accessibility:true,targeted_keys:false,compositor_keys:true,bulk_text:true,installed_app_launch:true,window_workspace_move:true,compact_observations:true,screenshot_reuse:true,semantic_actions:true,layer_surfaces:true,observation_free_shortcuts:true,batch_max_actions:16,key_names:'Case-insensitive Enter/Return, Tab, arrows, Home/End, PageUp/PageDown, F1-F24 and Ctrl+Shift+P; ctrl/control, Meta/Super/Win aliases; standalone modifiers are supported',pointer:this.desktopAvailable,coordinate_actions:['move','click','double_click','drag','scroll'],coordinate_system:'Normalized 0-1000 inside the freshly observed selected window',visible_indicator:this.desktopAvailable,indicator_active:!!this.desktopOverlay?.active,agent_window:['Muse Local Browser']},screenshots:'Visible, unobscured selected windows only; Muse glow, pill and marker are excluded' },filesystem:{ folder:this.state.folder,write_policy:this.state.fileWritePolicy,text_limit_bytes:262144,binary_limit_bytes:8388608 },dictation:{ available:this.dictation.state.ready,local:true },commands:{ permission:this.state.commandPolicy,one_shot:true,persistent_terminals:true,interactive_pty:true,claude_code:this.claudeAvailable,session_limit:8,capabilities:'Normal user processes; working directory is not a sandbox. Existing Claude login and normal tool permission prompts are used.' } };
        case 'computer.session': {
          if(args.action==='status')return this.desktop.status();
          if(args.action==='pause')return this.desktop.pause();
          if(args.action==='end'){this.browser.stop();this.desktop.stop();this.computerMode=null;return{ended:true};}
          if(args.action!=='start')throw Error('invalid_session_action');
          this.browser.stop();this.desktop.stop();
          this.computerMode=null;
          const mode=args.scope==='desktop'?'desktop':'browser', backend=mode==='desktop'?this.desktop:this.browser;
          let result;try{result=await backend.session(args);}catch(error){backend.stop();throw error;}
          if(this.destroyed || generation!==this.stopGeneration || !backend.sessionId){backend.stop();throw Error('stopped_by_user');}
          this.computerMode=mode;this.updateActivity();return result;
        }
        case 'computer.control': {
          const backend=this.computerMode==='desktop'?this.desktop:this.browser;
          return args.action==='batch'?await backend.batch(args):await backend.control(args);
        }
        case 'computer.batch': return this.computerMode==='desktop'?await this.desktop.batch(args):await this.browser.batch(args);
        case 'computer.observe': return this.computerMode==='desktop'?await this.desktop.observe(args):await this.browser.observe(args);
        case 'screen.snap': return this.computerMode==='desktop'?await this.desktop.observe({...args,image:true}):await this.browser.observe({...args,image:true});
        case 'files.list': return await this.files.list(args);
        case 'files.read': return await this.files.read(args);
        case 'files.write': return await this.files.write(args);
        case 'files.edit': return await this.files.edit(args);
        case 'files.copy': return await this.files.copy(args);
        case 'files.stat': return await this.files.stat(args);
        case 'files.mkdir': return await this.files.mkdir(args);
        case 'files.move': case 'files.rename': return await this.files.move(args);
        case 'files.remove': case 'files.trash': return await this.files.remove(args);
        case 'files.export': case 'files.upload': return await this.files.export(args);
        case 'files.import': return await this.files.import(args);
        case 'files.search': return await this.files.search(args);
        case 'system.run': return await this.commands.run(args,request.deadline);
        case 'terminal.start': return await this.terminals.start(args,request.deadline);
        case 'terminal.write': return await this.terminals.write(args);
        case 'terminal.read': return await this.terminals.read(args);
        case 'terminal.resize': return await this.terminals.resize(args);
        case 'terminal.close': return await this.terminals.close(args);
        case 'terminal.list': return {sessions:this.terminals.list()};
        case 'claude.start': return await this.claude.start(args,request.deadline);
        case 'claude.send': return await this.claude.send(args);
        case 'claude.read': return await this.claude.read(args);
        case 'claude.interrupt': return await this.claude.interrupt(args);
        case 'claude.close': return await this.claude.close(args);
        case 'claude.list': return {sessions:this.claude.list()};
      }
  }

  async showSettings(tab='computer') {
    if(this.destroyed)throw Error('device_disconnected');
    if(!this.settingsPanel || this.settingsPanel.isDestroyed())this.settingsPanel=new SettingsPanel({parent:this.parent});
    await this.settingsPanel.show(tab);
  }

  hideSettings() {
    this.settingsPanel?.hide();
  }

  get settingsVisible() {
    return !!this.settingsPanel?.visible;
  }

  async stopBrowser() {
    this.permissionAbort?.abort();
    for(const key of ['browserPolicy','desktopPolicy','commandPolicy','fileWritePolicy'])if(this.state[key]==='allow'){this.state[key]='ask';this.preferences.values[key]='ask';}
    this.stopProcesses();this.dictation?.cancel();this.computerMode=null;
    this.updateActivity();
    await this.save();
  }

  desktopStateChanged(_status, transition) {
    // A disconnect or helper failure must not silently replace a paused grant.
    if (transition?.endedPaused) {
      for(const key of ['browserPolicy','desktopPolicy','commandPolicy','fileWritePolicy'])if(this.state[key]==='allow'){this.state[key]='ask';this.preferences.values[key]='ask';}
      void this.save().catch(()=>{});
    }
    this.updateActivity();
  }

  stopProcesses(){this.stopGeneration++;this.computerMode=null;this.permissionAbort?.abort();this.computer?.stopSync();this.browser?.stop();this.desktop?.stop();this.commands?.stop();this.claude?.stop();this.terminals?.stop();}

  destroy() {
    if(this.destroying)return this.destroying;
    this.destroyed = true; clearInterval(this.reconnectTimer);clearTimeout(this.disconnectTimer);
    this.permissionAbort?.abort();this.stopProcesses();this.dictation?.cancel();
    this.destroying=this.computer?.close().catch(()=>{});
    this.tray?.destroy();if(this.awakeId!==undefined)powerSaveBlocker.stop(this.awakeId);
    for(const shortcut of Object.values(this.registeredShortcuts||{}))if(shortcut)globalShortcut.unregister(shortcut);
    for (const window of [this.settingsPanel,this.bridge]) if (window && !window.isDestroyed()) window.destroy();
    for (const channel of this.handlers) ipcMain.removeHandler(channel);
    if (this.statusListener) ipcMain.removeListener('muse-device-status',this.statusListener);
    if (this.stopListener) ipcMain.removeListener('muse-browser-stop',this.stopListener);
    return this.destroying;
  }
}

module.exports = { LinuxDevice };
