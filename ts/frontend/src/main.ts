// =============================================================================
// Application Entry Point – main.ts
// =============================================================================
//
// This module is the top-level coordinator.  It glues together:
//   - The lobby UI  (src/ui/lobby.ts)
//   - The chat room UI  (src/ui/chat-room.ts)
//   - The MoQ connection  (src/moq/connection.ts)
//   - The MoQ publisher  (src/moq/publisher.ts)
//   - The MoQ subscriber  (src/moq/subscriber.ts)
//
// ─── Application flow ─────────────────────────────────────────────────────────
//
//   1. App starts → render Lobby.
//   2. User fills in username + room, clicks "Join".
//   3. connectToRelay()  ← establishes the QUIC/WebSocket connection.
//   4. startPublishing(roomId, username)
//      - Creates a Broadcast at `moq-chat/{roomId}/{username}`.
//      - Announces it to the relay so other users can discover us.
//      - Starts the track-request-serving loop in the background.
//   5. startSubscribing(roomId, username, ...callbacks)
//      - Subscribes to the announced broadcasts prefix `moq-chat/{roomId}/`.
//      - As other users join, subscribes to their "typing" and "messages" tracks.
//      - Fires callbacks that update the Chat Room UI.
//   6. Render Chat Room.
//   7. User types → publishTypingUpdate(text) → relay → other users' screens.
//   8. User sends → publishMessage(text, username) → relay → other users' lists.
//   9. User leaves → stopSubscribing() + stopPublishing() + disconnectFromRelay()
//      → render Lobby again.
//
// =============================================================================

import "./ui/styles.css";

import { connectToRelay, disconnectFromRelay } from "./moq/connection";
import {
    publishTypingUpdate,
    startPublishing,
    stopPublishing,
} from "./moq/publisher";
import {
    startSubscribing,
    stopSubscribing,
} from "./moq/subscriber";
import { renderChatRoom } from "./ui/chat-room";
import { renderLobby } from "./ui/lobby";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * The single root element all UI is rendered into.
 * Defined in index.html as `<div id="app"></div>`.
 */
const app = document.getElementById("app")!;

/** Start by showing the lobby. */
renderLobby(app, onJoin);

// ─── Lobby → Room transition ──────────────────────────────────────────────────

/**
 * Handles the "Join" button click from the lobby.
 *
 * This async function:
 *  1. Connects to the MoQ relay (may throw – caught by the lobby's error handler).
 *  2. Starts publishing this user's broadcast.
 *  3. Starts subscribing to other users' broadcasts.
 *  4. Swaps the lobby DOM for the chat room DOM.
 *
 * @param username - Validated username from the lobby form.
 * @param roomId   - Validated room ID from the lobby form.
 */
async function onJoin(username: string, roomId: string): Promise<void> {
    // ── Step 1: Connect to the MoQ relay ─────────────────────────────────────
    // connectToRelay() establishes a QUIC or WebSocket session with the relay.
    // For local development, @moq/lite automatically fetches the relay's
    // self-signed TLS fingerprint from http://localhost:4443/certificate.sha256
    // and uses it for WebTransport's serverCertificateHashes.
    await connectToRelay();

    // ── Step 2: Publish our own broadcast ────────────────────────────────────
    // This registers us on the relay under `moq-chat/{roomId}/{username}`.
    // Other users will discover us via the relay's announcement stream.
    await startPublishing(roomId, username);

    // ── Step 3: Render the chat room ─────────────────────────────────────────
    // We pass callbacks so the room can tell us when the user types or sends.
    const roomUI = renderChatRoom(
        app,
        roomId,
        username,
        // onLeave: called when the user clicks "Leave".
        onLeave,
    );

    // ── Step 4: Wire up the live-typing event ────────────────────────────────
    // chat-room.ts dispatches a "moq:typing" CustomEvent on every `input` event
    // in the message box.  We intercept it here and forward to the publisher
    // so that other users see the text update in real-time.
    app.addEventListener("moq:typing", (e) => {
        const text = (e as CustomEvent<string>).detail;
        publishTypingUpdate(text);
    });

    // ── Step 5: Subscribe to other users ─────────────────────────────────────
    // We pass the room UI callbacks directly to the subscriber so it can update
    // the member panel and message list as data arrives over the relay.
    await startSubscribing(
        roomId,
        username,

        // Called on every keypress of a remote user (MoQ typing track group).
        // Updates the live typing indicator below that user's name in the panel.
        (remoteUsername, text) => {
            roomUI.updateTyping(remoteUsername, text);
        },

        // Messages track is unused in the live-typing model.
        () => { },

        // Called when a new user's broadcast is announced by the relay.
        // Shows them in the member panel immediately.
        (remoteUsername) => {
            roomUI.addRemoteUser(remoteUsername);
        },

        // Called when a user's broadcast goes inactive (they left/disconnected).
        // Removes them from the member panel.
        (remoteUsername) => {
            roomUI.removeRemoteUser(remoteUsername);
        },
    );
}

// ─── Room → Lobby transition ──────────────────────────────────────────────────

/**
 * Tears down the MoQ session and returns to the lobby.
 *
 * Order matters here:
 *  1. Stop subscriber first so we don't receive events after the UI is gone.
 *  2. Stop publisher so we stop sending data.
 *  3. Close the connection to the relay.
 *  4. Re-render the lobby.
 */
function onLeave(): void {
    console.log("[App] Leaving room…");

    // Remove the moq:typing listener so it doesn't fire after the room unmounts.
    // (In a larger app you'd track the exact listener reference – here we simply
    //  replace the DOM entirely which removes all listeners automatically.)

    stopSubscribing();
    stopPublishing();
    disconnectFromRelay();

    // Re-render the lobby (replaces the chat room DOM entirely).
    renderLobby(app, onJoin);
}

// ─── Page unload cleanup ──────────────────────────────────────────────────────

// When the user closes the tab or navigates away, ensure we close the MoQ
// connection gracefully so the relay knows we're gone and removes our announcements.
window.addEventListener("beforeunload", () => {
    stopSubscribing();
    stopPublishing();
    disconnectFromRelay();
});
