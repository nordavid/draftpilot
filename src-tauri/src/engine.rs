//! Champ-Select-Engine. Reagiert auf jedes /lol-champ-select/v1/session-Event:
//!  - Rolle aus `assignedPosition` bestimmen (leer -> Liste "Blind"),
//!  - Pick: ersten verfuegbaren Champion der Rollen-Pickliste hovern (in der Planning-Phase
//!    schon vorab) und kurz vor Ablauf der eigenen Pick-Action locken,
//!  - Ban: ersten erlaubten Champion der Rollen-Banliste hovern und kurz vor Ablauf bannen.
//!    Nie bannen, was ein Teammate (oder wir selbst) picken will.
//!
//! Der echte Pick des Nutzers hat IMMER Vorrang: Die Engine merkt sich jeden Champion, den
//! sie selbst in eine Action geschrieben hat. Steht dort ein anderer, war es der Nutzer ->
//! Automatik fuer diese Action in dieser Champ Select pausieren (kein Hover, kein Lock).
//!
//! Alle Methoden laufen ueber `&mut self` in einer einzigen Task -> LCU-Schreibzugriffe
//! sind automatisch serialisiert (kein Doppel-Lock, kein Hover-Race).

use std::collections::HashSet;
use std::future::Future;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::lcu::{LcuHandle, CHAMP_SELECT_SESSION_URI};
use crate::log::Logger;
use crate::model::{now_ms, ActionStatus, ActionView, LiveView, LockMode, Role, Settings};
use crate::state::Shared;

const PICKABLE_PATH: &str = "/lol-champ-select/v1/pickable-champion-ids";
const ACTIONS_PATH: &str = "/lol-champ-select/v1/session/actions";
/// Draft-Declare-Phase: Pick-Absicht darf gehovert, aber nichts gelockt/gebannt werden.
const PLANNING: &str = "PLANNING";
/// Echte Ban-/Pick-Runde. In PLANNING ist die Ban-Action zwar schon "isInProgress",
/// ein Complete waere dort aber wirkungslos -> Bans nur in dieser Phase.
const BAN_PICK: &str = "BAN_PICK";
/// Auch ohne neues Event regelmaessig neu bewerten: Session-Events kommen unregelmaessig
/// (allein im Custom Game z. B. gar nicht mehr), und pickable-/bannable-Listen sind beim
/// Phasenwechsel teils noch leer.
const REEVALUATE_MS: i64 = 1000;

// --- LCU-Zugriff (abstrahiert fuer Tests) -----------------------------------

pub trait LcuApi: Send + Sync + 'static {
    /// GET -> (Status, JSON) oder None bei Verbindungsfehler.
    fn get_json(&self, path: &str) -> impl Future<Output = Option<(u16, Value)>> + Send;
    fn patch_action(
        &self,
        action_id: i64,
        champion_id: i64,
        completed: bool,
    ) -> impl Future<Output = Result<(), String>> + Send;
}

/// Echte LCU ueber die aktive Verbindung.
pub struct LiveLcu(pub LcuHandle);

impl LcuApi for LiveLcu {
    async fn get_json(&self, path: &str) -> Option<(u16, Value)> {
        let client = self.0.get()?;
        client.get(path).await.ok()
    }

    async fn patch_action(&self, action_id: i64, champion_id: i64, completed: bool) -> Result<(), String> {
        let client = self.0.get().ok_or("no LCU client")?;
        let body = if completed {
            json!({ "championId": champion_id, "completed": true })
        } else {
            json!({ "championId": champion_id })
        };
        let (status, _) = client.patch(&format!("{ACTIONS_PATH}/{action_id}"), body).await?;
        if status >= 400 {
            return Err(format!("HTTP {status}"));
        }
        Ok(())
    }
}

// --- Session-Modell (defensiv: fehlende Felder -> Default) -------------------

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Action {
    pub id: i64,
    pub actor_cell_id: i64,
    pub champion_id: i64,
    pub completed: bool,
    pub is_in_progress: bool,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Player {
    pub cell_id: i64,
    pub champion_id: i64,
    pub champion_pick_intent: i64,
    pub assigned_position: String,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Bans {
    pub my_team_bans: Vec<i64>,
    pub their_team_bans: Vec<i64>,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Timer {
    pub adjusted_time_left_in_phase: f64,
    pub phase: String,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub local_player_cell_id: i64,
    pub actions: Vec<Vec<Action>>,
    pub my_team: Vec<Player>,
    pub bans: Bans,
    pub timer: Timer,
}

impl Session {
    /// Nur echte Sessions (Zelle + Actions vorhanden) akzeptieren.
    pub fn parse(data: &Value) -> Option<Session> {
        data.get("localPlayerCellId")?.as_i64()?;
        data.get("actions")?.as_array()?;
        serde_json::from_value(data.clone()).ok()
    }

    fn me(&self) -> i64 {
        self.local_player_cell_id
    }

    fn all_actions(&self) -> impl Iterator<Item = &Action> {
        self.actions.iter().flatten()
    }

    /// Eigene Action eines Typs: aktive zuerst, dann naechste offene, sonst die letzte erledigte.
    fn own_action(&self, kind: Kind) -> Option<&Action> {
        let mut open = None;
        let mut done = None;
        for a in self.all_actions() {
            if a.actor_cell_id != self.me() || a.kind != kind.as_str() {
                continue;
            }
            if !a.completed && a.is_in_progress {
                return Some(a);
            }
            if !a.completed {
                open = open.or(Some(a));
            } else {
                done = Some(a);
            }
        }
        open.or(done)
    }

    /// Bereits gebannte oder gelockte Champions (beide Teams).
    fn unavailable(&self) -> HashSet<i64> {
        let mut set: HashSet<i64> = self
            .all_actions()
            .filter(|a| a.completed && a.champion_id > 0 && (a.kind == "ban" || a.kind == "pick"))
            .map(|a| a.champion_id)
            .collect();
        set.extend(self.bans.my_team_bans.iter().chain(&self.bans.their_team_bans).filter(|id| **id > 0));
        set
    }

    fn is_ally(&self, cell: i64) -> bool {
        self.my_team.iter().any(|p| p.cell_id == cell)
    }

    /// Champions, die Teammates (ohne uns) picken wollen: Pick-Absicht aus der Planning-Phase,
    /// aktuelle Auswahl und Hover in ihren Pick-Actions.
    fn teammate_claims(&self) -> HashSet<i64> {
        let me = self.me();
        let mut claims = HashSet::new();
        for p in self.my_team.iter().filter(|p| p.cell_id != me) {
            if p.champion_pick_intent > 0 {
                claims.insert(p.champion_pick_intent);
            }
            if p.champion_id > 0 {
                claims.insert(p.champion_id);
            }
        }
        for a in self.all_actions() {
            if a.kind == "pick" && a.actor_cell_id != me && self.is_ally(a.actor_cell_id) && a.champion_id > 0 {
                claims.insert(a.champion_id);
            }
        }
        claims
    }

    /// Was Teammates gerade zum Bannen hovern (fuer "keine Doppel-Bans").
    fn ally_ban_hovers(&self) -> HashSet<i64> {
        let me = self.me();
        self.all_actions()
            .filter(|a| a.kind == "ban" && a.actor_cell_id != me && self.is_ally(a.actor_cell_id) && a.champion_id > 0)
            .map(|a| a.champion_id)
            .collect()
    }

    fn set_action_champion(&mut self, action_id: i64, champion_id: i64) {
        for a in self.actions.iter_mut().flatten() {
            if a.id == action_id {
                a.champion_id = champion_id;
            }
        }
    }
}

// --- Automatik-Zustand je Action --------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Pick,
    Ban,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Pick => "pick",
            Kind::Ban => "ban",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Kind::Pick => "Pick",
            Kind::Ban => "Ban",
        }
    }
}

struct Track {
    kind: Kind,
    action_id: Option<i64>,
    target: Option<i64>,
    /// Alle Champions, die WIR in diese Action geschrieben haben (Hover/Lock).
    writes: HashSet<i64>,
    /// Nutzer hat selbst gewaehlt -> Automatik fuer diese Action pausiert.
    manual: bool,
    /// Wir haben die Action abgeschlossen (bzw. es laeuft gerade ein Versuch).
    locked: bool,
    /// Timer-Snapshot fuer die zeitbasierte Lock-Entscheidung.
    time_left_ms: f64,
    time_left_at: i64,
    view: Option<ActionView>,
    // Log-Dedup
    logged_target: Option<i64>,
    logged_none: bool,
    logged_unavailable: HashSet<i64>,
    last_error: Option<String>,
    /// Champions, die der Client beim Hovern abgelehnt hat -> naechsten Kandidaten nehmen.
    rejected: HashSet<i64>,
}

impl Track {
    fn new(kind: Kind) -> Track {
        Track {
            kind,
            action_id: None,
            target: None,
            writes: HashSet::new(),
            manual: false,
            locked: false,
            time_left_ms: 0.0,
            time_left_at: 0,
            view: None,
            logged_target: None,
            logged_none: false,
            logged_unavailable: HashSet::new(),
            last_error: None,
            rejected: HashSet::new(),
        }
    }

    /// Neue Action (andere ID) -> frischer Zustand.
    fn bind(&mut self, action_id: i64) {
        if self.action_id != Some(action_id) {
            *self = Track::new(self.kind);
            self.action_id = Some(action_id);
        }
    }

    fn set_view(&mut self, status: ActionStatus, champion_id: Option<i64>) {
        self.view = Some(ActionView { status, champion_id, lock_at: None });
    }

    fn remaining_ms(&self) -> f64 {
        self.time_left_ms - (now_ms() - self.time_left_at) as f64
    }
}

// --- Engine ------------------------------------------------------------------

pub type NameFn = Arc<dyn Fn(i64) -> String + Send + Sync>;

pub struct Engine<L: LcuApi> {
    lcu: L,
    shared: Arc<Shared>,
    log: Logger,
    name_of: NameFn,
    active: bool,
    session: Option<Session>,
    /// Empfangszeit (epoch ms) der Session -> Basis fuer die Timer-Fortrechnung.
    session_at: i64,
    last_evaluation: i64,
    role: Option<Role>,
    pick: Track,
    ban: Track,
    announced_passive: bool,
}

impl<L: LcuApi> Engine<L> {
    pub fn new(lcu: L, shared: Arc<Shared>, log: Logger, name_of: NameFn) -> Engine<L> {
        Engine {
            lcu,
            shared,
            log,
            name_of,
            active: false,
            session: None,
            session_at: 0,
            last_evaluation: 0,
            role: None,
            pick: Track::new(Kind::Pick),
            ban: Track::new(Kind::Ban),
            announced_passive: false,
        }
    }

    /// Neues Session-Event (None = Champ Select vorbei / Verbindung weg).
    pub async fn on_session(&mut self, data: Option<Value>) {
        match data.as_ref().and_then(Session::parse) {
            Some(session) => {
                self.session = Some(session);
                self.session_at = now_ms();
                if !self.active {
                    self.active = true;
                    self.log.event("Entered champ select.");
                }
                self.evaluate().await;
            }
            None => self.end(),
        }
    }

    /// Tool waehrend laufender Champ Select gestartet: einmalig den Ist-Stand holen.
    pub async fn fetch_initial(&mut self) {
        if let Some((200, data)) = self.lcu.get_json(CHAMP_SELECT_SESSION_URI).await {
            if Session::parse(&data).is_some() {
                self.on_session(Some(data)).await;
            }
        }
    }

    /// Nach Aenderung von Einstellungen/Listen sofort neu bewerten.
    pub async fn refresh(&mut self) {
        if self.active {
            self.evaluate().await;
        }
    }

    /// Timer fortrechnen (Events feuern nicht kontinuierlich) -> ggf. locken/bannen;
    /// etwa jede Sekunde komplett neu bewerten.
    pub async fn tick(&mut self) {
        if !self.active {
            return;
        }
        if now_ms() - self.last_evaluation >= REEVALUATE_MS {
            self.evaluate().await;
            return;
        }
        let mut pick = std::mem::replace(&mut self.pick, Track::new(Kind::Pick));
        let changed_pick = self.maybe_lock(&mut pick).await;
        self.pick = pick;
        let mut ban = std::mem::replace(&mut self.ban, Track::new(Kind::Ban));
        let changed_ban = self.maybe_lock(&mut ban).await;
        self.ban = ban;
        if changed_pick || changed_ban {
            self.publish();
        }
    }

    fn settings(&self) -> Settings {
        self.shared.store().settings.clone()
    }

    fn enabled(&self, kind: Kind) -> bool {
        let s = self.settings();
        s.master_enabled && if kind == Kind::Pick { s.auto_pick } else { s.auto_ban }
    }

    fn label(&self, id: i64) -> String {
        format!("{} ({id})", (self.name_of)(id))
    }

    /// pickable-IDs. None = unbekannt (Fehler oder leere Liste: der Client fuellt sie beim
    /// Phasenwechsel teils verspaetet).
    async fn fetch_ids(&self, path: &str) -> Option<HashSet<i64>> {
        match self.lcu.get_json(path).await {
            Some((200, Value::Array(list))) if !list.is_empty() => {
                Some(list.iter().filter_map(Value::as_i64).collect())
            }
            _ => None,
        }
    }

    async fn evaluate(&mut self) {
        let Some(session) = self.session.clone() else { return };
        self.last_evaluation = now_ms();

        let position = session
            .my_team
            .iter()
            .find(|p| p.cell_id == session.me())
            .map(|p| p.assigned_position.as_str())
            .unwrap_or("");
        let role = Role::from_position(position);
        if self.role != Some(role) {
            self.role = Some(role);
            if role == Role::None {
                self.log.info("Role: none assigned (using the \"Blind\" list).");
            } else {
                self.log.info(format!("Role: {}.", role.key()));
            }
        }
        let prefs = self.shared.store().roles.get(role).clone();

        if session.own_action(Kind::Pick).is_none() && !self.announced_passive {
            self.log.info("No pick action of our own (e.g. ARAM) - auto-pick stays idle.");
            self.announced_passive = true;
        }

        // Pick zuerst: der Pick-Kandidat fliesst in die Ban-Ausschluesse ein.
        let mut pick = std::mem::replace(&mut self.pick, Track::new(Kind::Pick));
        self.evaluate_pick(&session, &mut pick, &prefs.picks).await;
        self.pick = pick;
        let mut ban = std::mem::replace(&mut self.ban, Track::new(Kind::Ban));
        self.evaluate_ban(&session, &mut ban, &prefs.bans).await;
        self.ban = ban;
        self.publish();
    }

    /// Gemeinsamer Teil fuer Pick und Ban: Action binden, erledigte/manuelle Faelle
    /// abhandeln. Liefert die offene Action, wenn die Automatik weitermachen darf.
    fn prepare(&self, session: &Session, t: &mut Track, list: &[i64]) -> Option<Action> {
        let Some(action) = session.own_action(t.kind).cloned() else {
            t.view = None;
            return None;
        };
        t.bind(action.id);

        if action.completed {
            let id = (action.champion_id > 0).then_some(action.champion_id);
            let ours = id.is_some_and(|id| t.writes.contains(&id)) && !t.manual;
            t.set_view(if ours { ActionStatus::Done } else { ActionStatus::Manual }, id);
            return None;
        }

        if !self.enabled(t.kind) {
            t.set_view(ActionStatus::Off, None);
            return None;
        }

        // Manuelle Wahl: ein echter Champion in der Action, den wir nie geschrieben haben.
        let live = action.champion_id;
        if !t.manual && live > 0 && !t.writes.contains(&live) {
            t.manual = true;
            self.log.event(format!(
                "Manual {} detected ({}) - automation paused for this champ select.",
                t.kind.as_str(),
                self.label(live)
            ));
        }
        if t.manual {
            t.set_view(ActionStatus::Manual, (live > 0).then_some(live));
            return None;
        }

        if list.is_empty() {
            t.target = None;
            t.set_view(ActionStatus::Empty, None);
            return None;
        }
        Some(action)
    }

    /// Ziel gefunden/geaendert bzw. keins verfuegbar -> einmalig loggen.
    fn note_target(&self, t: &mut Track, target: Option<i64>) {
        t.target = target;
        match target {
            None => {
                if !t.logged_none {
                    self.log.warn(format!(
                        "{}: no champion from the list available - doing nothing.",
                        t.kind.title()
                    ));
                    t.logged_none = true;
                }
                t.logged_target = None;
            }
            Some(id) => {
                t.logged_none = false;
                if t.logged_target != Some(id) {
                    self.log.event(format!("{} target: {}.", t.kind.title(), self.label(id)));
                    t.logged_target = Some(id);
                }
            }
        }
    }

    fn note_skipped(&self, t: &mut Track, id: i64, reason: &str) {
        if t.logged_unavailable.insert(id) {
            self.log.info(format!("{}: skipping {} ({reason}).", t.kind.title(), self.label(id)));
        }
    }

    /// Schreibt einen Hover in die Action (merkt ihn als unseren, bevor das Echo eintrifft).
    async fn hover(&mut self, t: &mut Track, action: &Action, target: i64) -> bool {
        if action.champion_id == target {
            return true;
        }
        t.writes.insert(target);
        match self.lcu.patch_action(action.id, target, false).await {
            Ok(()) => {
                // Lokalen Stand sofort nachziehen, damit der Lock nicht auf das Echo wartet.
                if let Some(session) = self.session.as_mut() {
                    session.set_action_champion(action.id, target);
                }
                let what = if t.kind == Kind::Pick { "Hover" } else { "Ban hover" };
                self.log.info(format!("{what}: {}.", self.label(target)));
                t.last_error = None;
                true
            }
            Err(err) => {
                // Vom Client abgelehnt (HTTP-Fehler) -> diesen Champion ueberspringen.
                if err.starts_with("HTTP ") {
                    t.rejected.insert(target);
                }
                if t.last_error.as_deref() != Some(err.as_str()) {
                    self.log.warn(format!("Hovering {} failed: {err}", self.label(target)));
                    t.last_error = Some(err);
                }
                false
            }
        }
    }

    // --- Pick ---------------------------------------------------------------

    async fn evaluate_pick(&mut self, session: &Session, t: &mut Track, list: &[i64]) {
        let Some(action) = self.prepare(session, t, list) else { return };

        // Verfuegbarkeit unklar -> im Zweifel nichts tun.
        let Some(pickable) = self.fetch_ids(PICKABLE_PATH).await else {
            if t.view.is_none() {
                t.set_view(ActionStatus::Waiting, None);
            }
            return;
        };

        let unavailable = session.unavailable();
        let claims = session.teammate_claims();
        let mut target = None;
        for &c in list {
            if unavailable.contains(&c) || t.rejected.contains(&c) {
                continue;
            }
            // Wer zuerst hovert, behaelt ihn: einen Champ, den wir schon halten, nicht abgeben.
            if claims.contains(&c) && action.champion_id != c {
                self.note_skipped(t, c, "a teammate wants to play it");
                continue;
            }
            if !pickable.contains(&c) {
                self.note_skipped(t, c, "not pickable - not owned?");
                continue;
            }
            target = Some(c);
            break;
        }
        self.note_target(t, target);
        let Some(target) = target else {
            t.set_view(ActionStatus::None, None);
            return;
        };

        let our_turn = action.is_in_progress;
        let planning = session.timer.phase == PLANNING;
        if !our_turn && !planning {
            t.set_view(ActionStatus::Waiting, Some(target)); // z. B. waehrend der Ban-Phase
            return;
        }
        if !self.hover(t, &action, target).await {
            return;
        }
        if !our_turn {
            t.set_view(ActionStatus::Waiting, Some(target)); // Pre-Hover in der Planning-Phase
            return;
        }
        t.time_left_ms = session.timer.adjusted_time_left_in_phase;
        t.time_left_at = self.session_at;
        self.set_active_view(t, target);
        self.maybe_lock(t).await;
    }

    // --- Ban ----------------------------------------------------------------

    async fn evaluate_ban(&mut self, session: &Session, t: &mut Track, list: &[i64]) {
        let Some(action) = self.prepare(session, t, list) else { return };

        // Nie bannen, was Teammates spielen wollen - und auch nicht unsere eigene Pick-Absicht.
        let unavailable = session.unavailable();
        let mut wanted = session.teammate_claims();
        if let Some(me) = session.my_team.iter().find(|p| p.cell_id == session.me()) {
            if me.champion_pick_intent > 0 {
                wanted.insert(me.champion_pick_intent);
            }
        }
        if let Some(own) = session.own_action(Kind::Pick) {
            if own.champion_id > 0 {
                wanted.insert(own.champion_id);
            }
        }
        if let Some(target) = self.pick.target {
            wanted.insert(target);
        }
        // Bewusst KEIN Abgleich mit bannable-champion-ids: die Liste war im Test leer bzw.
        // unvollstaendig und hat jeden Ban verhindert. Der Client prueft selbst; lehnt er ab,
        // landet der Champion in `rejected` und der naechste der Liste ist dran.
        let ally_bans = session.ally_ban_hovers();

        let mut target = None;
        for &c in list {
            if unavailable.contains(&c) || t.rejected.contains(&c) {
                continue;
            }
            if wanted.contains(&c) {
                self.note_skipped(t, c, "you or a teammate want to play it");
                continue;
            }
            // Keine Doppel-Bans: was ein Teammate schon hovert, ueberspringen (ausser wir waren zuerst).
            if ally_bans.contains(&c) && action.champion_id != c {
                self.note_skipped(t, c, "a teammate is already banning it");
                continue;
            }
            target = Some(c);
            break;
        }
        self.note_target(t, target);
        let Some(target) = target else {
            t.set_view(ActionStatus::None, None);
            return;
        };

        // Hovern und Bannen nur in der echten Ban-Runde (nie in PLANNING).
        if !action.is_in_progress || session.timer.phase != BAN_PICK {
            t.set_view(ActionStatus::Waiting, Some(target));
            return;
        }
        if !self.hover(t, &action, target).await {
            return;
        }
        t.time_left_ms = session.timer.adjusted_time_left_in_phase;
        t.time_left_at = self.session_at;
        self.set_active_view(t, target);
        self.maybe_lock(t).await;
    }

    // --- Lock (Pick + Ban) --------------------------------------------------

    fn set_active_view(&self, t: &mut Track, target: i64) {
        let s = self.settings();
        if s.lock_mode == LockMode::HoverOnly {
            t.set_view(ActionStatus::HoverOnly, Some(target));
            return;
        }
        let lock_at = t.time_left_at + t.time_left_ms as i64 - s.lock_threshold_ms as i64;
        t.view = Some(ActionView { status: ActionStatus::Hovering, champion_id: Some(target), lock_at: Some(lock_at) });
    }

    /// Lockt/bannt das Ziel, sobald die fortlaufend berechnete Restzeit unter der Schwelle
    /// liegt. Liefert true, wenn sich die Anzeige geaendert hat.
    async fn maybe_lock(&mut self, t: &mut Track) -> bool {
        let s = self.settings();
        if !self.enabled(t.kind) || t.manual || t.locked || s.lock_mode != LockMode::AutoLock {
            return false;
        }
        let (Some(target), Some(action_id)) = (t.target, t.action_id) else { return false };
        let Some(session) = self.session.as_ref() else { return false };
        if t.kind == Kind::Ban && session.timer.phase != BAN_PICK {
            return false;
        }
        let remaining = t.remaining_ms();
        if remaining > s.lock_threshold_ms as f64 {
            return false;
        }

        // Action muss noch unsere, aktiv und offen sein.
        let Some(action) = session.own_action(t.kind) else { return false };
        if action.id != action_id || action.completed || !action.is_in_progress {
            return false;
        }

        // Harte Sicherung: nur locken, was gerade wirklich als unser Ziel gehovert ist.
        if action.champion_id != target {
            let live = action.champion_id;
            if live > 0 && !t.writes.contains(&live) {
                t.manual = true;
                self.log.event(format!(
                    "Different champion selected ({}) - auto-lock paused.",
                    self.label(live)
                ));
                t.set_view(ActionStatus::Manual, Some(live));
                return true;
            }
            return false;
        }

        t.locked = true; // optimistisch gegen Doppel-Lock; bei Fehler zuruecksetzen
        match self.lcu.patch_action(action_id, target, true).await {
            Ok(()) => {
                let what = if t.kind == Kind::Pick { "LOCK" } else { "BAN" };
                self.log.event(format!(
                    "{what}: {} with ~{}ms left.",
                    self.label(target),
                    remaining.max(0.0).round() as i64
                ));
                t.set_view(ActionStatus::Done, Some(target));
                true
            }
            Err(err) => {
                t.locked = false;
                if t.last_error.as_deref() != Some(err.as_str()) {
                    self.log.error(format!("{} failed: {err}", if t.kind == Kind::Pick { "Lock" } else { "Ban" }));
                    t.last_error = Some(err);
                }
                false
            }
        }
    }

    // --- GUI / Lebenszyklus -------------------------------------------------

    /// Live-Stand in den Store spiegeln (nur bei Aenderung pushen).
    fn publish(&self) {
        let next = match (self.active, self.role) {
            (true, Some(role)) => Some(LiveView { role, pick: self.pick.view.clone(), ban: self.ban.view.clone() }),
            _ => None,
        };
        let mut store = self.shared.store();
        if store.live != next {
            store.live = next;
            drop(store);
            self.shared.touch();
        }
    }

    fn end(&mut self) {
        if self.active {
            self.log.info("Champ select ended - engine reset.");
        }
        self.active = false;
        self.session = None;
        self.session_at = 0;
        self.last_evaluation = 0;
        self.role = None;
        self.pick = Track::new(Kind::Pick);
        self.ban = Track::new(Kind::Ban);
        self.announced_passive = false;
        self.publish();
    }
}

// --- Tests: simulierte Champ Selects gegen eine Fake-LCU ---------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::LogHub;
    use crate::model::RolePrefs;
    use std::sync::Mutex;
    use std::time::Duration;

    const AHRI: i64 = 103;
    const SYNDRA: i64 = 134;
    const ORI: i64 = 61;
    const ZED: i64 = 238;
    const YASUO: i64 = 157;
    const YONE: i64 = 777;
    const LUX: i64 = 99;
    const ME: i64 = 2;

    #[derive(Clone)]
    struct FakeLcu {
        session: Arc<Mutex<Session>>,
        pickable: Arc<Mutex<Vec<i64>>>,
        bannable: Arc<Mutex<Vec<i64>>>,
        /// Champions, die der "Client" beim PATCH ablehnt (HTTP 500).
        refuse: Arc<Mutex<Vec<i64>>>,
    }

    impl LcuApi for FakeLcu {
        async fn get_json(&self, path: &str) -> Option<(u16, Value)> {
            if path.ends_with("pickable-champion-ids") {
                return Some((200, json!(*self.pickable.lock().unwrap())));
            }
            if path.ends_with("bannable-champion-ids") {
                return Some((200, json!(*self.bannable.lock().unwrap())));
            }
            Some((404, Value::Null))
        }

        async fn patch_action(&self, action_id: i64, champion_id: i64, completed: bool) -> Result<(), String> {
            if self.refuse.lock().unwrap().contains(&champion_id) {
                return Err("HTTP 500".into());
            }
            let mut s = self.session.lock().unwrap();
            for a in s.actions.iter_mut().flatten() {
                if a.id == action_id {
                    a.champion_id = champion_id;
                    if completed {
                        a.completed = true;
                        a.is_in_progress = false;
                    }
                }
            }
            Ok(())
        }
    }

    fn draft_session() -> Session {
        let bans = (0..10)
            .map(|c| Action { id: 100 + c, actor_cell_id: c, is_in_progress: true, kind: "ban".into(), ..Default::default() })
            .collect();
        let mut actions = vec![bans];
        for c in 0..5 {
            actions.push(vec![Action { id: 200 + c, actor_cell_id: c, kind: "pick".into(), ..Default::default() }]);
        }
        let positions = ["top", "jungle", "middle", "bottom", "utility"];
        Session {
            local_player_cell_id: ME,
            actions,
            my_team: (0..5)
                .map(|c| Player { cell_id: c, assigned_position: positions[c as usize].into(), ..Default::default() })
                .collect(),
            bans: Bans::default(),
            timer: Timer { adjusted_time_left_in_phase: 30000.0, phase: PLANNING.into() },
        }
    }

    struct Harness {
        fake: FakeLcu,
        shared: Arc<Shared>,
        engine: Engine<FakeLcu>,
    }

    impl Harness {
        fn new(session: Session) -> Harness {
            let hub = LogHub::new();
            let shared = Shared::new(hub.clone(), "test".into());
            shared.store().roles.middle = RolePrefs { picks: vec![AHRI, SYNDRA, ORI], bans: vec![ZED, YASUO, YONE] };
            let fake = FakeLcu {
                session: Arc::new(Mutex::new(session)),
                pickable: Arc::new(Mutex::new(vec![AHRI, SYNDRA, ORI, LUX])),
                bannable: Arc::new(Mutex::new(vec![AHRI, SYNDRA, ORI, ZED, YASUO, YONE, LUX])),
                refuse: Arc::new(Mutex::new(Vec::new())),
            };
            let engine = Engine::new(fake.clone(), shared.clone(), Logger::new(&hub, "test"), Arc::new(|id| id.to_string()));
            Harness { fake, shared, engine }
        }

        fn edit(&self, f: impl FnOnce(&mut Session)) {
            f(&mut self.fake.session.lock().unwrap());
        }

        async fn emit(&mut self) {
            let data = serde_json::to_value(self.fake.session.lock().unwrap().clone()).unwrap();
            self.engine.on_session(Some(data)).await;
        }

        fn own(&self, kind: &str) -> Action {
            let s = self.fake.session.lock().unwrap();
            let action = s.all_actions().find(|a| a.actor_cell_id == ME && a.kind == kind).cloned();
            action.unwrap()
        }

        fn live(&self) -> Option<LiveView> {
            self.shared.store().live.clone()
        }

        fn end_bans(&self) {
            self.edit(|s| {
                for a in s.actions[0].iter_mut() {
                    a.completed = true;
                    a.is_in_progress = false;
                }
            });
        }
    }

    #[tokio::test]
    async fn ranked_draft_full_flow() {
        let mut h = Harness::new(draft_session());

        // A1 Planning: Pre-Hover Ahri, kein Ban-Hover
        h.emit().await;
        assert_eq!(h.own("pick").champion_id, AHRI);
        assert!(!h.own("pick").completed);
        assert_eq!(h.own("ban").champion_id, 0, "no ban hover in planning");

        // A2 Teammate will Zed spielen -> Ban-Ziel Yasuo
        h.edit(|s| {
            s.my_team[1].champion_pick_intent = ZED;
            s.timer = Timer { adjusted_time_left_in_phase: 25000.0, phase: BAN_PICK.into() };
        });
        h.emit().await;
        assert_eq!(h.own("ban").champion_id, YASUO);
        assert!(!h.own("ban").completed);

        // A3 Teammate hovert Yasuo als Ban -> wir halten Yasuo (zuerst gehovert)
        h.edit(|s| s.actions[0][3].champion_id = YASUO);
        h.emit().await;
        assert_eq!(h.own("ban").champion_id, YASUO);

        // A4 Ban-Timer < Schwelle -> Ban wird abgeschickt
        h.edit(|s| s.timer.adjusted_time_left_in_phase = 2000.0);
        h.emit().await;
        assert!(h.own("ban").completed && h.own("ban").champion_id == YASUO);

        // A5 Gegner bannt Ahri, unsere Pick-Runde startet -> Syndra
        h.end_bans();
        h.edit(|s| {
            s.actions[0][7].champion_id = AHRI;
            s.bans.their_team_bans = vec![AHRI];
            s.actions[3][0].is_in_progress = true; // Pick-Action von Zelle 2
            s.timer = Timer { adjusted_time_left_in_phase: 30000.0, phase: BAN_PICK.into() };
        });
        h.emit().await;
        assert_eq!(h.own("pick").champion_id, SYNDRA);
        assert!(!h.own("pick").completed);
        let live = h.live().unwrap();
        assert_eq!(live.pick.as_ref().unwrap().status, ActionStatus::Hovering);
        assert!(live.pick.unwrap().lock_at.is_some());

        // A6 Restzeit faellt per Tick unter 3 s (ohne Event) -> Lock
        h.edit(|s| s.timer.adjusted_time_left_in_phase = 3400.0);
        h.emit().await;
        assert!(!h.own("pick").completed, "not locked at 3.4s");
        tokio::time::sleep(Duration::from_millis(500)).await;
        h.engine.tick().await;
        assert!(h.own("pick").completed && h.own("pick").champion_id == SYNDRA);

        h.engine.on_session(None).await;
        assert!(h.live().is_none());
    }

    #[tokio::test]
    async fn manual_pick_wins() {
        let mut h = Harness::new(draft_session());
        h.emit().await;
        assert_eq!(h.own("pick").champion_id, AHRI);

        // Nutzer waehlt selbst Lux
        h.edit(|s| s.actions[3][0].champion_id = LUX);
        h.emit().await;
        assert_eq!(h.live().unwrap().pick.unwrap().status, ActionStatus::Manual);

        // Pick-Runde, Timer laeuft ab -> kein Lock, kein Ueberschreiben
        h.end_bans();
        h.edit(|s| {
            s.actions[3][0].is_in_progress = true;
            s.timer = Timer { adjusted_time_left_in_phase: 1500.0, phase: BAN_PICK.into() };
        });
        h.emit().await;
        h.engine.tick().await;
        assert_eq!(h.own("pick").champion_id, LUX);
        assert!(!h.own("pick").completed);
    }

    #[tokio::test]
    async fn skips_champion_a_teammate_declared() {
        let mut h = Harness::new(draft_session());
        h.edit(|s| s.my_team[4].champion_pick_intent = AHRI);
        h.emit().await;
        assert_eq!(h.own("pick").champion_id, SYNDRA);
    }

    #[tokio::test]
    async fn blind_pick_and_master_toggle() {
        let mut session = draft_session();
        session.actions.remove(0); // keine Bans
        for p in session.my_team.iter_mut() {
            p.assigned_position.clear();
        }
        session.actions[2][0].is_in_progress = true;
        session.timer = Timer { adjusted_time_left_in_phase: 2000.0, phase: BAN_PICK.into() };
        let mut h = Harness::new(session);

        // Liste "Blind" leer -> nichts tun
        h.emit().await;
        assert_eq!(h.own("pick").champion_id, 0);
        let live = h.live().unwrap();
        assert_eq!(live.role, Role::None);
        assert_eq!(live.pick.unwrap().status, ActionStatus::Empty);
        assert!(live.ban.is_none());

        // Master aus -> nichts
        h.shared.store().roles.none = RolePrefs { picks: vec![LUX], bans: vec![] };
        h.shared.store().settings.master_enabled = false;
        h.emit().await;
        assert_eq!(h.own("pick").champion_id, 0);
        assert_eq!(h.live().unwrap().pick.unwrap().status, ActionStatus::Off);

        // Master an -> Lux hovern + locken (ohne neues Event)
        h.shared.store().settings.master_enabled = true;
        h.engine.refresh().await;
        assert_eq!(h.own("pick").champion_id, LUX);
        assert!(h.own("pick").completed);
    }

    #[tokio::test]
    async fn hover_only_never_locks() {
        let mut h = Harness::new(draft_session());
        h.shared.store().settings.lock_mode = LockMode::HoverOnly;
        h.end_bans();
        h.edit(|s| {
            s.actions[3][0].is_in_progress = true;
            s.timer = Timer { adjusted_time_left_in_phase: 1000.0, phase: BAN_PICK.into() };
        });
        h.emit().await;
        h.engine.tick().await;
        assert_eq!(h.own("pick").champion_id, AHRI);
        assert!(!h.own("pick").completed);
        assert_eq!(h.live().unwrap().pick.unwrap().status, ActionStatus::HoverOnly);
    }

    /// Solo-Custom-Draft (Bug-Report v2.0.0): bannable-Liste leer, danach kommen keine Events
    /// mehr. Trotzdem muss gehovert und rechtzeitig gebannt werden.
    #[tokio::test]
    async fn bans_without_bannable_list_and_without_further_events() {
        let mut session = draft_session();
        session.my_team.retain(|p| p.cell_id == ME);
        session.actions[0].retain(|a| a.actor_cell_id == ME || a.actor_cell_id >= 5);
        session.timer = Timer { adjusted_time_left_in_phase: 4100.0, phase: BAN_PICK.into() };
        let mut h = Harness::new(session);
        h.fake.bannable.lock().unwrap().clear();

        h.emit().await;
        assert_eq!(h.own("ban").champion_id, ZED, "hovered although bannable list is empty");
        assert!(!h.own("ban").completed);

        // Kein weiteres Event: nach > 1 s Neubewertung + fortgerechneter Timer -> Ban.
        tokio::time::sleep(Duration::from_millis(1200)).await;
        h.engine.tick().await;
        assert!(h.own("ban").completed, "banned via periodic re-evaluation");
        assert_eq!(h.own("ban").champion_id, ZED);
    }

    /// Eine unvollstaendige bannable-Liste darf den Ban nicht verhindern.
    #[tokio::test]
    async fn ignores_incomplete_bannable_list() {
        let mut h = Harness::new(draft_session());
        *h.fake.bannable.lock().unwrap() = vec![AHRI];
        h.edit(|s| s.timer = Timer { adjusted_time_left_in_phase: 20000.0, phase: BAN_PICK.into() });
        h.emit().await;
        assert_eq!(h.own("ban").champion_id, ZED);
    }

    /// pickable-Liste zu Beginn der eigenen Runde leer -> spaeter ohne Event nachholen.
    #[tokio::test]
    async fn picks_once_pickable_list_arrives_late() {
        let mut h = Harness::new(draft_session());
        h.end_bans();
        h.edit(|s| {
            s.actions[3][0].is_in_progress = true;
            s.timer = Timer { adjusted_time_left_in_phase: 30000.0, phase: BAN_PICK.into() };
        });
        h.fake.pickable.lock().unwrap().clear();
        h.emit().await;
        assert_eq!(h.own("pick").champion_id, 0, "nothing hovered while pickable is unknown");

        *h.fake.pickable.lock().unwrap() = vec![AHRI, SYNDRA];
        tokio::time::sleep(Duration::from_millis(1100)).await;
        h.engine.tick().await;
        assert_eq!(h.own("pick").champion_id, AHRI);
        assert!(!h.own("pick").completed, "timer must not be reset by re-evaluation");
    }

    /// Lehnt der Client einen Ban ab, wird der naechste Kandidat genommen.
    #[tokio::test]
    async fn falls_back_when_client_refuses_a_champion() {
        let mut h = Harness::new(draft_session());
        h.fake.refuse.lock().unwrap().push(ZED);
        h.edit(|s| s.timer = Timer { adjusted_time_left_in_phase: 20000.0, phase: BAN_PICK.into() });
        h.emit().await;
        assert_eq!(h.own("ban").champion_id, 0);
        h.emit().await;
        assert_eq!(h.own("ban").champion_id, YASUO);
    }

    #[test]
    fn rejects_non_sessions() {
        assert!(Session::parse(&json!({ "foo": 1 })).is_none());
        assert!(Session::parse(&json!({ "localPlayerCellId": 1, "actions": [] })).is_some());
    }
}
