import type { LogEntry, LogLevel } from '@shared/index'

// Logging: schreibt zeitgestempelt auf die Main-Prozess-Konsole (im `npm run dev`-Terminal
// sichtbar) und haelt die letzten Eintraege in einem Ringpuffer, den die GUI per IPC
// nachlaedt; neue Eintraege streamt die GUI-Bruecke ueber den Sink live.

const MAX_BUFFER = 500
const buffer: LogEntry[] = []

let sink: ((entry: LogEntry) => void) | null = null

export function setLogSink(cb: ((entry: LogEntry) => void) | null): void {
  sink = cb
}

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  /** Hervorgehobene Ereignisse, z. B. Phasenwechsel, Hover, Lock. */
  event(message: string): void
}

function timestamp(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => n.toString().padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function write(scope: string, level: LogLevel, message: string): void {
  const entry: LogEntry = { ts: Date.now(), scope, level, message }
  buffer.push(entry)
  if (buffer.length > MAX_BUFFER) buffer.shift()
  if (sink) {
    try {
      sink(entry)
    } catch {
      // Sink-Fehler (z. B. Fenster geschlossen) duerfen das Logging nicht stoeren.
    }
  }

  // Bewusst ASCII-only: die Windows-Dev-Konsole rendert UTF-8 sonst als Mojibake.
  const marker = level === 'event' ? '>' : level === 'error' ? 'x' : level === 'warn' ? '!' : '.'
  const line = `${timestamp(entry.ts)} ${marker} [${scope}] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export function createLogger(scope: string): Logger {
  return {
    info: (m) => write(scope, 'info', m),
    warn: (m) => write(scope, 'warn', m),
    error: (m) => write(scope, 'error', m),
    event: (m) => write(scope, 'event', m)
  }
}

/** Snapshot der gepufferten Log-Eintraege (fuer die GUI). */
export function getLogHistory(): LogEntry[] {
  return [...buffer]
}
