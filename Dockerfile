# Browser container for the OpenCode ChatGPT Web harness (Phase 9).
#
# Bundles exactly the browser side: Electron, browser helper, Responses
# bridge daemon, turn broker, tunnel-client and website MCP. OpenCode,
# workspace access and tool execution stay on the host — this image never
# receives the host workspace or the Docker socket.
FROM oven/bun:debian

RUN apt-get update && apt-get install -y --no-install-recommends \
    tini ca-certificates procps socat \
    xvfb xauth dbus-x11 \
    tigervnc-standalone-server tigervnc-common \
    websockify novnc x11vnc \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
    libasound2 libcairo2 libgbm1 libgtk-3-0 libgdk-pixbuf-2.0-0 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0 \
    libpango-1.0-0 libpangocairo-1.0-0 libcups2 libdrm2 libxfixes3 \
    libxext6 libxi6 libxtst6 libxshmfence1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# uid1000 matches the host user that owns the mounted key files and the
# noVNC password, so the container reads them without copying credentials.
# The image's `bun` user already owns uid1000 — the same uid as the host user
# that owns the mounted key files and noVNC password, so the container reads
# them without copying credentials.
RUN mkdir -p /opt/codex-chatgpt-web /home/bun/.codex-chatgpt-web \
    && chown -R bun:bun /opt/codex-chatgpt-web /home/bun/.codex-chatgpt-web
WORKDIR /opt/codex-chatgpt-web

COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun launcher/package.json launcher/bun.lock ./launcher/
# electron42 ships no postinstall; its binary is fetched by install.js
# (the same invocation scripts/verify.ts uses).
RUN bun install --frozen-lockfile \
    && cd launcher && bun install --frozen-lockfile \
    && bun run node_modules/electron/install.js

COPY --chown=bun:bun . .

USER bun
ENV HOME=/home/bun
# Production renderer and the browser-helper script the daemon spawns per turn.
RUN cd launcher && bun run build:renderer \
    && cd .. && bun run scripts/build-browser-helper.ts

EXPOSE 17841 6080
ENTRYPOINT ["/usr/bin/tini", "--", "sh", "/opt/codex-chatgpt-web/docker/entrypoint.sh"]
