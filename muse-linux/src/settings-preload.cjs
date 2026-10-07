const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('museLinuxSettings', {
  state: () => ipcRenderer.invoke('muse-settings-state'),
  preference: (key, value) => ipcRenderer.invoke('muse-settings-preference', key, value),
  folder: mode => ipcRenderer.invoke('muse-settings-folder', mode),
  revokeFolder: () => ipcRenderer.invoke('muse-settings-revoke-folder'),
  stop: () => ipcRenderer.invoke('muse-settings-stop'),
  downloadSpeech: () => ipcRenderer.invoke('muse-settings-speech-download'),
  dictate: () => ipcRenderer.invoke('muse-settings-dictate'),
  cancelDictation: () => ipcRenderer.invoke('muse-settings-dictation-cancel'),
  apps: () => ipcRenderer.invoke('muse-settings-apps'),
  browserConnection: request => ipcRenderer.invoke('muse-settings-browser-connection', request),
  isolation: request => ipcRenderer.invoke('muse-settings-isolation', request),
  control: request => ipcRenderer.invoke('muse-settings-control', request),
  close: () => ipcRenderer.invoke('muse-settings-close'),
});
