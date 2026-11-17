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
  // A library PDF in the app's reader, in its own window, at a page, with `find` (optional) marked there.
  openReader: (docId, page, title, find) => ipcRenderer.invoke('rc:open-reader', docId, page, title, find),
  // From the reader window: put a quote and its citation into the draft in the main window.
  insertQuote: (citation) => ipcRenderer.invoke('rc:insert-quote', citation),
  // In the main window: be told of quotes the reader window sends. Returns an unsubscribe.
  onInsertQuote: (callback) => {
    const listener = (_event, citation) => callback(citation)
    ipcRenderer.on('rc:insert-quote', listener)
    return () => ipcRenderer.removeListener('rc:insert-quote', listener)
  },
  // In the main window: be told when it comes back to the front. Returns an unsubscribe.
  onWindowFocus: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('rc:window-focus', listener)
    return () => ipcRenderer.removeListener('rc:window-focus', listener)
  },
  // In the main window: the window is closing and waits (a few seconds at most) for `callback`,
  // which saves what was typed last. Returns an unsubscribe.
  onBeforeClose: (callback) => {
    const listener = () => {
      Promise.resolve()
        .then(callback)
        .catch(() => {})
        .then(() => ipcRenderer.send('rc:ready-to-close'))
    }
    ipcRenderer.on('rc:before-close', listener)
    ipcRenderer.send('rc:close-guard', true)
    return () => {
      ipcRenderer.removeListener('rc:before-close', listener)
      ipcRenderer.send('rc:close-guard', false)
    }
  },
  // The demo corpus, copied into the data folder; resolves to that folder.
  copySamples: () => ipcRenderer.invoke('rc:copy-samples'),
  // A dropped file carries no path in the sandboxed page; Electron can tell where it is.
  pathForFile: (file) => webUtils.getPathForFile(file),
})
