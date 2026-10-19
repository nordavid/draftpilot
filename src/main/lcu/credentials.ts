import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)

// LCU-Credential-Discovery. Zwei Quellen:
//   1. Lockfile im Installordner:  LeagueClient:PID:PORT:TOKEN:PROTOCOL
//   2. Prozess-Argumente von LeagueClientUx.exe (--app-port / --remoting-auth-token)
//      via PowerShell Get-CimInstance — die robustere Quelle.
// Bei jedem Client-Start ändern sich Port und Token, daher immer frisch ermitteln.

export interface LcuCredentials {
  pid?: number
  port: number
  token: string
  protocol: string
  /** https://127.0.0.1:{port} */
  baseUrl: string
  /** "Basic " + base64("riot:" + token) */
  authHeader: string
  /** wss://127.0.0.1:{port}/ */
  wsUrl: string
  source: 'lockfile' | 'process'
}

function build(
  port: number,
  token: string,
  source: LcuCredentials['source'],
  pid?: number
): LcuCredentials {
  return {
    pid,
    port,
    token,
    protocol: 'https',
    baseUrl: `https://127.0.0.1:${port}`,
    authHeader: 'Basic ' + Buffer.from(`riot:${token}`).toString('base64'),
    wsUrl: `wss://127.0.0.1:${port}/`,
    source
  }
}

const DEFAULT_INSTALL_DIRS = [
  'C:\\Riot Games\\League of Legends',
  'C:\\Program Files\\Riot Games\\League of Legends'
]

async function fromLockfile(): Promise<LcuCredentials | null> {
  const dirs = [...DEFAULT_INSTALL_DIRS]
  const override = process.env['LCU_INSTALL_DIR']
  if (override) dirs.unshift(override)

  for (const dir of dirs) {
    try {
      const raw = await readFile(join(dir, 'lockfile'), 'utf8')
      // Format: LeagueClient:PID:PORT:PASSWORD:PROTOCOL
      const parts = raw.trim().split(':')
      if (parts.length >= 5) {
        const port = Number(parts[2])
        const token = parts[3]
        if (port && token) return build(port, token, 'lockfile', Number(parts[1]))
      }
    } catch {
      // Lockfile nicht vorhanden/lesbar an diesem Pfad → nächsten versuchen.
    }
  }
  return null
}

async function fromProcess(): Promise<LcuCredentials | null> {
  if (process.platform !== 'win32') return null

  // -EncodedCommand (UTF-16LE/base64) umgeht jegliches Quoting-Problem.
  const script =
    `Get-CimInstance Win32_Process -Filter "name = 'LeagueClientUx.exe'" ` +
    `| Select-Object -ExpandProperty CommandLine`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')

  try {
    const { stdout } = await pExecFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 }
    )
    const port = stdout.match(/--app-port=(\d+)/)?.[1]
    const token = stdout.match(/--remoting-auth-token=([\w-]+)/)?.[1]
    if (port && token) return build(Number(port), token, 'process')
  } catch {
    // PowerShell-Fehler oder Prozess nicht gefunden → keine Credentials.
  }
  return null
}

/** Versucht Lockfile zuerst, dann (robuster) die Prozess-Argumente. */
export async function discoverCredentials(): Promise<LcuCredentials | null> {
  return (await fromLockfile()) ?? (await fromProcess())
}
