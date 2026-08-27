//! Updater orchestration for the signed official Linux package.

use crate::{
    builder, cache_cleanup,
    cli::{Cli, Commands},
    config::{RuntimeConfig, RuntimePaths},
    install, install_rollback, liveness, logging, notify, rollback,
    state::{PersistedState, UpdateStatus},
    upstream,
};
use anyhow::{Context, Result};
use chrono::Utc;
use sha2::{Digest, Sha256};
use std::{fs::{self, OpenOptions}, io::Read, path::Path, time::Duration};
use tokio::time;
use tracing::{error, info};

pub async fn run(cli: Cli) -> Result<()> {
    if let Some(result) = run_privileged_command(&cli.command) {
        return result;
    }
    let paths = RuntimePaths::detect()?;
    paths.ensure_dirs()?;
    logging::init(&paths.log_file)?;
    let config = RuntimeConfig::load_or_default(&paths)?;
    let mut state = PersistedState::load_or_default(&paths.state_file, config.auto_install_on_app_exit)?;
    let installed_version = install::installed_package_version();
    let recovered_install = reconcile_interrupted_install(&mut state, &installed_version);
    state.installed_version = installed_version;
    state.save_updater(&paths.state_file)?;
    if config.notifications {
        if let Some(version) = recovered_install {
            if let Err(error) = notify::send("codex-desktop updated", &format!("Installed {version}.")) {
                error!(?error, "completion notification failed");
            }
        }
    }

    match cli.command {
        Commands::Daemon => daemon(&config, &mut state, &paths).await,
        Commands::CheckNow => check(&config, &mut state, &paths, false).await,
        Commands::RebuildCurrent => check(&config, &mut state, &paths, true).await,
        Commands::QueuePackage { path } => queue_package(&config, &mut state, &paths, &path).await,
        Commands::Status { json } => status(&state, json),
        Commands::Diagnose { json } => diagnose(&config, &state, &paths, json),
        Commands::InstallReady => install_ready(&config, &mut state, &paths, true).await,
        Commands::Rollback => rollback::run(&config, &mut state, &paths).await,
        Commands::InstallDeb { .. }
        | Commands::InstallRpm { .. }
        | Commands::InstallPacman { .. }
        | Commands::InstallRollbackDeb { .. }
        | Commands::InstallRollbackRpm { .. }
        | Commands::InstallRollbackPacman { .. } => unreachable!(),
    }
}

async fn queue_package(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    package: &Path,
) -> Result<()> {
    let stable = install::stable_validated_package(package)?;
    install::ensure_upgrade_path_for_current_platform(stable.path())?;
    let digest = sha256_file(stable.path())?;
    let extension = stable.path().file_name().and_then(|name| name.to_str()).unwrap_or("package");
    let queued = paths.cache_dir.join("candidates").join(format!("{digest}-{extension}"));
    if let Some(parent) = queued.parent() { fs::create_dir_all(parent)?; }
    fs::copy(stable.path(), &queued)
        .with_context(|| format!("Failed to queue {}", package.display()))?;

    rollback::record_current_package_as_known_good(state);
    state.candidate_version = state.installed_upstream_version.clone();
    state.candidate_architecture = None;
    state.candidate_repository_path = None;
    state.upstream_package_sha256 = state.installed_upstream_sha256.clone();
    state.artifact_paths.package_path = Some(queued.clone());
    state.status = UpdateStatus::ReadyToInstall;
    state.error_message = None;
    state.save_updater(&paths.state_file)?;
    if config.notifications {
        let _ = notify::send("codex-desktop update ready", "A locally verified ChatGPT Community package is ready.");
    }
    install_ready(config, state, paths, false).await
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 { break; }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

fn reconcile_interrupted_install(state: &mut PersistedState, installed_version: &str) -> Option<String> {
    if state.status != UpdateStatus::Installing
        || installed_version == "unknown"
        || installed_version == state.installed_version
    {
        return None;
    }
    if state.last_known_good_version.as_deref() == Some(installed_version)
        && state.artifact_paths.rollback_package_path.is_some()
    {
        rollback::complete_install(state, installed_version.to_string());
        None
    } else if state.candidate_version.is_some() {
        complete_candidate_install(state, installed_version.to_string());
        Some(installed_version.to_string())
    } else {
        None
    }
}

fn run_privileged_command(command: &Commands) -> Option<Result<()>> {
    match command {
        Commands::InstallDeb { path } => Some(install::install_deb(path)),
        Commands::InstallRpm { path } => Some(install::install_rpm(path)),
        Commands::InstallPacman { path } => Some(install::install_pacman(path)),
        Commands::InstallRollbackDeb { path } => Some(install_rollback::install_deb(path)),
        Commands::InstallRollbackRpm { path } => Some(install_rollback::install_rpm(path)),
        Commands::InstallRollbackPacman { path } => Some(install_rollback::install_pacman(path)),
        _ => None,
    }
}

async fn daemon(config: &RuntimeConfig, state: &mut PersistedState, paths: &RuntimePaths) -> Result<()> {
    time::sleep(config.initial_check_delay_duration()).await;
    if let Err(error) = check(config, state, paths, false).await {
        error!(?error, "initial update check failed");
    }
    let mut checks = time::interval(config.check_interval_duration());
    let mut reconcile = time::interval(Duration::from_secs(15));
    checks.tick().await;
    reconcile.tick().await;
    loop {
        tokio::select! {
            _ = checks.tick() => if let Err(error) = check(config, state, paths, false).await { error!(?error, "periodic update check failed"); },
            _ = reconcile.tick() => {
                if let Ok(latest) = PersistedState::load_or_default(&paths.state_file, config.auto_install_on_app_exit) { *state = latest; }
                if state.status == UpdateStatus::WaitingForAppExit && !liveness::is_app_running(config)? {
                    if let Err(error) = install_ready(config, state, paths, false).await { error!(?error, "deferred install failed"); }
                }
            },
            signal = tokio::signal::ctrl_c() => { signal?; break; }
        }
    }
    Ok(())
}

async fn check(config: &RuntimeConfig, state: &mut PersistedState, paths: &RuntimePaths, force_rebuild: bool) -> Result<()> {
    let _lock = match CheckLock::try_acquire(&paths.state_dir.join("check.lock"))? {
        Some(lock) => lock,
        None => { info!("another update check is active"); return Ok(()); }
    };
    let previous_status = state.status.clone();
    let previous_candidate = state.candidate_version.clone();
    let previous_sha256 = state.upstream_package_sha256.clone();
    let previous_error = state.error_message.clone();
    state.installed_version = install::installed_package_version();
    state.status = UpdateStatus::CheckingUpstream;
    state.last_check_at = Some(Utc::now());
    state.error_message = None;
    state.save_updater(&paths.state_file)?;

    let package_cache = paths.cache_dir.join("packages");
    let metadata = match upstream::resolve_metadata(&config.builder_bundle_root, &config.repository_url, &package_cache).await {
        Ok(value) => value,
        Err(error) => return fail(state, paths, error),
    };
    state.last_successful_check_at = Some(Utc::now());
    let _ = cache_cleanup::prune(&paths.cache_dir, state);

    let same_failed_candidate = previous_status == UpdateStatus::Failed
        && previous_sha256.as_deref() == Some(metadata.sha256.as_str());
    let already_installed = state.installed_upstream_version.as_deref() == Some(metadata.version.as_str())
        && state.installed_upstream_sha256.as_deref() == Some(metadata.sha256.as_str())
        && state.candidate_version.is_none();
    if !force_rebuild && (already_installed || same_failed_candidate) {
        state.status = if same_failed_candidate { UpdateStatus::Failed } else { UpdateStatus::Idle };
        if same_failed_candidate { state.error_message = previous_error; }
        state.save_updater(&paths.state_file)?;
        return Ok(());
    }

    if previous_candidate.as_deref() == Some(metadata.version.as_str())
        && previous_sha256.as_deref() == Some(metadata.sha256.as_str())
        && matches!(previous_status, UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit)
    {
        state.status = previous_status;
        return install_ready(config, state, paths, false).await;
    }

    rollback::record_current_package_as_known_good(state);
    state.candidate_version = Some(metadata.version.clone());
    state.candidate_architecture = Some(metadata.architecture.clone());
    state.candidate_repository_path = Some(metadata.repository_path.clone());
    state.upstream_package_sha256 = Some(metadata.sha256.clone());
    state.status = UpdateStatus::DownloadingPackage;
    state.save_updater(&paths.state_file)?;

    let upstream_package = match upstream::download_verified_package(
        &config.builder_bundle_root,
        &config.repository_url,
        &package_cache,
        &metadata,
    ).await {
        Ok(path) => path,
        Err(error) => return fail(state, paths, error),
    };
    state.artifact_paths.upstream_package_path = Some(upstream_package.clone());
    if let Err(error) = builder::build_update(config, state, paths, &metadata.version, &upstream_package).await {
        return fail(state, paths, error);
    }

    if config.notifications {
        let _ = notify::send("codex-desktop update ready", &format!("Version {} has been rebuilt from OpenAI's signed Linux package.", metadata.version));
    }
    install_ready(config, state, paths, false).await
}

async fn install_ready(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    explicit_retry: bool,
) -> Result<()> {
    if !matches!(state.status, UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit | UpdateStatus::Failed) {
        println!("No rebuilt package is ready to install.");
        return Ok(());
    }
    if state.status == UpdateStatus::Failed && !explicit_retry {
        return Ok(());
    }
    let package = state.artifact_paths.package_path.clone().context("ready state has no package")?;
    anyhow::ensure!(package.is_file(), "rebuilt package is missing: {}", package.display());
    if liveness::is_app_running(config)? {
        state.status = UpdateStatus::WaitingForAppExit;
        state.waiting_for_app_exit_auto_install = config.auto_install_on_app_exit;
        state.save_updater(&paths.state_file)?;
        println!("Update is ready; close ChatGPT Community to install it.");
        return Ok(());
    }
    if !explicit_retry && !config.auto_install_on_app_exit {
        state.status = UpdateStatus::ReadyToInstall;
        state.save_updater(&paths.state_file)?;
        return Ok(());
    }

    state.status = UpdateStatus::Installing;
    state.error_message = None;
    state.save_updater(&paths.state_file)?;
    let current_exe = std::env::current_exe()?;
    let output = install::pkexec_command(&current_exe, &package)
        .output()
        .context("Failed to launch privileged package install")?;
    if !output.status.success() {
        return fail(state, paths, anyhow::anyhow!(
            "privileged install failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    complete_candidate_install(state, install::installed_package_version());
    state.save_updater(&paths.state_file)?;
    let _ = cache_cleanup::prune(&paths.cache_dir, state);
    if config.notifications {
        let _ = notify::send("codex-desktop updated", &format!("Installed {}.", state.installed_version));
    }
    Ok(())
}

fn complete_candidate_install(state: &mut PersistedState, installed_version: String) {
    state.installed_version = installed_version;
    state.installed_upstream_version = state.candidate_version.clone();
    state.installed_upstream_sha256 = state.upstream_package_sha256.clone();
    state.status = UpdateStatus::Installed;
    state.last_known_good_version.get_or_insert_with(|| state.installed_version.clone());
    state.candidate_version = None;
    state.candidate_architecture = None;
    state.candidate_repository_path = None;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message = None;
}

fn fail<T>(state: &mut PersistedState, paths: &RuntimePaths, error: anyhow::Error) -> Result<T> {
    state.mark_failed(format!("{error:#}"));
    state.save_updater(&paths.state_file)?;
    Err(error)
}

fn status(state: &PersistedState, json: bool) -> Result<()> {
    if json { println!("{}", serde_json::to_string_pretty(state)?); }
    else {
        println!("status: {:?}", state.status);
        println!("installed_version: {}", state.installed_version);
        println!("installed_upstream_version: {}", state.installed_upstream_version.as_deref().unwrap_or("unknown"));
        println!("candidate_version: {}", state.candidate_version.as_deref().unwrap_or("none"));
        println!("candidate_sha256: {}", state.upstream_package_sha256.as_deref().unwrap_or("none"));
        if let Some(error) = &state.error_message { println!("error: {error}"); }
    }
    Ok(())
}

fn diagnose(config: &RuntimeConfig, state: &PersistedState, paths: &RuntimePaths, json: bool) -> Result<()> {
    let value = serde_json::json!({
        "repository": config.repository_url,
        "appExecutable": config.app_executable_path,
        "builderBundle": config.builder_bundle_root,
        "stateFile": paths.state_file,
        "stateSchema": state.schema_version,
        "appRunning": liveness::is_app_running(config)?,
        "status": state.status,
    });
    if json { println!("{}", serde_json::to_string_pretty(&value)?); }
    else { println!("repository: {}\napp: {}\nstatus: {:?}", config.repository_url, config.app_executable_path.display(), state.status); }
    Ok(())
}

struct CheckLock(fs::File);
impl CheckLock {
    fn try_acquire(path: &Path) -> Result<Option<Self>> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        match file.try_lock() {
            Ok(()) => Ok(Some(Self(file))),
            Err(fs::TryLockError::WouldBlock) => Ok(None),
            Err(fs::TryLockError::Error(error)) => Err(error.into()),
        }
    }
}
impl Drop for CheckLock { fn drop(&mut self) { let _ = self.0.unlock(); } }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_after_package_upgrade_requests_one_completion_notification() {
        let mut state = PersistedState::new(true);
        state.installed_version = "2026.08.27.100000".into();
        state.candidate_version = Some("26.820.71523".into());
        state.upstream_package_sha256 = Some("signed-sha".into());
        state.status = UpdateStatus::Installing;

        let notification = reconcile_interrupted_install(&mut state, "2026.08.27.110000");

        assert_eq!(notification.as_deref(), Some("2026.08.27.110000"));
        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.installed_upstream_version.as_deref(), Some("26.820.71523"));
        assert_eq!(state.installed_upstream_sha256.as_deref(), Some("signed-sha"));
        assert_eq!(state.candidate_version, None);
        assert_eq!(reconcile_interrupted_install(&mut state, "2026.08.27.110000"), None);
    }

    #[test]
    fn unchanged_installed_version_does_not_claim_success() {
        let mut state = PersistedState::new(true);
        state.installed_version = "2026.08.27.100000".into();
        state.candidate_version = Some("26.820.71523".into());
        state.status = UpdateStatus::Installing;

        reconcile_interrupted_install(&mut state, "2026.08.27.100000");

        assert_eq!(state.status, UpdateStatus::Installing);
        assert_eq!(state.candidate_version.as_deref(), Some("26.820.71523"));
    }

    #[test]
    fn restart_after_rollback_restores_known_good_state() {
        let mut state = PersistedState::new(true);
        state.installed_version = "2026.08.27.110000".into();
        state.installed_upstream_version = Some("26.820.71523".into());
        state.candidate_version = Some("26.821.10000".into());
        state.last_known_good_version = Some("2026.08.27.100000".into());
        state.last_known_good_upstream_version = Some("26.819.90000".into());
        state.artifact_paths.rollback_package_path = Some("known-good.deb".into());
        state.status = UpdateStatus::Installing;

        reconcile_interrupted_install(&mut state, "2026.08.27.100000");

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.installed_upstream_version.as_deref(), Some("26.819.90000"));
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.artifact_paths.package_path, Some("known-good.deb".into()));
    }
}
