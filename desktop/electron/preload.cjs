const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('rc', {
  config: () => ipcRenderer.invoke('rc:config'),
  pickFiles: () => ipcRenderer.invoke('rc:pick-files'),
  pickFolder: () => ipcRenderer.invoke('rc:pick-folder'),
  saveFile: (defaultName, data) => ipcRenderer.invoke('rc:save-file', defaultName, data),
  trashFile: (filePath) => ipcRenderer.invoke('rc:trash-file', filePath),
  showFile: (filePath) => ipcRenderer.invoke('rc:show-file', filePath),
})
