//! Skill packs across CLIs: each CLI's marketplace offers and installed
//! skills merged by name, searched here, and changed through the CLI.

use std::collections::BTreeMap;
use std::sync::Arc;

use sqlx::SqlitePool;

use super::service::{service, Cached, ExtensionHost, FAILED_TTL, SKILLS_TTL};
use super::types::{
    ExtensionCliError, InstalledSkill, SkillCatalogResponse, SkillInventory, SkillListing,
    SkillRequest, SkillSource,
};
use super::ExtensionError;

/// Every skill name any CLI offers or has installed, at one moment.
#[derive(Debug, Default)]
pub struct SkillSnapshot {
    pub listings: Vec<SkillListing>,
    pub errors: Vec<ExtensionCliError>,
}

/// Which listings a catalog request wants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillFilter {
    All,
    Installed,
    Updates,
}

pub fn merge(inventories: Vec<(String, SkillInventory)>) -> Vec<SkillListing> {
    let mut by_key: BTreeMap<String, SkillListing> = BTreeMap::new();
    for (_, inventory) in inventories {
        for skill in inventory.available {
            listing_for(&mut by_key, &skill.name, skill.description.as_ref())
                .offers
                .push(skill.offer);
        }
        for skill in inventory.installed {
            let description = skill.description.clone();
            listing_for(&mut by_key, &skill.name, description.as_ref())
                .installed
                .push(skill);
        }
    }
    let mut listings: Vec<SkillListing> = by_key.into_values().collect();
    listings.sort_by(|a, b| {
        popularity(b)
            .cmp(&popularity(a))
            .then_with(|| a.key.cmp(&b.key))
    });
    listings
}

fn listing_for<'a>(
    by_key: &'a mut BTreeMap<String, SkillListing>,
    name: &str,
    description: Option<&String>,
) -> &'a mut SkillListing {
    let key = name.trim().to_lowercase();
    let listing = by_key.entry(key.clone()).or_insert_with(|| SkillListing {
        key,
        name: name.trim().to_string(),
        description: None,
        offers: Vec::new(),
        installed: Vec::new(),
    });
    if listing.description.is_none() {
        listing.description = description.filter(|text| !text.trim().is_empty()).cloned();
    }
    listing
}

fn popularity(listing: &SkillListing) -> u64 {
    listing
        .offers
        .iter()
        .filter_map(|offer| offer.install_count)
        .sum()
}

/// Each CLI re-reads its marketplaces from their sources, outside the
/// snapshot lock so readers keep the current one meanwhile. A CLI that
/// cannot reach a marketplace still lists what it has.
async fn refresh_catalogs(hosts: &[ExtensionHost]) -> Vec<ExtensionCliError> {
    let reports = futures::future::join_all(hosts.iter().map(|host| async move {
        let _guard = service().lock_cli(&host.provider_id).await;
        let cli = host.runner()?;
        host.extensions.refresh_skill_catalog(&cli).await
    }))
    .await;
    hosts
        .iter()
        .zip(reports)
        .filter_map(|(host, report)| {
            report.err().map(|error| ExtensionCliError {
                provider_id: host.provider_id.clone(),
                message: error.to_string(),
            })
        })
        .collect()
}

async fn snapshot(read_pool: &SqlitePool, refresh: bool) -> Arc<SkillSnapshot> {
    let service = service();
    let hosts: Vec<_> = service
        .hosts(read_pool)
        .await
        .into_iter()
        .filter(|host| host.cli.is_some() && host.support().skills)
        .collect();
    let mut errors = if refresh {
        refresh_catalogs(&hosts).await
    } else {
        Vec::new()
    };
    let mut cached = service.skills.lock().await;
    if !refresh {
        if let Some(snapshot) = cached.as_ref().and_then(Cached::fresh) {
            return snapshot;
        }
    }
    let reports = futures::future::join_all(hosts.iter().map(|host| async move {
        let cli = host.runner()?;
        host.extensions.skills(&cli).await
    }))
    .await;
    let mut inventories = Vec::new();
    for (host, report) in hosts.iter().zip(reports) {
        match report {
            Ok(inventory) => inventories.push((host.provider_id.clone(), inventory)),
            Err(error) => errors.push(ExtensionCliError {
                provider_id: host.provider_id.clone(),
                message: error.to_string(),
            }),
        }
    }
    let mut listings = merge(inventories);
    // CLIs drop a plugin from their "available" list once it is installed,
    // and with it the only description they had: keep the one seen before.
    if let Some(previous) = cached.as_ref() {
        let known: std::collections::HashMap<&str, &String> = previous
            .value
            .listings
            .iter()
            .filter_map(|listing| Some((listing.key.as_str(), listing.description.as_ref()?)))
            .collect();
        for listing in listings
            .iter_mut()
            .filter(|listing| listing.description.is_none())
        {
            listing.description = known.get(listing.key.as_str()).map(|text| (*text).clone());
        }
    }
    let ttl = if errors.is_empty() {
        SKILLS_TTL
    } else {
        FAILED_TTL
    };
    let snapshot = Arc::new(SkillSnapshot { listings, errors });
    *cached = Some(Cached::new(snapshot.clone(), ttl));
    snapshot
}

pub async fn catalog(
    read_pool: &SqlitePool,
    query: &str,
    filter: SkillFilter,
    offset: usize,
    limit: usize,
    refresh: bool,
) -> SkillCatalogResponse {
    let snapshot = snapshot(read_pool, refresh).await;
    let terms: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    let matching: Vec<&SkillListing> = snapshot
        .listings
        .iter()
        .filter(|listing| match filter {
            SkillFilter::All => true,
            SkillFilter::Installed => !listing.installed.is_empty(),
            SkillFilter::Updates => listing.installed.iter().any(|skill| skill.update.is_some()),
        })
        .filter(|listing| terms.is_empty() || matches_terms(listing, &terms))
        .collect();
    SkillCatalogResponse {
        total: matching.len(),
        skills: matching
            .into_iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect(),
        errors: snapshot.errors.clone(),
    }
}

/// Every term appears in the name, description or a marketplace name.
fn matches_terms(listing: &SkillListing, terms: &[String]) -> bool {
    let haystack = std::iter::once(listing.name.as_str())
        .chain(listing.description.as_deref())
        .chain(
            listing
                .offers
                .iter()
                .map(|offer| offer.marketplace.as_str()),
        )
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    terms.iter().all(|term| haystack.contains(term.as_str()))
}

/// What the CLI reported for `plugin_id`: offered (`installed` false) or installed.
async fn find(
    read_pool: &SqlitePool,
    request: &SkillRequest,
    installed: bool,
) -> Result<Option<InstalledSkill>, ExtensionError> {
    let snapshot = snapshot(read_pool, false).await;
    let mut listings = snapshot.listings.iter();
    if installed {
        return Ok(listings
            .flat_map(|listing| listing.installed.iter())
            .find(|skill| skill.provider_id == request.provider_id && skill.id == request.plugin_id)
            .cloned());
    }
    let offered = listings.any(|listing| {
        listing.offers.iter().any(|offer| {
            offer.provider_id == request.provider_id && offer.plugin_id == request.plugin_id
        })
    });
    if offered {
        Ok(None)
    } else {
        Err(ExtensionError::Invalid(format!(
            "{} is not offered by this CLI's marketplaces",
            request.plugin_id
        )))
    }
}

#[derive(Debug, Clone, Copy)]
pub enum SkillAction {
    Install,
    Remove,
    Update,
}

pub async fn apply(
    read_pool: SqlitePool,
    request: SkillRequest,
    action: SkillAction,
) -> Result<(), ExtensionError> {
    let read_pool = &read_pool;
    let service = service();
    let host = service.host(read_pool, &request.provider_id).await?;
    if !host.support().skills {
        return Err(ExtensionError::Unsupported(format!(
            "{} has no command that installs skill packs.",
            host.label
        )));
    }
    if !matches!(action, SkillAction::Install) {
        let skill = find(read_pool, &request, true).await?.ok_or_else(|| {
            ExtensionError::Invalid(format!(
                "{} is not installed in {}",
                request.plugin_id, host.label
            ))
        })?;
        if skill.source == SkillSource::Local {
            return Err(ExtensionError::Unsupported(format!(
                "{} is a skill folder outside any marketplace; manage it in {}.",
                skill.name,
                skill.path.as_deref().unwrap_or("its skills directory")
            )));
        }
        if let Some(scope) = skill.scope.as_deref().filter(|scope| *scope != "user") {
            return Err(ExtensionError::Unsupported(format!(
                "{} is installed for one project ({scope} scope); manage it from that project.",
                skill.name
            )));
        }
    } else {
        find(read_pool, &request, false).await?;
    }
    let _guard = service.lock_cli(&host.provider_id).await;
    let cli = host.runner()?;
    let result = match action {
        SkillAction::Install => {
            host.extensions
                .install_skill(&cli, &request.plugin_id)
                .await
        }
        SkillAction::Remove => host.extensions.remove_skill(&cli, &request.plugin_id).await,
        SkillAction::Update => host.extensions.update_skill(&cli, &request.plugin_id).await,
    };
    // Even a failure may have changed what the CLI has installed.
    service.invalidate_skills().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::extensions::types::{AvailableSkill, SkillOffer};

    fn offer(provider: &str, name: &str, count: Option<u64>) -> AvailableSkill {
        AvailableSkill {
            name: name.to_string(),
            description: (provider == "claude-code").then(|| format!("{name} skills")),
            offer: SkillOffer {
                provider_id: provider.to_string(),
                plugin_id: format!("{name}@market"),
                marketplace: "market".to_string(),
                version: None,
                install_count: count,
            },
        }
    }

    #[test]
    fn merges_the_same_name_across_clis_and_ranks_by_installs() {
        let listings = merge(vec![
            (
                "codex".to_string(),
                SkillInventory {
                    available: vec![
                        offer("codex", "Figma", None),
                        offer("codex", "linear", None),
                    ],
                    installed: vec![],
                },
            ),
            (
                "claude-code".to_string(),
                SkillInventory {
                    available: vec![
                        offer("claude-code", "figma", Some(10)),
                        offer("claude-code", "zed", Some(50)),
                    ],
                    installed: vec![],
                },
            ),
        ]);
        let keys: Vec<&str> = listings
            .iter()
            .map(|listing| listing.key.as_str())
            .collect();
        assert_eq!(keys, ["zed", "figma", "linear"]);
        let figma = &listings[1];
        assert_eq!(figma.offers.len(), 2);
        assert_eq!(figma.description.as_deref(), Some("figma skills"));
    }
}
