const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron')

/** Zoom the whole app one step in or out, or back to 100%; the new size in percent. */
function zoom(step) {
  const level = webFrame.getZoomLevel()
  webFrame.setZoomLevel(step === 'reset' ? 0 : Math.max(-3, Math.min(5, level + (step === 'out' ? -0.5 : 0.5))))
  return Math.round(webFrame.getZoomFactor() * 100)
}

// Ctrl + / − / 0 zoom the whole app, as the window menu's shortcuts did (main.cjs removes that menu on
// Windows and Linux; the Mac's menu still does it). Looked at once the key has gone through the page, so
// a part that zooms itself (the reader's pages) takes it instead by calling preventDefault.
if (process.platform !== 'darwin') {
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || !['=', '+', '-', '_', '0'].includes(e.key)) return
    setTimeout(() => {
      if (!e.defaultPrevented) zoom(e.key === '0' ? 'reset' : e.key === '-' || e.key === '_' ? 'out' : 'in')
    })
  })
}

contextBridge.exposeInMainWorld('rc', {
  config: () => ipcRenderer.invoke('rc:config'),
  // The window's minimise, maximise / restore and close, drawn by the page (WindowButtons.tsx) on Windows
  // and Linux, where the window has no title bar of its own. The Mac keeps its own buttons.
  windowControls: process.platform === 'darwin' ? undefined : {
    minimize: () => ipcRenderer.send('rc:window', 'minimize'),
    toggleMaximize: () => ipcRenderer.send('rc:window', 'toggle-maximize'),
    close: () => ipcRenderer.send('rc:window', 'close'),
    isMaximized: () => ipcRenderer.invoke('rc:window-maximized'),
    // Told when the window is maximised or restored, however it happened. Returns an unsubscribe.
    onMaximized: (callback) => {
      const listener = (_event, maximized) => callback(!!maximized)
      ipcRenderer.on('rc:window-maximized', listener)
      return () => ipcRenderer.removeListener('rc:window-maximized', listener)
    },
  },
  // The ☰ menu: zoom the whole app ('in', 'out', 'reset'; resolves to the new percent), and its current size.
  zoom: (step) => zoom(step),
  zoomPercent: () => Math.round(webFrame.getZoomFactor() * 100),
  // The library's data folder (library, backups, logs) in the file explorer.
  showDataFolder: () => ipcRenderer.invoke('rc:show-data-folder'),
  pickFiles: () => ipcRenderer.invoke('rc:pick-files'),
  pickFolder: () => ipcRenderer.invoke('rc:pick-folder'),
  saveFile: (defaultName, data) => ipcRenderer.invoke('rc:save-file', defaultName, data),
  // The draft as PDF (opts.pdf: saved where the writer picks) or to the system's print dialog.
  printHtml: (html, opts) => ipcRenderer.invoke('rc:print-html', html, opts),
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
  // The page has drawn its first frame, in its theme: the main window is shown then (see createWindow).
  painted: () => ipcRenderer.send('rc:painted'),
  // The demo corpus, copied into the data folder; resolves to that folder.
  copySamples: () => ipcRenderer.invoke('rc:copy-samples'),
  // A dropped file carries no path in the sandboxed page; Electron can tell where it is.
  pathForFile: (file) => webUtils.getPathForFile(file),
})
