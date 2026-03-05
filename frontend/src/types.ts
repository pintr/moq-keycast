// =============================================================================
// Shared TypeScript Types
// =============================================================================
//
// All domain types that are shared between the MoQ layer and the UI layer
// are defined here to avoid circular imports.
// =============================================================================

// ─── Wire types ───────────────────────────────────────────────────────────────
// These are the JSON payloads serialised into MoQ group frames and sent over
// the relay.  Keep them small – every keypress triggers a "typing" frame.

/**
 * Payload sent on the `typing` track for every keystroke.
 *
 * The receiver overwrites whatever text was previously displayed for this
 * user, because each MoQ group represents the *complete* current state
 * (not a delta).  Old groups are discarded by @moq/lite automatically.
 *
 * An empty `text` string means the user has cleared / sent their message.
 */
export interface TypingPayload {
    /** Full current content of the user's input box. */
    text: string;
    /** Unix timestamp (ms) so the UI can detect stale indicators. */
    timestamp: number;
}

/**
 * Payload sent on the `messages` track when the user presses Enter or clicks
 * the Send button.  Unlike typing frames, message frames accumulate – the
 * receiver appends them to the conversation history.
 */
export interface MessagePayload {
    /** The final text of the message. */
    text: string;
    /** Display name of the sender (redundant with the broadcast path but
     *  embedded here for convenience when rendering messages). */
    username: string;
    /** Unix timestamp (ms) used to order messages chronologically. */
    timestamp: number;
}

// ─── UI state types ───────────────────────────────────────────────────────────

/** A fully-resolved chat message ready to display in the room view. */
export interface ChatMessage {
    /** Unique identifier (derived from sender + timestamp). */
    id: string;
    /** Display name of the message author. */
    username: string;
    /** Message body. */
    text: string;
    /** When the message was sent (shown as HH:MM). */
    timestamp: Date;
    /** True if this message was sent by the local user. */
    isSelf: boolean;
}

/**
 * State held for every remote user currently in the room.
 *
 * The UI subscribes to each remote user's typing and message tracks
 * and writes incoming data into this structure.
 */
export interface RemoteUser {
    /** The user's display name (parsed from the MoQ broadcast path). */
    username: string;
    /**
     * Text the remote user is currently typing.
     * Empty string means they are not typing (or have just sent a message).
     */
    currentTyping: string;
}

// ─── Event callbacks ──────────────────────────────────────────────────────────
// The MoQ subscriber fires these callbacks as data arrives so the UI does
// not need to poll.

/** Called when a remote user's live typing text changes. */
export type OnTypingUpdate = (username: string, text: string) => void;

/** Called when a remote user sends a confirmed message. */
export type OnMessageReceived = (message: ChatMessage) => void;

/** Called when a new user joins the room (their broadcast becomes active). */
export type OnUserJoined = (username: string) => void;

/** Called when a user leaves the room (their broadcast goes inactive). */
export type OnUserLeft = (username: string) => void;
