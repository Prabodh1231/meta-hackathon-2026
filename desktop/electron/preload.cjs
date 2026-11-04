const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('rc', {
  config: () => ipcRenderer.invoke('rc:config'),
  pickFiles: () => ipcRenderer.invoke('rc:pick-files'),
  pickFolder: () => ipcRenderer.invoke('rc:pick-folder'),
  saveFile: (defaultName, data) => ipcRenderer.invoke('rc:save-file', defaultName, data),
  trashFile: (filePath) => ipcRenderer.invoke('rc:trash-file', filePath),
  showFile: (filePath) => ipcRenderer.invoke('rc:show-file', filePath),
  // A library file in its default app (Word, PowerPoint, an image viewer…).
  openFile: (filePath) => ipcRenderer.invoke('rc:open-file', filePath),
  // A library PDF in its own window, at a page.
  openPdf: (filePath, page, title) => ipcRenderer.invoke('rc:open-pdf', filePath, page, title),
  // A library PDF in the app's reader, in its own window, at a page.
  openReader: (docId, page, title) => ipcRenderer.invoke('rc:open-reader', docId, page, title),
  // The demo corpus, copied into the data folder; resolves to that folder.
  copySamples: () => ipcRenderer.invoke('rc:copy-samples'),
  // A dropped file carries no path in the sandboxed page; Electron can tell where it is.
  pathForFile: (file) => webUtils.getPathForFile(file),
})
