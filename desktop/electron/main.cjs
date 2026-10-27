// Electron main process: starts the Python backend on a free local port with a per-launch
// token, then opens the window. Set RC_BACKEND_URL to use a backend you started yourself
// (e.g. `uvicorn app.main:app --reload`); the token check is off in that case.
const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

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
