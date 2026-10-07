const { contextBridge,ipcRenderer } = require('electron');
/* global window */
let lastGesture=0;
for(const event of ['pointerdown','keydown'])window.addEventListener(event,e=>{if(e.isTrusted)lastGesture=Date.now();},{capture:true});
contextBridge.exposeInMainWorld('museDesktop',{
  settings:tab=>ipcRenderer.invoke('muse-open-settings',tab),
  dictate:()=>{if(Date.now()-lastGesture>1000)return Promise.reject(Error('Use the dictation button or shortcut'));lastGesture=0;return ipcRenderer.invoke('muse-toggle-dictation');},
  state:()=>ipcRenderer.invoke('muse-desktop-state'),
  cancelDictation:()=>ipcRenderer.invoke('muse-cancel-dictation'),
  stop:()=>ipcRenderer.invoke('muse-stop-all'),
  pause:()=>ipcRenderer.invoke('muse-desktop-pause'),
});
