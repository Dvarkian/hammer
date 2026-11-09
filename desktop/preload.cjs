/**
 * @file preload.cjs
 * @description The dashboard's only bridge to the desktop shell.
 *
 * The renderer is sandboxed and has no Node access. OAuth pages must open in the user's real
 * browser rather than an embedded Electron window, so this exposes exactly one operation: ask the
 * main process to hand an HTTP(S) URL to the operating system.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hammerDesktop', {
  openExternal: (url) => ipcRenderer.invoke('hammer:open-external', String(url ?? '')),
})
