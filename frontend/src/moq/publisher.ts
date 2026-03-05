// =============================================================================
// MoQ Publisher
// =============================================================================
//
// The publisher is responsible for broadcasting THIS USER's activity to all
// other room members via the moq-relay.
//
// ─── MoQ publishing model ─────────────────────────────────────────────────────
//
//  Publishing in MoQ works as follows:
//
//  1. We create a `Broadcast` object (an in-memory named collection of tracks).
//  2. We call `connection.publish(path, broadcast)` to register it with the
//     relay under a path like `moq-chat/general/alice`.
//     The relay then *announces* this path to all active subscribers.
//
//  3. When a remote peer calls `broadcast.subscribe("typing", 0)` or
//     `broadcast.subscribe("messages", 0)`, the relay forwards that subscription
//     request to us.  We pick it up via `broadcast.requested()`.
//
//  4. For each accepted track subscription we hold a reference to the
//     `Track` object.  Writing to the track (`track.appendGroup()`) causes
//     the data to flow through the relay to the subscriber.
//
// ─── MoQ Group / Frame model ──────────────────────────────────────────────────
//
//  Each Track contains a sequence of Groups.  Each Group contains Frames.
//
//  For this chat app we use ONE FRAME PER GROUP:
//
//   Typing track:
//     - Each Group = one snapshot of the user's current input text.
//     - Old groups are discarded by @moq/lite if a newer one arrives --
//       so subscribers always see the latest text, never stale state.
//
//   Messages track:
//     - Each Group = one sent message.
//     - Groups accumulate (not discarded) so the conversation history is kept.
//
//  `group.close()` signals the end of the group so the subscriber knows
//  there are no more frames to read from it.
// =============================================================================

import * as Moq from "@moq/lite";
import {
    MOQ_PATH_PREFIX,
    TRACK_MESSAGES,
    TRACK_TYPING,
} from "../config";
import type { MessagePayload, TypingPayload } from "../types";
import { connectToRelay } from "./connection";

// ─── Module-level state ────────────────────────────────────────────────────────

/**
 * The broadcast we publish under `moq-chat/{roomId}/{username}`.
 * All remote subscribers will subscribe to tracks within this broadcast.
 */
let broadcast: Moq.Broadcast | null = null;

/**
 * All currently-active `Track` objects for the "typing" subscription.
 *
 * There can be multiple concurrent subscribers to our typing track (one per
 * remote peer).  When the user types, we write to ALL of them simultaneously.
 */
const activeTypingTracks = new Set<Moq.Track>();

/**
 * All currently-active `Track` objects for the "messages" subscription.
 * Same multi-subscriber pattern as for typing.
 */
const activeMessageTracks = new Set<Moq.Track>();

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Starts publishing this user's broadcast to the relay.
 *
 * After calling this:
 * - Remote subscribers can discover the broadcast via `connection.announced()`.
 * - Track subscription requests are served automatically.
 * - Call `publishTypingUpdate()` and `publishMessage()` to push data.
 *
 * @param roomId   - The ID of the chat room (e.g. "general").
 * @param username - The local user's display name (e.g. "alice").
 */
export async function startPublishing(
    roomId: string,
    username: string
): Promise<void> {
    const connection = await connectToRelay();

    // Build the broadcast path: moq-chat/{roomId}/{username}
    // This path is unique per user per room so each user has their own namespace.
    const broadcastPath = Moq.Path.from(
        `${MOQ_PATH_PREFIX}/${roomId}/${username}`
    );

    // Create a Broadcast (an in-memory container for tracks).
    broadcast = new Moq.Broadcast();

    // Announce this broadcast to the relay.
    // The relay will notify all peers that are watching the `moq-chat/{roomId}/`
    // prefix about the new broadcast.
    connection.publish(broadcastPath, broadcast);

    console.log(`[Publisher] Announced broadcast at path: ${broadcastPath}`);

    // Start the request-serving loop in the background.
    // We don't await it here so `startPublishing` returns immediately while
    // the loop runs for the lifetime of the broadcast.
    void serveTrackRequests(broadcast);
}

/**
 * Stops publishing and tears down the broadcast.
 * Called when the user leaves the room.
 */
export function stopPublishing(): void {
    if (!broadcast) return;
    console.log("[Publisher] Stopping broadcast…");
    broadcast.close();
    broadcast = null;
    activeTypingTracks.clear();
    activeMessageTracks.clear();
}

/**
 * Publishes the user's current typing text to all active subscribers.
 *
 * Called on every `input` event on the message text box.
 * Each call creates a new MoQ Group with a single JSON frame containing
 * the full current value of the input box.
 *
 * Because each subscriber's Track discards anything older than the newest
 * Group, remote peers always see the latest snapshot, not intermediate
 * keystrokes that have already been superseded.
 *
 * @param text - The full current text of the local user's input box.
 */
export function publishTypingUpdate(text: string): void {
    if (activeTypingTracks.size === 0) return; // No subscribers yet – skip

    const payload: TypingPayload = { text, timestamp: Date.now() };

    for (const track of activeTypingTracks) {
        try {
            // appendGroup() opens a new MoQ Group on the track.
            // Each group is an independent unit; old groups are skipped by the
            // subscriber if a newer one arrives before they've been consumed.
            const group = track.appendGroup();

            // writeJson() serialises the payload to UTF-8 JSON and writes it as
            // a single Frame inside the Group.
            group.writeJson(payload);

            // close() signals end-of-group so the subscriber's readJson() call
            // returns instead of blocking forever waiting for more frames.
            group.close();
        } catch (err) {
            // The track may have been closed by the subscriber disconnecting.
            // Remove it so we don't try to write again.
            console.warn("[Publisher] Typing track closed, removing:", err);
            activeTypingTracks.delete(track);
        }
    }
}

/**
 * Publishes a completed message to all active subscribers.
 *
 * Called when the user presses Enter or clicks the Send button.
 * Unlike typing updates, message groups accumulate on the receiver's side
 * to form the chat history.
 *
 * @param text     - The message text.
 * @param username - The sender's display name (embedded in the payload for
 *                   convenience when rendering).
 */
export function publishMessage(text: string, username: string): void {
    const payload: MessagePayload = {
        text,
        username,
        timestamp: Date.now(),
    };

    for (const track of activeMessageTracks) {
        try {
            const group = track.appendGroup();
            group.writeJson(payload);
            group.close();
        } catch (err) {
            console.warn("[Publisher] Message track closed, removing:", err);
            activeMessageTracks.delete(track);
        }
    }
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Waits for incoming track subscription requests and routes them.
 *
 * This loop runs for the lifetime of the broadcast.  For each request the
 * relay delivers, we:
 *  - Accept it if the track name matches "typing" or "messages".
 *  - Reject it (close with an error) for any unknown track name.
 *
 * Accepted tracks are added to the appropriate active-track set so that
 * subsequent calls to `publishTypingUpdate()` / `publishMessage()` reach them.
 *
 * @param broadcast - The active Broadcast to read requests from.
 */
async function serveTrackRequests(broadcast: Moq.Broadcast): Promise<void> {
    for (; ;) {
        // `requested()` blocks until a remote subscriber asks for a track,
        // or returns undefined when the broadcast is closed.
        const request = await broadcast.requested();
        if (!request) {
            console.log("[Publisher] Broadcast closed, stopping request loop.");
            return;
        }

        const { track } = request; // The Track object we must write frames into

        console.log(`[Publisher] Track requested: "${track.name}"`);

        if (track.name === TRACK_TYPING) {
            // Register the track so publishTypingUpdate() can write to it.
            activeTypingTracks.add(track);

            // Immediately send the current empty state so the subscriber knows
            // the track is alive (avoids an endless wait on `nextGroup()`).
            const group = track.appendGroup();
            group.writeJson({ text: "", timestamp: Date.now() } as TypingPayload);
            group.close();

            // When the subscriber disconnects, remove the track from the set.
            track.closed.then(() => {
                activeTypingTracks.delete(track);
                console.log("[Publisher] Typing subscriber disconnected.");
            });
        } else if (track.name === TRACK_MESSAGES) {
            activeMessageTracks.add(track);

            track.closed.then(() => {
                activeMessageTracks.delete(track);
                console.log("[Publisher] Message subscriber disconnected.");
            });
        } else {
            // Unknown track – close it with an explanatory error.
            console.warn(`[Publisher] Unknown track requested: "${track.name}"`);
            track.close(new Error(`Unknown track: ${track.name}`));
        }
    }
}
