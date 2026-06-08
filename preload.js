'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSessions:    ()       => ipcRenderer.invoke('get-sessions'),
  launchSession:  (opts)   => ipcRenderer.invoke('launch-session', opts),
  sendInput:      (opts)   => ipcRenderer.invoke('send-input', opts),
  resizePty:      (opts)   => ipcRenderer.invoke('resize-pty', opts),
  killSession:    (opts)   => ipcRenderer.invoke('kill-session', opts),
  readFile:       (opts)   => ipcRenderer.invoke('read-file', opts),
  openExternal:   (opts)   => ipcRenderer.invoke('open-external', opts),
  revealInExplorer: (opts) => ipcRenderer.invoke('reveal-in-explorer', opts),
  deleteSession:    (opts) => ipcRenderer.invoke('delete-session', opts),
  readJsonl:        (opts) => ipcRenderer.invoke('read-jsonl', opts),
  setTitleBarOverlay: (opts) => ipcRenderer.invoke('set-title-bar-overlay', opts),
  getSetting:     (opts)   => ipcRenderer.invoke('get-setting', opts),
  setSetting:     (opts)   => ipcRenderer.invoke('set-setting', opts),

  // Plans
  listPlans:      ()              => ipcRenderer.invoke('list-plans'),
  readPlan:       (opts)          => ipcRenderer.invoke('read-plan', opts),
  writePlan:      (opts)          => ipcRenderer.invoke('write-plan', opts),
  newPlan:        (opts)          => ipcRenderer.invoke('new-plan', opts),
  deletePlan:     (opts)          => ipcRenderer.invoke('delete-plan', opts),

  // Memory
  listMemory:     ()              => ipcRenderer.invoke('list-memory'),
  readMemory:     (opts)          => ipcRenderer.invoke('read-memory', opts),
  writeMemory:    (opts)          => ipcRenderer.invoke('write-memory', opts),

  // Stats / Projects
  listProjects:   ()              => ipcRenderer.invoke('list-projects'),
  getStats:       ()              => ipcRenderer.invoke('get-stats'),

  onPtyData:      (fn) => ipcRenderer.on('pty-data',      (_, d) => fn(d)),
  onSessionExit:  (fn) => ipcRenderer.on('session-exited',(_, d) => fn(d)),

  offPtyData:     (fn) => ipcRenderer.removeListener('pty-data', fn),
  offSessionExit: (fn) => ipcRenderer.removeListener('session-exited', fn),
});
