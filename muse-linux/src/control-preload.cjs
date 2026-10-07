const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('museLocalBrowser', { stop: () => ipcRenderer.send('muse-browser-stop') });
