'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const OK = /^(fx:|panel:|catcher:|app:|air:)/;

contextBridge.exposeInMainWorld('flick', {
  on: (ch, cb) => { if (OK.test(ch)) ipcRenderer.on(ch, (_e, d) => cb(d)); },
  send: (ch, d) => { if (OK.test(ch)) ipcRenderer.send(ch, d); },
  invoke: (ch, d) => (OK.test(ch) ? ipcRenderer.invoke(ch, d) : Promise.reject(new Error('blocked'))),
  pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return null; } },
});
