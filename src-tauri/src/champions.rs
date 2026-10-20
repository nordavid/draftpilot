//! Champion catalog (ID, name, icon key) for the GUI picker and readable logs.
//! Source: Riot's public Data Dragon (works without a running client). On every start and
//! language change it syncs with the current patch, so new champions appear automatically.
//! Cached per language in champions-<locale>.json. No internet and no cache: falls back to
//! the LCU (without icons).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::lcu::LcuClient;
use crate::log::Logger;
use crate::model::{Champion, ChampionCatalog, Language};

const DDRAGON: &str = "https://ddragon.leagueoflegends.com";

#[derive(Deserialize)]
struct DDragonChampion {
    id: String,
    key: String,
    name: String,
}

#[derive(Deserialize)]
struct DDragonFile {
    data: HashMap<String, DDragonChampion>,
}

struct Inner {
    catalog: ChampionCatalog,
    /// Data Dragon locale of the current catalog (None = from the LCU).
    catalog_locale: Option<String>,
    names: HashMap<i64, String>,
    language: Language,
}

type OnChange = Box<dyn Fn(&ChampionCatalog) + Send + Sync>;

pub struct ChampionData {
    inner: RwLock<Inner>,
    /// Serializes syncs; the LCU fallback waits for a running sync.
    refresh_lock: tokio::sync::Mutex<()>,
    dir: PathBuf,
    http: reqwest::Client,
    log: Logger,
    on_change: OnChange,
}

impl ChampionData {
    pub fn new(dir: PathBuf, language: Language, log: Logger, on_change: OnChange) -> ChampionData {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        let data = ChampionData {
            inner: RwLock::new(Inner {
                catalog: ChampionCatalog::default(),
                catalog_locale: None,
                names: HashMap::new(),
                language,
            }),
            refresh_lock: tokio::sync::Mutex::new(()),
            dir,
            http,
            log,
            on_change,
        };
        data.load_cache();
        data
    }

    pub fn get(&self) -> ChampionCatalog {
        self.inner.read().unwrap().catalog.clone()
    }

    pub fn name(&self, id: i64) -> String {
        self.inner.read().unwrap().names.get(&id).cloned().unwrap_or_else(|| format!("#{id}"))
    }

    /// Language change: use the new language's cache right away, then sync with Data Dragon.
    pub async fn set_language(&self, language: Language) {
        {
            let mut inner = self.inner.write().unwrap();
            if inner.language == language {
                return;
            }
            inner.language = language;
        }
        self.load_cache();
        self.refresh().await;
    }

    /// Sync with the current Data Dragon version (on error, cache/LCU data stays).
    pub async fn refresh(&self) {
        let _guard = self.refresh_lock.lock().await;
        let language = self.inner.read().unwrap().language;
        let locale = language.locale();
        let result: Result<Option<(String, Vec<Champion>)>, String> = async {
            let versions: Vec<String> = self.fetch_json(&format!("{DDRAGON}/api/versions.json")).await?;
            let version = versions.into_iter().next().ok_or("no versions")?;
            {
                let inner = self.inner.read().unwrap();
                let current = inner.catalog.version.as_deref() == Some(version.as_str())
                    && inner.catalog_locale.as_deref() == Some(locale);
                if current && !inner.catalog.champions.is_empty() {
                    return Ok(None);
                }
            }
            let file: DDragonFile = self
                .fetch_json(&format!("{DDRAGON}/cdn/{version}/data/{locale}/champion.json"))
                .await?;
            let champions = file
                .data
                .into_values()
                .filter_map(|c| {
                    let id = c.key.parse::<i64>().ok().filter(|id| *id > 0)?;
                    Some(Champion { id, alias: c.id, name: c.name })
                })
                .collect();
            Ok(Some((version, champions)))
        }
        .await;

        match result {
            Ok(Some((version, champions))) => {
                if self.inner.read().unwrap().language != language {
                    return; // language changed meanwhile
                }
                let count = champions.len();
                self.set(
                    ChampionCatalog { version: Some(version.clone()), champions: sort_by_name(champions) },
                    Some(locale),
                    true,
                );
                self.log.info(format!("Champion list updated (patch {version}, {count} champions)."));
            }
            Ok(None) => {}
            Err(err) => {
                self.log.warn(format!("Data Dragon unreachable ({err}) - using cache or League client."))
            }
        }
    }

    /// Fallback when Data Dragon was unreachable: list from the League client.
    pub async fn fill_from_lcu(&self, client: &LcuClient) {
        let _guard = self.refresh_lock.lock().await;
        if !self.inner.read().unwrap().catalog.champions.is_empty() {
            return;
        }
        let Ok((200, Value::Array(list))) =
            client.get("/lol-game-data/assets/v1/champion-summary.json").await
        else {
            return;
        };
        // IDs from 3000 up are special-mode variants (e.g. Swarm), not pickable champions.
        let champions: Vec<Champion> = list
            .iter()
            .filter_map(|c| {
                let id = c.get("id")?.as_i64().filter(|id| *id > 0 && *id < 3000)?;
                Some(Champion {
                    id,
                    alias: c.get("alias")?.as_str()?.to_string(),
                    name: c.get("name")?.as_str()?.to_string(),
                })
            })
            .collect();
        let count = champions.len();
        self.set(ChampionCatalog { version: None, champions: sort_by_name(champions) }, None, false);
        self.log.info(format!("Champion list loaded from the League client ({count})."));
    }

    fn load_cache(&self) {
        let locale = self.inner.read().unwrap().language.locale();
        let Ok(text) = std::fs::read_to_string(self.cache_path(locale)) else { return };
        let Ok(catalog) = serde_json::from_str::<ChampionCatalog>(&text) else { return };
        if !catalog.champions.is_empty() {
            self.set(catalog, Some(locale), false);
        }
    }

    fn set(&self, catalog: ChampionCatalog, locale: Option<&str>, persist: bool) {
        {
            let mut inner = self.inner.write().unwrap();
            inner.names = catalog.champions.iter().map(|c| (c.id, c.name.clone())).collect();
            inner.catalog = catalog.clone();
            inner.catalog_locale = locale.map(str::to_string);
        }
        (self.on_change)(&catalog);
        if let (true, Some(locale)) = (persist, locale) {
            let _ = std::fs::create_dir_all(&self.dir);
            if let Ok(text) = serde_json::to_string(&catalog) {
                let _ = std::fs::write(self.cache_path(locale), text); // the cache is optional
            }
        }
    }

    fn cache_path(&self, locale: &str) -> PathBuf {
        self.dir.join(format!("champions-{locale}.json"))
    }

    async fn fetch_json<T: serde::de::DeserializeOwned>(&self, url: &str) -> Result<T, String> {
        let res = self.http.get(url).send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("HTTP {}", res.status().as_u16()));
        }
        res.json::<T>().await.map_err(|e| e.to_string())
    }
}

fn sort_by_name(mut list: Vec<Champion>) -> Vec<Champion> {
    // Rough, language-neutral sort (ignores accents/apostrophes, e.g. "Kai'Sa").
    let key = |s: &str| -> String {
        s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
    };
    list.sort_by(|a, b| key(&a.name).cmp(&key(&b.name)));
    list
}
