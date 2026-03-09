use anyhow::Context;
use std::collections::HashMap;
use tokio::sync::mpsc;
use url::Url;

use crate::PeerEvent;

/// Watch for other users in the same room and stream their typing into `peer_tx`.
pub async fn run(
    client: moq_native::Client,
    relay: Url,
    room: String,
    own_username: String,
    peer_tx: mpsc::UnboundedSender<PeerEvent>,
) -> anyhow::Result<()> {
    let origin = moq_lite::Origin::produce();

    let session = client
        .with_consume(origin.clone())
        .connect(relay)
        .await
        .context("subscriber connect")?;

    // Only watch the room's namespace: "moq-chat/{room}/..."
    let room_prefix = format!("moq-chat/{room}");
    let username_prefix = format!("{room_prefix}/");
    let room_path: moq_lite::PathOwned = room_prefix.into();

    let mut consumer = origin
        .consume_only(&[room_path])
        .context("failed to create origin consumer")?;

    tracing::info!(%room, "subscriber watching room");

    // Track per-peer reader tasks so we can cancel them on disconnect.
    let mut peer_tasks: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();

    let track_def = moq_lite::Track {
        name: "typing".to_string(),
        priority: 0,
    };

    loop {
        tokio::select! {
            res = session.closed() => return res.context("subscriber session closed"),
            Some((path, maybe_broadcast)) = consumer.announced() => {
                let path_str = path.as_str().to_string();

                // Extract username from "moq-chat/{room}/{username}"
                let Some(username) = path_str.strip_prefix(&username_prefix) else { continue };
                let username = username.to_string();

                // Never subscribe to ourselves.
                if username == own_username { continue; }

                match maybe_broadcast {
                    Some(broadcast) => {
                        // Cancel any previous reader for this peer.
                        if let Some(prev) = peer_tasks.remove(&username) {
                            prev.abort();
                        }

                        let Ok(track) = broadcast.subscribe_track(&track_def) else {
                            tracing::warn!(%username, "subscribe_track failed");
                            continue;
                        };

                        // Notify the TUI immediately so the peer appears before they type.
                        let _ = peer_tx.send(PeerEvent::Joined(username.clone()));

                        let tx = peer_tx.clone();
                        let uname = username.clone();
                        let handle = tokio::spawn(async move {
                            if let Err(e) = read_peer_track(uname.clone(), track, tx).await {
                                tracing::debug!(%uname, "track reader ended: {e}");
                            }
                        });
                        peer_tasks.insert(username, handle);
                    }
                    None => {
                        // User went offline.
                        if let Some(prev) = peer_tasks.remove(&username) {
                            prev.abort();
                        }
                        let _ = peer_tx.send(PeerEvent::Offline(username));
                    }
                }
            }
        }
    }
}

/// Read all groups from a peer's typing track, forwarding each frame as a `PeerEvent::Update`.
async fn read_peer_track(
    username: String,
    mut track: moq_lite::TrackConsumer,
    peer_tx: mpsc::UnboundedSender<PeerEvent>,
) -> anyhow::Result<()> {
    while let Some(mut group) = track.next_group().await? {
        while let Some(frame) = group.read_frame().await? {
            // Frames may be JSON (TypeScript browser client wire format):
            //   {"text":"...","timestamp":<unix_ms>}
            // or plain UTF-8 (legacy / non-JSON clients).
            // Try JSON first; fall back to raw string so the TUI still works
            // regardless of which client sent the frame.
            let text = parse_typing_frame(&frame);
            let _ = peer_tx.send(PeerEvent::Update(username.clone(), text));
        }
    }
    Ok(())
}

/// Decode a typing frame into a plain display string.
///
/// Accepts both the TypeScript JSON wire format `{"text":"...","timestamp":...}`
/// and raw UTF-8 strings (sent by older or non-JSON clients).
fn parse_typing_frame(frame: &[u8]) -> String {
    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(frame) {
        if let Some(text) = v.get("text").and_then(|t| t.as_str()) {
            return text.to_string();
        }
    }
    String::from_utf8_lossy(frame).into_owned()
}
