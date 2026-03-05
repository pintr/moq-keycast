# =============================================================================
# moq-relay Dockerfile
# =============================================================================
#
# Builds the official moq-relay binary from source (https://github.com/moq-dev/moq).
# The relay is the central server that all MoQ clients connect to. It handles:
#   - QUIC/WebTransport connections from browsers (for real-time pub/sub)
#   - WebSocket fallback (for browsers without WebTransport support)
#   - Broadcasting data from publishers to all subscribers
#   - Serving the TLS fingerprint endpoint (/certificate.sha256)
#
# PORT DESIGN (single port 4443, two transport protocols):
#   - UDP 4443: QUIC/WebTransport (used by modern browsers for MoQ data)
#   - TCP 4443: HTTP server (serves /certificate.sha256 for local TLS trust,
#               and WebSocket connections as fallback)
#
# SELF-SIGNED TLS:
#   The relay generates its own TLS certificate via --tls-generate.
#   @moq/lite automatically fetches the certificate fingerprint from
#   http://relay:4443/certificate.sha256 and passes it as serverCertificateHashes
#   to the WebTransport API -- this is how local dev bypasses CA verification.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build moq-relay from the moq-dev/moq Rust workspace
# -----------------------------------------------------------------------------
# Pin to bookworm-based Rust image so the compiled binary targets GLIBC 2.36,
# which matches the debian:bookworm-slim runtime stage below.
# Using a non-bookworm builder (e.g. rust:latest on Trixie) produces a binary
# that requires GLIBC 2.38+ and will fail to run on bookworm-slim.
FROM rust:1.88-slim-bookworm AS builder

# Install system build dependencies:
#   git        - to clone the moq source repository
#   pkg-config - needed by Rust build scripts to find system libraries
#   libssl-dev - OpenSSL headers (for TLS/crypto compilation)
#   cmake      - required by some crypto crate build scripts
RUN apt-get update && apt-get install -y \
    git \
    pkg-config \
    libssl-dev \
    cmake \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Clone the official moq-dev/moq repository.
# --depth=1 fetches only the latest commit (faster, less disk usage).
# --filter=blob:none skips large binary blobs during clone.
RUN git clone --depth=1 --filter=blob:none \
    https://github.com/moq-dev/moq.git /src

WORKDIR /src

# Compile only the moq-relay binary.
# We disable iroh (P2P networking layer) to speed up compilation --
# it's not needed for the basic relay functionality.
# We keep quinn (QUIC backend) and websocket (fallback) features enabled.
#
# NOTE: This step downloads and compiles hundreds of Rust crates.
#       First build takes 10-20 minutes; subsequent builds are cached by Docker.
RUN cargo build --release \
    --no-default-features \
    --features quinn,websocket \
    -p moq-relay

# -----------------------------------------------------------------------------
# Stage 2: Minimal runtime image
# -----------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# Install runtime dependencies:
#   ca-certificates - needed for outbound TLS connections (cluster mode)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy only the compiled relay binary from the build stage
COPY --from=builder /src/target/release/moq-relay /usr/local/bin/moq-relay

# Expose both transport protocols on port 4443:
#   UDP - QUIC/WebTransport connections from browsers
#   TCP - HTTP server for /certificate.sha256 fingerprint and WebSocket fallback
EXPOSE 4443/udp
EXPOSE 4443/tcp

ENTRYPOINT ["moq-relay"]

# Default arguments (can be overridden in docker-compose.yml):
#
#   --server-bind [::]:4443
#       Binds the QUIC/WebTransport server to port 4443 (UDP, all interfaces).
#       Browsers connect here for MoQ pub/sub over QUIC.
#
#   --web-http-listen [::]:4443
#       Binds the HTTP server to port 4443 (TCP, all interfaces).
#       Serves /certificate.sha256 so browsers can trust the self-signed cert.
#       Also serves WebSocket connections as a fallback transport.
#
#   --tls-generate localhost
#       Auto-generates a self-signed TLS certificate for the hostname "localhost".
#       The certificate hash is served at /certificate.sha256 and used by
#       @moq/lite's serverCertificateHashes for local development.
CMD [ \
    "--server-bind", "[::]:4443", \
    "--web-http-listen", "[::]:4443", \
    "--tls-generate", "localhost", \
    "--auth-public", "" \
    ]
