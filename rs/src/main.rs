use anyhow::Context;
use clap::Parser;
use tokio::sync::mpsc;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};
use url::Url;

mod publish;
mod subscribe;
mod tui;

pub use tui::PeerEvent;

#[derive(Parser)]
#[command(
    name = "moq-chat",
    about = "Live-typing MoQ chat — every keystroke delivered over QUIC"
)]
struct Args {
    /// Relay server URL (e.g. https://localhost:4443)
    #[arg(long, default_value = "https://localhost:4443")]
    relay: Url,

    /// Chat room name
    #[arg(long, default_value = "general")]
    room: String,

    /// Your display name
    #[arg(long)]
    username: String,

    /// MoQ client options (TLS, QUIC backend, etc.)
    #[command(flatten)]
    client: moq_native::ClientConfig,

    /// Log/tracing options
    #[command(flatten)]
    log: moq_native::Log,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    // Redirect all tracing/log output to a file so it never corrupts the TUI.
    // The alternate-screen buffer shares the same tty as stderr; any write to
    // stderr while ratatui is active shows up as garbage on screen.
    let log_file =
        std::fs::File::create("moq-chat.log").context("failed to create moq-chat.log")?;
    let filter = EnvFilter::builder()
        .with_default_directive(args.log.level().into())
        .from_env_lossy();
    tracing_subscriber::registry()
        .with(fmt::layer().with_writer(log_file).with_filter(filter))
        .init();
    // (args.log.init() is intentionally NOT called — it writes to stderr)

    let client = args
        .client
        .init()
        .context("failed to initialise MoQ client")?;

    let (typing_tx, typing_rx) = mpsc::unbounded_channel::<String>();
    let (peer_tx, peer_rx) = mpsc::unbounded_channel::<PeerEvent>();

    let broadcast_name = format!("moq-chat/{}/{}", args.room, args.username);

    // Publish task — announces our typing on the relay.
    let pub_client = client.clone();
    let pub_relay = args.relay.clone();
    let pub_handle = tokio::spawn(async move {
        if let Err(e) = publish::run(pub_client, pub_relay, broadcast_name, typing_rx).await {
            tracing::error!("publisher: {e:#}");
        }
    });

    // Subscribe task — watches for other users in the same room.
    let sub_client = client;
    let sub_relay = args.relay.clone();
    let room = args.room.clone();
    let own_username = args.username.clone();
    let sub_handle = tokio::spawn(async move {
        if let Err(e) = subscribe::run(sub_client, sub_relay, room, own_username, peer_tx).await {
            tracing::error!("subscriber: {e:#}");
        }
    });

    // TUI blocks until the user quits (Esc / Ctrl+C).
    tui::run(args.room, args.username, typing_tx, peer_rx).await?;

    pub_handle.abort();
    sub_handle.abort();

    Ok(())
}
