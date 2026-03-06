// =============================================================================
// MoQ Connection Manager
// =============================================================================
//
// This module is the single point of contact between our application and the
// moq-relay server.  It wraps the @moq/lite `Connection.connect()` API and
// provides a singleton connection that all other modules can share.
//
// ─── How @moq/lite transports work ────────────────────────────────────────────
//
//  When `connect(url)` is called it races two potential transports:
//
//  1. WebTransport (QUIC/HTTP3)
//     The browser-native API for low-latency, multiplexed QUIC streams.
//     This is the ideal path, but it requires HTTPS (a trusted TLS cert).
//     For local development the library detects an `http://` scheme and
//     automatically fetches the relay's certificate fingerprint from
//     `http://host:port/certificate.sha256` before connecting via
//     `https://host:port` with `serverCertificateHashes`.
//
//  2. WebSocket fallback
//     If WebTransport is unavailable (e.g. Firefox) or the relay doesn't
//     respond in time, @moq/lite transparently falls back to a WebSocket
//     connection over TCP.  The MoQ protocol frames are identical -- only
//     the underlying transport differs.
//
//  The winning transport is used for the rest of the session with no code
//  change required on our part.
// =============================================================================

import * as Moq from "@moq/lite";
import { RELAY_URL } from "../config";

/**
 * Convenience alias for the return type of `Moq.Connection.connect()`.
 *
 * `Established` is exported from the `@moq/lite` package under the
 * `Connection` namespace (`Moq.Connection.Established`).  We derive the
 * type from the function's return value so we don't need to hard-code the
 * namespace path, which keeps the code resilient to library refactors.
 */
export type MoqConnection = Awaited<ReturnType<typeof Moq.Connection.connect>>;

/**
 * The established MoQ connection to the relay.
 *
 * All publishers and subscribers share this single connection.  The relay
 * multiplexes multiple broadcasts/tracks inside one QUIC (or WebSocket)
 * session, so one connection is all we need regardless of how many rooms
 * or users exist.
 *
 * Set to `null` before `connectToRelay()` is called, or after
 * `disconnectFromRelay()` tears it down.
 */
let connection: MoqConnection | null = null;

/**
 * Establishes a connection to the moq-relay server.
 *
 * Call this once during app startup (e.g. when the user selects a username
 * and room).  If a connection already exists it is returned immediately.
 *
 * @returns The established MoQ connection.
 * @throws  If the relay is unreachable or the handshake fails.
 *
 * Step-by-step internals:
 *  1. Parse `RELAY_URL` into a `URL` object.
 *  2. If the scheme is `http://`, @moq/lite fetches the TLS certificate
 *     fingerprint from `http://host:port/certificate.sha256`.
 *  3. A WebTransport session is opened to `https://host:port` using that
 *     fingerprint (so the self-signed cert is trusted).
 *  4. In parallel, a WebSocket to `ws://host:port` is also attempted with a
 *     200 ms delay.  Whichever connects first wins.
 *  5. The MoQ SETUP handshake (version negotiation) is performed over the
 *     winning transport.
 *  6. The `Established` object is returned -- it exposes `publish()`,
 *     `consume()`, and `announced()`.
 */
export async function connectToRelay(): Promise<MoqConnection> {
    if (connection) return connection;

    console.log(`[MoQ] Connecting to relay at ${RELAY_URL}…`);
    const url = new URL(RELAY_URL);

    // Moq.Connection.connect() races WebTransport vs WebSocket.
    // No extra options are required -- fingerprint fetching and the fallback
    // are handled entirely inside @moq/lite.
    connection = await Moq.Connection.connect(url);

    console.log(
        `[MoQ] Connected! ` +
        `(transport: ${url.protocol === "http:" ? "WebTransport or WebSocket (http mode)" : "WebTransport/WebSocket"})`
    );

    // If the relay closes the connection (e.g. server restart), clear our
    // reference so the next call to `connectToRelay()` re-establishes it.
    connection.closed.then(() => {
        console.warn("[MoQ] Connection closed by relay.");
        connection = null;
    });

    return connection;
}

/**
 * Returns the current connection or throws if not yet connected.
 *
 * Useful for modules that need the connection but shouldn't be responsible
 * for establishing it.
 */
export function getConnection(): MoqConnection {
    if (!connection) {
        throw new Error(
            "[MoQ] Not connected. Call connectToRelay() first."
        );
    }
    return connection;
}

/**
 * Tears down the connection to the relay.
 *
 * Call this on page unload or when the user explicitly leaves the room.
 * All active broadcasts and subscriptions are closed automatically.
 */
export function disconnectFromRelay(): void {
    if (!connection) return;
    console.log("[MoQ] Disconnecting from relay…");
    connection.close();
    connection = null;
}
