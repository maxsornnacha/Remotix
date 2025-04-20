const { contextBridge, ipcRenderer } = require('electron');

const handler = {
  send(channel, value) {
    ipcRenderer.send(channel, value);
  },
  on(channel, callback) {
    const subscription = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  },
  sendInput: (type, payload) => ipcRenderer.send('remote-input', { type, payload })
};

contextBridge.exposeInMainWorld('ipc', handler);
