// Preload — the only bridge between renderer and main. Context-isolated.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('motion', {
  cfg: () => ipcRenderer.invoke('cfg:get'),
  setKey: (k) => ipcRenderer.invoke('cfg:setKey', k),
  setModel: (m) => ipcRenderer.invoke('cfg:setModel', m),
  setEngine: (e) => ipcRenderer.invoke('cfg:setEngine', e),
  setOnboarded: () => ipcRenderer.invoke('cfg:setOnboarded'),
  imessageCheck: () => ipcRenderer.invoke('imessage:check'),
  imessageInbox: (n) => ipcRenderer.invoke('imessage:inbox', n),
  imessageGrant: () => ipcRenderer.invoke('imessage:grant'),
  openUrl: (u) => ipcRenderer.invoke('open:url', u),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  detectEngines: () => ipcRenderer.invoke('engine:detect'),
  send: (prompt) => ipcRenderer.invoke('agent:send', prompt),
  stop: () => ipcRenderer.invoke('agent:stop'),
  resetChat: () => ipcRenderer.invoke('agent:reset'),
  get: (p) => ipcRenderer.invoke('api:get', p),
  post: (p, b) => ipcRenderer.invoke('api:post', p, b),
  patch: (p, b) => ipcRenderer.invoke('api:patch', p, b),
  del: (p) => ipcRenderer.invoke('api:delete', p),
  onAgent: (cb) => { ipcRenderer.on('agent:event', (_e, ev) => cb(ev)); },
});
