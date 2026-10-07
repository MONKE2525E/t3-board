const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('museLinuxDevice', {
  config: () => ipcRenderer.invoke('muse-device-config'),
  invoke: request => ipcRenderer.invoke('muse-device-invoke', request),
  status: state => ipcRenderer.send('muse-device-status', state),
});
