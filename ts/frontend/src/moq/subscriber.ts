// =============================================================================
// MoQ Subscriber
// =============================================================================
//
// The subscriber watches the relay for broadcasts from OTHER users in the same
// room and fires callbacks as typing updates and messages arrive.
//
// ─── How discovery works ──────────────────────────────────────────────────────
//
//  When a user joins, they publish a broadcast at `moq-chat/{roomId}/{username}`.
//  The relay announces this to all clients watching the prefix.
//
//  We call `connection.announced(prefix)` with `moq-chat/{roomId}/` to receive
//  a stream of `AnnouncedEntry` objects:
//    { path: Path.Valid, active: boolean }
//
//  - active: true  → a new broadcast appeared (user joined or reconnected)
//  - active: false → the broadcast disappeared (user left or disconnected)
//
// ─── How track subscription works ────────────────────────────────────────────
//
//  For each active broadcast we call `connection.consume(path)` to get a
//  remote Broadcast view, then `broadcast.subscribe("typing", 0)` to get a
//  Track.  The relay opens a QUIC stream from the publisher to us for each
//  subscribed track.
//
// ─── How live typing works (Groups) ──────────────────────────────────────────
//
//  The publisher writes one Group per keypress, each Group containing the
//  full current text.  On our side `track.nextGroup()` returns each new group.
//  @moq/lite internally skips groups that arrived while we were processing a
//  previous one, so we always get the LATEST typing state, never queue up
//  stale snapshots.
//
// ─── Threading model ─────────────────────────────────────────────────────────
//
//  JavaScript is single-threaded, but async functions yield cooperatively.
//  Each remote user gets their own "goroutine-like" async task for the typing
//  track and another for the messages track.  They share the event loop with
//  the UI without blocking.
//
// =============================================================================

import * as Moq from "@moq/lite";
import type { MoqConnection } from "./connection";
import {
    MOQ_PATH_PREFIX,
    TRACK_MESSAGES,
    TRACK_PRIORITY,
    TRACK_TYPING,
} from "../config";
import type {
    ChatMessage,
    MessagePayload,
    OnMessageReceived,
    OnTypingUpdate,
    OnUserJoined,
    OnUserLeft,
    TypingPayload,
} from "../types";
import { connectToRelay } from "./connection";

// ─── Module-level state ────────────────────────────────────────────────────────

/**
 * AbortController used to stop the entire subscriber session.
 * Signalling `abort()` causes all the background async loops to exit.
 */
let abortController: AbortController | null = null;

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Starts watching the relay for other users in the given room.
 *
 * Call this after `startPublishing()`.  The function returns immediately;
 * all the actual work happens in background async tasks.
 *
 * @param roomId          - The chat room to watch (e.g. "general").
 * @param localUsername   - The local user's name.  We skip our own broadcast
 *                         to avoid echoing our own messages back to ourselves.
 * @param onTypingUpdate  - Fired whenever a remote user's typing text changes.
 * @param onMessage       - Fired when a remote user sends a confirmed message.
 * @param onUserJoined    - Fired when a remote user enters the room.
 * @param onUserLeft      - Fired when a remote user leaves the room.
 */
export async function startSubscribing(
    roomId: string,
    localUsername: string,
    onTypingUpdate: OnTypingUpdate,
    onMessage: OnMessageReceived,
    onUserJoined: OnUserJoined,
    onUserLeft: OnUserLeft
): Promise<void> {
    const connection = await connectToRelay();

    // Create a cancellation token so we can stop all background tasks cleanly.
    abortController = new AbortController();
    const { signal } = abortController;

    // The prefix whose announcements we want to monitor.
    // Format: "moq-chat/{roomId}/"
    // By watching this prefix the relay streams us announcements for every
    // broadcast whose path begins with it – i.e. every user in the room.
    const roomPrefix = Moq.Path.from(`${MOQ_PATH_PREFIX}/${roomId}/`);

    console.log(`[Subscriber] Watching announcements with prefix: ${roomPrefix}`);

    // `connection.announced(prefix)` returns an `Announced` object whose
    // `.next()` method yields `AnnouncedEntry` events as they arrive.
    const announced = connection.announced(roomPrefix);

    // Run the discovery loop in the background (fire-and-forget).
    void watchAnnouncements(
        connection,
        announced,
        localUsername,
        roomId,
        signal,
        onTypingUpdate,
        onMessage,
        onUserJoined,
        onUserLeft
    );
}

/**
 * Stops all subscriber background tasks.
 * Called when the user leaves the room.
 */
export function stopSubscribing(): void {
    if (!abortController) return;
    console.log("[Subscriber] Stopping all subscriptions…");
    abortController.abort();
    abortController = null;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Background loop: watches the relay for new or departing users.
 *
 * For every `AnnouncedEntry` with `active: true` we launch two sub-tasks:
 *   • one that reads typing updates from that user's "typing" track
 *   • one that reads messages from that user's "messages" track
 *
 * @param connection     - The established MoQ connection.
 * @param announced      - The announcement stream scoped to this room.
 * @param localUsername  - Ignored for self-announce suppression.
 * @param roomId         - Used only for logging.
 * @param signal         - AbortSignal; we stop the loop when it fires.
 * @param onTypingUpdate - Callback forwarded to the typing-read task.
 * @param onMessage      - Callback forwarded to the message-read task.
 * @param onUserJoined   - Fired when a new user appears.
 * @param onUserLeft     - Fired when a user disappears.
 */
async function watchAnnouncements(
    connection: MoqConnection,
    announced: Moq.Announced,
    localUsername: string,
    roomId: string,
    signal: AbortSignal,
    onTypingUpdate: OnTypingUpdate,
    onMessage: OnMessageReceived,
    onUserJoined: OnUserJoined,
    onUserLeft: OnUserLeft
): Promise<void> {
    // Track active per-user abort controllers so we can cancel a user's tasks
    // when they leave (active: false announcement).
    const userAbortControllers = new Map<string, AbortController>();

    for (; ;) {
        // Exit gracefully when the module is stopped.
        if (signal.aborted) break;

        // `announced.next()` blocks until the next announcement arrives.
        const entry = await announced.next();
        if (!entry) {
            console.log("[Subscriber] Announced stream closed.");
            break;
        }

        // Parse the username from the tail of the broadcast path.
        // Path format: moq-chat/{roomId}/{username}
        // We extract the portion after the last "/".
        const pathStr = entry.path.toString();
        const username = pathStr.split("/").at(-1) ?? pathStr;

        // Skip our own broadcast – we don't want to subscribe to ourselves.
        if (username === localUsername) continue;

        if (entry.active) {
            // ── New user appeared ──────────────────────────────────────────────────
            console.log(`[Subscriber] User joined: ${username}`);

            // Cancel any stale tasks left over from a previous connect cycle.
            userAbortControllers.get(username)?.abort();
            const userAbort = new AbortController();
            userAbortControllers.set(username, userAbort);

            // Notify the UI.
            onUserJoined(username);

            // Consume the remote user's broadcast (does NOT fetch data yet –
            // it just sets up the subscription channels that the relay will
            // route data through).
            const remoteBroadcast = connection.consume(entry.path);

            // Subscribe to the typing track (priority 0 = highest).
            // The relay will open a QUIC stream to us and start forwarding
            // groups as the publisher writes them.
            const typingTrack = remoteBroadcast.subscribe(
                TRACK_TYPING,
                TRACK_PRIORITY
            );

            // Subscribe to the messages track.
            const messagesTrack = remoteBroadcast.subscribe(
                TRACK_MESSAGES,
                TRACK_PRIORITY
            );

            // Run both read loops concurrently (fire-and-forget).
            void readTypingUpdates(
                typingTrack,
                username,
                userAbort.signal,
                onTypingUpdate
            );
            void readMessages(
                messagesTrack,
                username,
                roomId,
                localUsername,
                userAbort.signal,
                onMessage
            );
        } else {
            // ── User left ──────────────────────────────────────────────────────────
            console.log(`[Subscriber] User left: ${username}`);

            // Cancel the user's background tasks.
            userAbortControllers.get(username)?.abort();
            userAbortControllers.delete(username);

            // Notify the UI.
            onUserLeft(username);
        }
    }

    // When the outer loop is done, cancel all remaining per-user tasks.
    for (const ctrl of userAbortControllers.values()) {
        ctrl.abort();
    }
}

/**
 * Background loop: reads live typing updates from a single remote user's
 * "typing" track and fires `onTypingUpdate` whenever the text changes.
 *
 * ─── Why use Groups ───────────────────────────────────────────────────────────
 *
 *  The publisher creates a NEW Group for every keystroke.
 *  `track.nextGroup()` advances to the next group.  If the publisher has
 *  produced several groups while we were busy with the previous one, @moq/lite
 *  skips the intermediate ones so we always receive the latest snapshot.
 *  This gives us a free "debounce" at the transport level -- perfect for
 *  a live-typing indicator.
 *
 * @param track          - The typing Track subscribed from the remote broadcast.
 * @param username       - Remote user's display name (for the callback).
 * @param signal         - AbortSignal; we stop polling when it fires.
 * @param onTypingUpdate - Callback invoked with (username, currentText).
 */
async function readTypingUpdates(
    track: Moq.Track,
    username: string,
    signal: AbortSignal,
    onTypingUpdate: OnTypingUpdate
): Promise<void> {
    console.log(`[Subscriber] Reading typing track for ${username}`);

    for (; ;) {
        if (signal.aborted) break;

        // `track.nextGroup()` waits until the publisher appends a new Group,
        // then returns it.  Returns `undefined` when the track is closed.
        const group = await track.nextGroup();
        if (!group) {
            console.log(`[Subscriber] Typing track closed for ${username}`);
            // Clear the typing indicator so it doesn't stay on screen.
            onTypingUpdate(username, "");
            break;
        }

        // Read the single JSON frame inside this Group.
        // `group.readJson()` blocks until the frame arrives or the group closes.
        const payload = (await group.readJson()) as TypingPayload | undefined;
        if (!payload) continue;

        // Fire the callback – the UI will update the typing indicator.
        onTypingUpdate(username, payload.text);
    }
}

/**
 * Background loop: reads committed messages from a single remote user's
 * "messages" track and fires `onMessage` for each one.
 *
 * Unlike the typing track, message groups are NOT skipped -- every group
 * represents a distinct message that must be added to the conversation.
 *
 * @param track         - The messages Track subscribed from the remote broadcast.
 * @param username      - Remote user's display name.
 * @param roomId        - The room ID (unused here but useful for logging).
 * @param localUsername - The local user's name, used to set `isSelf` = false.
 * @param signal        - AbortSignal.
 * @param onMessage     - Callback fired with a fully-constructed `ChatMessage`.
 */
async function readMessages(
    track: Moq.Track,
    username: string,
    roomId: string,
    localUsername: string,
    signal: AbortSignal,
    onMessage: OnMessageReceived
): Promise<void> {
    console.log(`[Subscriber] Reading messages track for ${username}`);

    for (; ;) {
        if (signal.aborted) break;

        const group = await track.nextGroup();
        if (!group) {
            console.log(`[Subscriber] Messages track closed for ${username}`);
            break;
        }

        const payload = (await group.readJson()) as MessagePayload | undefined;
        if (!payload) continue;

        // Construct a ChatMessage from the wire payload.
        const message: ChatMessage = {
            id: `${username}-${payload.timestamp}`,
            username: payload.username,
            text: payload.text,
            timestamp: new Date(payload.timestamp),
            isSelf: false, // This message came from a remote user
        };

        onMessage(message);
    }
}
