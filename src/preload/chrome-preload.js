'use strict';

/**
 * chrome-preload.js
 * ---------------------------------------------------------------------------
 * Runs in the privileged, isolated context of the browser *chrome* (the tab
 * strip + toolbar UI). It exposes a tiny, explicit API to the renderer over
 * contextBridge. No Node.js primitives ever reach the renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('tsb', {
  // --- app / tor -----------------------------------------------------------
  getInfo: () => ipcRenderer.invoke('app:info'),
  getTorStatus: () => ipcRenderer.invoke('tor:get-status'),
  newIdentity: () => ipcRenderer.invoke('tor:new-identity'),
  restartTor: () => ipcRenderer.invoke('tor:restart'),

  // --- tabs ----------------------------------------------------------------
  createTab: (url) => ipcRenderer.invoke('tabs:create', url),
  closeTab: (id) => ipcRenderer.invoke('tabs:close', id),
  activateTab: (id) => ipcRenderer.invoke('tabs:activate', id),
  navigate: (id, url) => ipcRenderer.invoke('tabs:navigate', { id, url }),
  back: (id) => ipcRenderer.invoke('tabs:back', id),
  forward: (id) => ipcRenderer.invoke('tabs:forward', id),
  reload: (id) => ipcRenderer.invoke('tabs:reload', id),
  stop: (id) => ipcRenderer.invoke('tabs:stop', id),

  // --- layout --------------------------------------------------------------
  setContentBounds: (rect) => ipcRenderer.invoke('ui:content-bounds', rect),

  // --- updates -------------------------------------------------------------
  getUpdateStatus: () => ipcRenderer.invoke('update:get-status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openUpdatePage: () => ipcRenderer.invoke('update:open-release'),

  // --- events --------------------------------------------------------------
  onTabsUpdated: (cb) => subscribe('tabs:updated', cb),
  onTorStatus: (cb) => subscribe('tor:status', cb),
  onTorLog: (cb) => subscribe('tor:log', cb),
  onShortcut: (cb) => subscribe('ui:shortcut', cb),
  onUpdateStatus: (cb) => subscribe('update:status', cb),
});
