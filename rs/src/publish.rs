use anyhow::Context;
use tokio::sync::mpsc;
use url::Url;

/// Publish our own typing to the relay.
///
/// Establishes a single MoQ session and writes one frame per keystroke
/// on the `"typing"` track of our broadcast.
///
/// A no-op `"messages"` track is also created so TypeScript browser clients
/// (which subscribe to both "typing" and "messages" for every remote user)
/// receive a clean SUBSCRIBE_OK instead of an error response.
///
/// Wire format: each frame is a UTF-8 JSON object matching the TypeScript
/// `TypingPayload` interface: `{"text":"...","timestamp":<unix_ms>}`.
/// This makes the Rust client interoperable with the TypeScript browser client.
pub async fn run(
    client: moq_native::Client,
    relay: Url,
    broadcast_name: String,
    mut typing_rx: mpsc::UnboundedReceiver<String>,
) -> anyhow::Result<()> {
    let origin = moq_lite::Origin::produce();

    let mut broadcast = moq_lite::Broadcast::produce();
    let track_def = moq_lite::Track {
        name: "typing".to_string(),
        priority: 0,
    };
    let mut track = broadcast
        .create_track(track_def)
        .context("create typing track")?;

    // Create a no-op "messages" track so TypeScript browser clients receive a
    // clean SUBSCRIBE_OK (instead of an error) when they subscribe to it.
    // The Rust TUI never writes to this track; it exists solely for protocol
    // compatibility with the TypeScript SPA.
    let messages_def = moq_lite::Track {
        name: "messages".to_string(),
        priority: 0,
    };
    let _messages_track = broadcast
        .create_track(messages_def)
        .context("create messages track")?;

    origin.publish_broadcast(&broadcast_name, broadcast.consume());

    let session = client
        .with_publish(origin.consume())
        .connect(relay)
        .await
        .context("publisher connect")?;

    tracing::info!(broadcast = %broadcast_name, "publisher connected");

    loop {
        tokio::select! {
            res = session.closed() => return res.context("publisher session closed"),
            msg = typing_rx.recv() => {
                let Some(text) = msg else { break };
                // Encode as JSON to match the TypeScript TypingPayload wire format:
                //   { "text": "<current input>", "timestamp": <unix ms> }
                // This lets the browser SPA decode our frames with group.readJson().
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let payload = serde_json::json!({"text": text, "timestamp": timestamp});
                if let Err(e) = track.write_frame(payload.to_string()) {
                    tracing::warn!("write_frame: {e}");
                }
            }
        }
    }

    Ok(())
}
