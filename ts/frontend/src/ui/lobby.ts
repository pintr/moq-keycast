// =============================================================================
// Lobby UI Component
// =============================================================================
//
// The lobby is the first screen the user sees.  It lets them:
//   1. Enter a username (display name visible to all room members).
//   2. Enter or pick a room name (a free-form text identifier).
//   3. Click "Join" to establish a MoQ connection and enter the room.
//
// This module renders the lobby HTML, validates the form, and fires a
// callback when the user is ready to enter a room.
// =============================================================================

/** Callback invoked when the user submits valid lobby credentials. */
export type OnJoin = (username: string, roomId: string) => Promise<void>;

/**
 * Renders the lobby UI into the given container element and wires up the
 * form validation and submission logic.
 *
 * @param container - The DOM element that will hold the lobby markup.
 * @param onJoin    - Async callback invoked with (username, roomId) when the
 *                   user clicks "Join".  Should throw on connection errors.
 */
export function renderLobby(container: HTMLElement, onJoin: OnJoin): void {
  // ── Build the HTML structure ────────────────────────────────────────────────
  container.innerHTML = `
    <div class="lobby">
      <div class="lobby-card">
        <h1>MoQ Chat</h1>
        <p class="subtitle">
          Live chat powered by
          <span>Media over QUIC</span> (@moq/lite)
        </p>

        <div class="form-group">
          <label for="username-input">Your name</label>
          <input
            id="username-input"
            type="text"
            placeholder="e.g. alice"
            maxlength="32"
            autocomplete="off"
            spellcheck="false"
          />
        </div>

        <div class="form-group">
          <label for="room-input">Room</label>
          <input
            id="room-input"
            type="text"
            placeholder="e.g. general"
            maxlength="64"
            autocomplete="off"
            spellcheck="false"
            value="general"
          />
        </div>

        <button id="join-btn" class="btn-primary" disabled>Join Room</button>

        <p class="error-msg" id="error-msg"></p>
      </div>
    </div>
  `;

  // ── Wire up references ──────────────────────────────────────────────────────
  const usernameInput = container.querySelector<HTMLInputElement>("#username-input")!;
  const roomInput = container.querySelector<HTMLInputElement>("#room-input")!;
  const joinBtn = container.querySelector<HTMLButtonElement>("#join-btn")!;
  const errorMsg = container.querySelector<HTMLParagraphElement>("#error-msg")!;

  // ── Validation helper ───────────────────────────────────────────────────────
  /**
   * Returns true only when both fields contain valid, non-empty slugs.
   *
   * We restrict characters to alphanumerics, hyphens, and underscores so the
   * values map cleanly to MoQ path segments without any URL encoding.
   */
  function isValid(): boolean {
    const slug = /^[a-z0-9_-]+$/i;
    return slug.test(usernameInput.value.trim()) && slug.test(roomInput.value.trim());
  }

  function updateJoinBtn(): void {
    joinBtn.disabled = !isValid();
  }

  // ── Event listeners ─────────────────────────────────────────────────────────
  usernameInput.addEventListener("input", updateJoinBtn);
  roomInput.addEventListener("input", updateJoinBtn);

  // Allow pressing Enter in either field to trigger the join.
  const handleEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter" && isValid()) joinBtn.click();
  };
  usernameInput.addEventListener("keydown", handleEnter);
  roomInput.addEventListener("keydown", handleEnter);

  joinBtn.addEventListener("click", async () => {
    const username = usernameInput.value.trim().toLowerCase();
    const roomId = roomInput.value.trim().toLowerCase();

    // Disable the form while we connect.
    joinBtn.disabled = true;
    joinBtn.textContent = "Connecting…";
    errorMsg.textContent = "";

    try {
      // Delegate connection + room entry to the caller (main.ts).
      await onJoin(username, roomId);
      // If successful, main.ts will replace the container's contents with the
      // chat room view, so we don't need to do anything more here.
    } catch (err) {
      console.error("[Lobby] Join failed:", err);
      errorMsg.textContent =
        err instanceof Error
          ? `Connection failed: ${err.message}`
          : "Could not connect to relay. Is it running?";

      // Re-enable the form so the user can try again.
      joinBtn.disabled = false;
      joinBtn.textContent = "Join Room";
    }
  });

  // Auto-focus username field.
  usernameInput.focus();

  // Trigger initial validation in case the fields are pre-filled by the browser.
  updateJoinBtn();
}
