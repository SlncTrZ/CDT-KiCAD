# CDT-KiCAD provider image.
#
# Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
# SlncTrZ provider-shell adaptation by SlncTrZ / Truong Cong Dinh.
#
# NOTE on KiCAD: full ECAD execution needs KiCAD's pcbnew module, which is
# NOT inside this image. Provide it one of two ways:
#   1. Build FROM a KiCAD-bearing base and set KICAD_PYTHON + PYTHONPATH, or
#   2. Mount the host KiCAD python path read-only and set the same variables.
# Without pcbnew the bridge refuses to start (fail-closed); /healthz still
# answers so orchestrators can distinguish "up" from "ready".
#
# Run (HTTP network mode, fail-closed auth):
#   docker build -t cdt-kicad:2.7.0-cdt.1 .
#   docker run -d --name cdt-kicad -p 3100:3100 \
#     -e KICAD_MCP_TOKEN="$(cat /run/secrets/kicad_mcp_token)" \
#     -e KICAD_PYTHON=/usr/bin/python3 \
#     -v kicad-projects:/work:rw \
#     -v ./docs/TOOL_GUIDE.md:/app/docs/TOOL_GUIDE.md:ro \
#     cdt-kicad:2.7.0-cdt.1
# STDIO local mode stays available: docker run -i --rm <image> node dist/index.js

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json eslint.config.js ./
COPY src/ ./src/
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MCP_TRANSPORT=both \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3100 \
    LOG_LEVEL=info
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 10001 kicad \
    && mkdir -p /work /app/docs /app/config \
    && chown -R kicad:kicad /app /work
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=kicad:kicad /app/dist ./dist
COPY --chown=kicad:kicad python/ ./python/
COPY --chown=kicad:kicad docs/TOOL_GUIDE.md ./docs/TOOL_GUIDE.md
COPY --chown=kicad:kicad config/default-config.json ./config/default-config.json
USER kicad
VOLUME ["/work"]
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3100/healthz').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
