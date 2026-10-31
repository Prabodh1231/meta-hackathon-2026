// Electron main process: starts the Python backend on a free local port with a per-launch
// token, then opens the window. Set RC_BACKEND_URL to use a backend you started yourself
// (e.g. `uvicorn app.main:app --reload`); the token check is off in that case.
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Dev layout. Packaging (PyInstaller binary in extraResources) is still to do.
const BACKEND_DIR = path.join(__dirname, '..', '..', 'backend')
const SUPPORTED = ['pdf', 'docx', 'pptx', 'md', 'markdown', 'txt', 'html', 'htm', 'png', 'jpg', 'jpeg', 'webp']
const DATA_DIR = process.env.RC_DATA_DIR || path.join(os.homedir(), '.research-companion')
const LOG_PATH = path.join(DATA_DIR, 'logs', 'backend.log')
const MAX_RESTARTS_PER_MINUTE = 3

let backend = null
let backendConfig = null
let spawnArgs = null // { port, token }, reused on restart so the window's config stays valid
let restartTimes = []
let quitting = false

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function pythonExecutable() {
  // Windows: pythonw, the console-less build. A venv's python.exe is only a launcher that
  // starts the real interpreter as a child; started detached, that child got a console
  // window of its own (a stray empty terminal), and closing it killed the backend.
  const venv =
    process.platform === 'win32'
      ? path.join(BACKEND_DIR, '.venv', 'Scripts', 'pythonw.exe')
      : path.join(BACKEND_DIR, '.venv', 'bin', 'python')
  return fs.existsSync(venv) ? venv : process.platform === 'win32' ? 'pythonw' : 'python3'
}

// Backend output goes to the terminal and to a log file, so a failure can be diagnosed
// after the fact (the terminal may be closed or scrolled away).
function log(text) {
  process.stdout.write(text)
  try {
    fs.appendFileSync(LOG_PATH, text)
  } catch {
    /* logging must never take the app down */
  }
}

function spawnBackend() {
  const { port, token } = spawnArgs
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
  log(`\n=== backend starting ${new Date().toISOString()} on port ${port} ===\n`)
  backend = spawn(
    pythonExecutable(),
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: BACKEND_DIR,
      // RC_PARENT_PID: the backend exits by itself if this app dies without cleaning up.
      env: { ...process.env, RC_API_TOKEN: token, RC_PARENT_PID: String(process.pid) },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own hidden console: a Ctrl+C or close in the terminal that launched the app
      // used to kill the backend silently while the window stayed open.
      detached: true,
      windowsHide: true,
    },
  )
  backend.stdout.on('data', (d) => log(d.toString()))
  backend.stderr.on('data', (d) => log(d.toString()))
  backend.on('exit', (code, signal) => {
    backend = null
    log(`=== backend exited (code ${code}, signal ${signal}) ===\n`)
    if (quitting) return
    const now = Date.now()
    restartTimes = restartTimes.filter((t) => now - t < 60_000)
    if (restartTimes.length >= MAX_RESTARTS_PER_MINUTE) {
      log(`=== backend keeps exiting; not restarting again. Details above in ${LOG_PATH} ===\n`)
      return
    }
    restartTimes.push(now)
    setTimeout(() => !quitting && spawnBackend(), 1000)
  })
}

async function startBackend() {
  if (process.env.RC_BACKEND_URL) {
    return { baseUrl: process.env.RC_BACKEND_URL.replace(/\/$/, ''), token: '' }
  }
  spawnArgs = { port: await freePort(), token: crypto.randomBytes(24).toString('hex') }
  spawnBackend()
  return { baseUrl: `http://127.0.0.1:${spawnArgs.port}`, token: spawnArgs.token, logPath: LOG_PATH }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'Research Companion',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // A file dropped where the page doesn't handle it would replace the app with that file,
  // losing unsaved typing.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  // Links the app shows (a cited paper's free page, a Scholar search) open in the system browser,
  // never in an app window that has the backend bridge.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  if (process.env.RC_SMOKE_TEST) win.webContents.once('did-finish-load', smokeTest)
}

// `npm run smoke`: confirm the window loads, the spawned backend answers an authenticated
// request and rejects an unauthenticated one, and comes back by itself after being killed.
async function smokeTest() {
  const { baseUrl, token } = backendConfig
  const authed = async () => {
    for (let i = 0; i < 120; i++) {
      try {
        return await fetch(`${baseUrl}/documents`, { headers: { 'x-rc-token': token } })
      } catch {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    return null
  }
  const first = await authed()
  const noToken = first && (await fetch(`${baseUrl}/documents`))
  console.log(`[smoke] window loaded; backend ${first?.status} with token, ${noToken?.status} without`)
  let ok = !!first?.ok && noToken.status === 401
  if (ok) {
    const oldPid = backend.pid
    backend.kill()
    await new Promise((r) => setTimeout(r, 500))
    const again = await authed()
    const restarted = !!again?.ok && backend && backend.pid !== oldPid
    console.log(`[smoke] backend killed and restarted on the same port: ${restarted}`)
    ok = restarted
  }
  console.log(`[smoke] log file: ${LOG_PATH} (${fs.existsSync(LOG_PATH) ? 'written' : 'missing'})`)
  process.exitCode = ok && fs.existsSync(LOG_PATH) ? 0 : 1
  app.quit()
}

ipcMain.handle('rc:config', () => backendConfig)

ipcMain.handle('rc:pick-files', async (event) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Documents', extensions: SUPPORTED }],
  })
  return res.canceled ? [] : res.filePaths
})

ipcMain.handle('rc:pick-folder', async (event) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    properties: ['openDirectory'],
  })
  return res.canceled ? null : res.filePaths[0]
})

// The renderer can't touch the filesystem, so it hands exported bytes here to save.
ipcMain.handle('rc:save-file', async (event, defaultName, data) => {
  const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    defaultPath: defaultName,
    filters: [{ name: 'Word document', extensions: ['docx'] }],
  })
  if (res.canceled || !res.filePath) return null
  await fs.promises.writeFile(res.filePath, Buffer.from(data))
  return res.filePath
})

// The duplicate finder can move a library file to the Recycle Bin / Trash, never delete it outright.
// Only a file the library actually holds is accepted, so the renderer can't trash arbitrary paths.
async function libraryFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Not a file path')
  const { baseUrl, token } = backendConfig
  const res = await fetch(`${baseUrl}/documents`, { headers: { 'x-rc-token': token } })
  if (!res.ok) throw new Error(`Could not check the library (${res.status})`)
  const same = (a, b) => (process.platform === 'win32' || process.platform === 'darwin'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b))
  if (!(await res.json()).some((d) => same(d.source, filePath))) throw new Error('That file is not in your library')
  const stat = await fs.promises.stat(filePath)
  if (!stat.isFile()) throw new Error('Not a file')
  return filePath
}

ipcMain.handle('rc:trash-file', async (_event, filePath) => {
  await shell.trashItem(await libraryFile(filePath))
  return true
})

ipcMain.handle('rc:show-file', async (_event, filePath) => {
  shell.showItemInFolder(await libraryFile(filePath))
})

// Library PDFs open in a window of their own, in Chromium's PDF viewer: resizable, movable to a
// second screen, open beside the draft. One window, reused for the next PDF; it remembers where
// it was. Only files the library holds are opened, straight from disk.
let pdfWindow = null
let pdfFile = ''
const PDF_BOUNDS = () => path.join(app.getPath('userData'), 'pdf-window.json')

function savedPdfBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(PDF_BOUNDS(), 'utf8'))
    // Only where a screen still is: a second monitor may have been unplugged since.
    const { screen } = require('electron')
    const area = screen.getDisplayMatching(b).workArea
    const visible = b.x < area.x + area.width && b.x + b.width > area.x && b.y < area.y + area.height && b.y + b.height > area.y
    return visible ? b : { width: b.width, height: b.height }
  } catch {
    return { width: 980, height: 1000 }
  }
}

function pdfWindowFor(title) {
  if (pdfWindow && !pdfWindow.isDestroyed()) return pdfWindow
  const saved = savedPdfBounds()
  pdfWindow = new BrowserWindow({
    ...saved,
    minWidth: 420,
    minHeight: 360,
    useContentSize: true,
    title,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }, // no bridge to the backend
  })
  // On a display scaled to a fraction (145% and the like) Electron rounds the size up a few pixels;
  // set it again so the window opens at the size it was left at.
  pdfWindow.setContentSize(saved.width, saved.height)
  // Remember what the user does: the size after a resize, the place after a move. Saving the size
  // on every close would carry those rounding pixels over, and the window would creep larger.
  const keep = (part) => () => {
    if (pdfWindow.isMinimized() || pdfWindow.isMaximized()) return
    let b = {}
    try {
      b = JSON.parse(fs.readFileSync(PDF_BOUNDS(), 'utf8'))
    } catch {
      /* first time */
    }
    if (part === 'size') [b.width, b.height] = pdfWindow.getContentSize()
    else ({ x: b.x, y: b.y } = pdfWindow.getBounds())
    if (!b.width) [b.width, b.height] = pdfWindow.getContentSize()
    fs.promises.writeFile(PDF_BOUNDS(), JSON.stringify(b)).catch(() => {})
  }
  pdfWindow.on('resized', keep('size'))
  pdfWindow.on('moved', keep('place'))
  // The viewer would retitle the window with the file name; the paper's title says more.
  pdfWindow.on('page-title-updated', (e) => e.preventDefault())
  // Links in the PDF open in the system browser; the window only ever shows the library file.
  pdfWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  pdfWindow.webContents.on('will-navigate', (e, url) => {
    if (url.split('#')[0] !== pdfFile) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    }
  })
  pdfWindow.on('closed', () => {
    pdfWindow = null
  })
  return pdfWindow
}

ipcMain.handle('rc:open-pdf', async (_event, filePath, page, title) => {
  const file = await libraryFile(filePath)
  if (!/\.pdf$/i.test(file)) throw new Error('Not a PDF')
  const name = typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : path.basename(file)
  const win = pdfWindowFor(name)
  pdfFile = pathToFileURL(file).href
  win.setTitle(`${name} · PDF`)
  await win.loadURL(`${pdfFile}#page=${Math.max(1, Number.parseInt(page, 10) || 1)}`)
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

app.whenReady().then(async () => {
  backendConfig = await startBackend()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  quitting = true
  if (backend) backend.kill()
})
