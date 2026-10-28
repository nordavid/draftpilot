import {
  QUEUE_IDLE_PHASES,
  type ChampionCatalog,
  type DraftpilotApi,
  type LogEntry,
  type QueueError,
  type UiState
} from '@shared/index'

// Sample data for the GUI in a plain browser (no Tauri, no League client).
// URL parameters: ?live=0 (no champ select), ?paused=1, ?lang=de, ?update=2.3.0,
// ?queue=roles-set|not-leader|failed (outcome of "Find match", default: queue starts)

const params = new URLSearchParams(location.search)
const now = Date.now()

let state: UiState = {
  version: 'dev',
  lcu: 'connected',
  phase: params.get('live') === '0' ? 'Lobby' : 'ChampSelect',
  summonerRiotId: 'Summoner#EUW',
  settings: {
    language: params.get('lang') === 'de' ? 'de' : 'en',
    masterEnabled: params.get('paused') !== '1',
    autoAccept: true,
    autoPick: true,
    autoBan: true,
    lockMode: 'auto-lock',
    lockThresholdMs: 3000
  },
  roles: {
    top: { picks: [], bans: [], secondRole: 'fill' },
    jungle: { picks: [64, 254, -1], bans: [], secondRole: 'fill' },
    middle: { picks: [103, 134, 61, 7], bans: [238, 157], secondRole: 'top' },
    bottom: { picks: [], bans: [], secondRole: 'fill' },
    utility: { picks: [], bans: [], secondRole: 'fill' },
    none: { picks: [], bans: [], secondRole: 'fill' }
  },
  live:
    params.get('live') === '0'
      ? null
      : {
          role: 'middle',
          pick: { status: 'hovering', championId: 103, lockAt: now + 9000 },
          ban: { status: 'done', championId: 238, lockAt: null }
        },
  update: params.get('update')
}

const logs: LogEntry[] = [
  { ts: now - 4000, scope: 'lcu', level: 'info', message: 'LCU connected (port 64534, source: lockfile).' },
  { ts: now - 3000, scope: 'champselect', level: 'event', message: 'Entered champ select.' },
  { ts: now - 2000, scope: 'champselect', level: 'info', message: 'Ban: skipping Zed (238) (a teammate wants to play it).' },
  { ts: now - 1000, scope: 'champselect', level: 'event', message: 'BAN: Yasuo (157) with ~2950ms left.' }
]

async function catalog(): Promise<ChampionCatalog> {
  try {
    const versions = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json()) as string[]
    const version = versions[0]
    const json = (await (
      await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`)
    ).json()) as { data: Record<string, { id: string; key: string; name: string }> }
    const champions = Object.values(json.data).map((c) => ({ id: Number(c.key), alias: c.id, name: c.name }))
    return { version, champions }
  } catch {
    return { version: null, champions: [] }
  }
}

const listeners: ((s: UiState) => void)[] = []
const emit = (): UiState => {
  listeners.forEach((l) => l(state))
  return state
}

export const mockApi: DraftpilotApi = {
  getState: async () => state,
  getLogs: async () => logs,
  getChampions: catalog,
  setSettings: async (patch) => {
    state = { ...state, settings: { ...state.settings, ...patch } }
    return emit()
  },
  setRole: async (role, prefs) => {
    state = { ...state, roles: { ...state.roles, [role]: prefs } }
    return emit()
  },
  findMatch: async () => {
    await new Promise((r) => setTimeout(r, 400))
    const outcome = params.get('queue')
    if (!state.phase || !QUEUE_IDLE_PHASES.includes(state.phase)) throw 'busy' satisfies QueueError
    if (outcome === 'not-leader' || outcome === 'failed') throw outcome satisfies QueueError
    if (outcome === 'roles-set') return 'roles-set'
    state = { ...state, phase: 'Matchmaking' }
    emit()
    return 'searching'
  },
  cancelSearch: async () => {
    await new Promise((r) => setTimeout(r, 200))
    state = { ...state, phase: 'Lobby' }
    emit()
  },
  installUpdate: async () => {
    await new Promise((r) => setTimeout(r, 1500))
    throw new Error('Kein Updater im Browser.')
  },
  onState: (cb) => {
    listeners.push(cb)
    return () => listeners.splice(listeners.indexOf(cb), 1)
  },
  onLog: () => () => {},
  onChampions: () => () => {}
}
