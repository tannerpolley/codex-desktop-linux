use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "codex-update-manager", about = "Signed Linux-package updater for codex-desktop")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    Daemon,
    CheckNow,
    RebuildCurrent,
    QueuePackage { #[arg(long)] path: PathBuf },
    Status { #[arg(long)] json: bool },
    Diagnose { #[arg(long)] json: bool },
    InstallReady,
    Rollback,
    #[command(hide = true)]
    InstallDeb { #[arg(long)] path: PathBuf },
    #[command(hide = true)]
    InstallRpm { #[arg(long)] path: PathBuf },
    #[command(hide = true)]
    InstallPacman { #[arg(long)] path: PathBuf },
    #[command(hide = true)]
    InstallRollbackDeb { #[arg(long)] path: PathBuf },
    #[command(hide = true)]
    InstallRollbackRpm { #[arg(long)] path: PathBuf },
    #[command(hide = true)]
    InstallRollbackPacman { #[arg(long)] path: PathBuf },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_same_version_rebuild_command() {
        let cli = Cli::try_parse_from(["codex-update-manager", "rebuild-current"]).unwrap();
        assert!(matches!(cli.command, Commands::RebuildCurrent));
    }

    #[test]
    fn parses_local_package_queue_command() {
        let cli = Cli::try_parse_from([
            "codex-update-manager",
            "queue-package",
            "--path",
            "/tmp/codex-desktop.deb",
        ])
        .unwrap();
        assert!(matches!(cli.command, Commands::QueuePackage { .. }));
    }
}
