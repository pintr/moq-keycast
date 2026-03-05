// =============================================================================
// Vite Configuration
// =============================================================================
// Vite bundles our TypeScript source into an optimised static web app.
// We set "esnext" as the build target so that modern browser features like
// top-level await (used by Moq.Connection.connect) and WebTransport are
// supported without any down-transpilation.
// =============================================================================

import { defineConfig } from "vite";

export default defineConfig({
    // ── Development server ─────────────────────────────────────────────────────
    server: {
        // Bind to all interfaces so the Vite dev server is reachable inside Docker
        host: "0.0.0.0",
        port: 5173,
        // Chrome blocks mixed-content (e.g. http page → http WebTransport) so we
        // DON'T proxy the relay here. The browser connects to the relay directly
        // via the host-mapped port 4443.
    },

    // ── Build settings ─────────────────────────────────────────────────────────
    build: {
        outDir: "dist",
        // "esnext" preserves top-level await and other modern syntax.
        // WebTransport is only available in recent Chromium/Firefox builds anyway,
        // so there is no benefit in targeting older browsers.
        target: "esnext",
        // Inline small assets to reduce round-trips
        assetsInlineLimit: 4096,
    },

    // ── Dependency pre-bundling ─────────────────────────────────────────────────
    // @moq/lite ships native ESM with ".ts" extension imports.
    // We tell Vite to include it in the pre-bundle step so that browsers receive
    // a single, fast-loading chunk instead of hundreds of individual modules.
    optimizeDeps: {
        include: ["@moq/lite"],
    },
});
