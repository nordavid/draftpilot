import { join } from 'node:path'
import { app, shell, BrowserWindow, Menu } from 'electron'
import { createLogger } from './logger'
import { Store } from './state/store'
import { loadInto } from './settings'
import { setupIpc } from './ipc'
import { LcuConnector } from './lcu/connector'
import { GameflowWatcher } from './features/gameflowWatcher'
import { AutoAccept } from './features/autoAccept'
import { SummonerWatcher } from './features/summoner'
import { ChampSelectEngine } from './features/champSelectEngine'
import { ChampionData } from './data/champions'

// Main-Prozess: LCU-Anbindung, Auto-Accept, Champ-Select-Engine und GUI-Bruecke.
// Steuerung + Status + Live-Log laufen ueber das Fenster (src/renderer); Logs erscheinen
// zusaetzlich im Terminal. Einstellungen in userData/config.json.

const BG = '#0b1422'
const winLog = createLogger('window')
let connector: LcuConnector | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    width: 500,
    height: 820,
    minWidth: 440,
    minHeight: 620,
    show: false,
    title: 'Draftpilot',
    backgroundColor: BG,
    // Eigene Titelleiste im App-Design, native Fenster-Buttons als Overlay.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BG, symbolColor: '#8a90a2', height: 44 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // DevTools per F12 (kein Menue vorhanden).
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools()
  })

  // Renderer-Fehler sichtbar machen (sonst nur in den DevTools).
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return // benign: abgebrochener Ladevorgang
    winLog.error(`Renderer-Ladefehler: ${code} ${desc} (${url})`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    winLog.error(`Renderer-Prozess beendet: ${details.reason}`)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function startBackend(): void {
  const store = new Store()
  loadInto(store, createLogger('config'))

  const champions = new ChampionData(createLogger('champions'))
  champions.init()

  connector = new LcuConnector(createLogger('lcu'))
  const watcher = new GameflowWatcher(connector, createLogger('gameflow'))
  // eslint-disable-next-line no-new
  new AutoAccept(connector, watcher, store, createLogger('accept'))
  // eslint-disable-next-line no-new
  new SummonerWatcher(connector, store, createLogger('summoner'))
  const engine = new ChampSelectEngine(connector, store, createLogger('champselect'), (id) =>
    champions.name(id)
  )

  // Verbindungs-/Phasen-Status in den Store spiegeln (fuer die GUI).
  connector.on('connected', () => {
    store.lcuStatus = 'connected'
    store.touch()
    const http = connector?.client
    if (http) void champions.fillFromLcu(http)
  })
  connector.on('disconnected', () => {
    store.lcuStatus = 'searching'
    store.touch()
  })
  watcher.on('phase', (phase) => {
    store.phase = phase
    store.touch()
  })

  setupIpc(store, champions, engine, createLogger('ipc'))
  connector.start()
}

// Single-Instance-Lock: nur eine Instanz (sonst zwei Engines gegen denselben Client).
// Eine zweite Instanz fokussiert das bestehende Fenster.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    startBackend()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  connector?.stop()
})
