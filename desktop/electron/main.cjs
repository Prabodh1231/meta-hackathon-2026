// Electron main process: starts the Python backend on a free local port with a per-launch
// token, then opens the window. Set RC_BACKEND_URL to use a backend you started yourself
// (e.g. `uvicorn app.main:app --reload`); the token check is off in that case.
const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

// Dev layout. Packaging (PyInstaller binary in extraResources) is still to do.
const BACKEND_DIR = path.join(__dirname, '..', '..', 'backend')
const SUPPORTED = ['pdf', 'docx', 'pptx', 'md', 'markdown', 'txt', 'html', 'htm', 'png', 'jpg', 'jpeg', 'webp']

let backend = null
let backendConfig = null

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
  const venv =
    process.platform === 'win32'
      ? path.join(BACKEND_DIR, '.venv', 'Scripts', 'python.exe')
      : path.join(BACKEND_DIR, '.venv', 'bin', 'python')
  return fs.existsSync(venv) ? venv : process.platform === 'win32' ? 'python' : 'python3'
}

async function startBackend() {
  if (process.env.RC_BACKEND_URL) {
    return { baseUrl: process.env.RC_BACKEND_URL.replace(/\/$/, ''), token: '' }
  }
  const port = await freePort()
  const token = crypto.randomBytes(24).toString('hex')
  backend = spawn(
    pythonExecutable(),
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)],
    { cwd: BACKEND_DIR, env: { ...process.env, RC_API_TOKEN: token }, stdio: 'inherit' },
  )
  backend.on('exit', (code) => {
    backend = null
    if (code) console.error(`[backend] exited with code ${code}`)
  })
  return { baseUrl: `http://127.0.0.1:${port}`, token }
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

// `npm run smoke`: confirm the window loads and the spawned backend answers an
// authenticated request, then quit.
async function smokeTest() {
  const { baseUrl, token } = backendConfig
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${baseUrl}/documents`, { headers: { 'x-rc-token': token } })
      const noToken = await fetch(`${baseUrl}/documents`)
      console.log(`[smoke] window loaded; backend ${res.status} with token, ${noToken.status} without`)
      process.exitCode = res.ok && noToken.status === 401 ? 0 : 1
      return app.quit()
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  console.log('[smoke] backend never became ready')
  process.exitCode = 1
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
  if (backend) backend.kill()
})
