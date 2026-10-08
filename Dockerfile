# Paca as a container: Node, gh, the pi-clean collector and Paca, running as the non-root
# node user. Configuration, credentials and data come in at runtime; see docs/container.md.
# Only linux/amd64 is built and tested.

ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66

FROM ${NODE_IMAGE} AS tools
# Downloads checked against pinned SHA-256 sums with sha256sum, which also works where a
# builder ignores ADD --checksum (the legacy builder does).
ARG GH_VERSION=2.102.0
ARG TINI_VERSION=0.19.0
# Commit of tini's v0.19.0 tag, for its LICENSE.
ARG TINI_COMMIT=de40ad007797e0dcd8b7126f27bb87401d224240
# Paca needs only pi-clean's collector: github-planning.mjs and its one helper, which use Node
# built-ins and gh. pi-clean has no LICENSE file; its package.json, kept as is, declares MIT.
ARG PI_CLEAN_REVISION=8921989468496a21b2ad19acfaa6198fa949a86e
ADD https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz /in/gh.tar.gz
ADD https://github.com/krallin/tini/releases/download/v${TINI_VERSION}/tini-static-amd64 /in/tini
ADD https://raw.githubusercontent.com/krallin/tini/${TINI_COMMIT}/LICENSE /in/tini-LICENSE
ADD https://raw.githubusercontent.com/mtrenker/pi-clean/${PI_CLEAN_REVISION}/scripts/github-planning.mjs /in/github-planning.mjs
ADD https://raw.githubusercontent.com/mtrenker/pi-clean/${PI_CLEAN_REVISION}/scripts/github-planning/lib.mjs /in/lib.mjs
ADD https://raw.githubusercontent.com/mtrenker/pi-clean/${PI_CLEAN_REVISION}/package.json /in/pi-clean-package.json
RUN cd /in \
 && printf '%s  %s\n' \
      bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386 gh.tar.gz \
      c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee tini \
      e5f46bca81266bdd511cf08018d66866870531794569c04f9b45f50dd23c28b0 tini-LICENSE \
      896af07c01cbdc67e75fa016dadd7d487d6c539a4f7ad9c7b5f62c7257bce0b3 github-planning.mjs \
      40df67fb44452160af5f551437021c1bfa59f80dce6e77159b673270aebe9d93 lib.mjs \
      45bddea6b38e79d13d4112fe27c843fae896f51b38f2fc7b7a2b9e6f109c4d8a pi-clean-package.json \
    | sha256sum -c - \
 && tar -xzf gh.tar.gz \
 && install -D -m 0755 gh_${GH_VERSION}_linux_amd64/bin/gh /out/bin/gh \
 && install -D -m 0755 tini /out/bin/tini \
 && install -D -m 0644 gh_${GH_VERSION}_linux_amd64/LICENSE /out/licenses/gh/LICENSE \
 && install -D -m 0644 tini-LICENSE /out/licenses/tini/LICENSE \
 && install -D -m 0644 pi-clean-package.json /out/pi-clean/package.json \
 && install -D -m 0644 github-planning.mjs /out/pi-clean/scripts/github-planning.mjs \
 && install -D -m 0644 lib.mjs /out/pi-clean/scripts/github-planning/lib.mjs

# Production dependencies. Workspace packages become symlinks in node_modules/@paca/ to
# /app/packages/, which the final stage copies from the build context.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/extension/package.json packages/extension/
COPY packages/extension-github/package.json packages/extension-github/
COPY packages/extension-herdr/package.json packages/extension-herdr/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# The browser code is the only compiled part: the page's TypeScript to packages/web/dist/, and the
# GitHub package's cards to packages/extension-github/browser/dist/. The server runs its TypeScript
# sources directly; Node 24 strips the types.
FROM deps AS web
COPY tsconfig.base.json ./
COPY packages/contracts/src packages/contracts/src
COPY packages/extension/browser packages/extension/browser
COPY packages/extension-github/browser packages/extension-github/browser
COPY packages/web packages/web
RUN npm ci --workspace @paca/web --include-workspace-root --ignore-scripts --no-audit --no-fund && npm run build

FROM ${NODE_IMAGE}
# ca-certificates for HTTPS from gh and Node (OIDC, model providers, GitHub).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=tools /out/bin/ /usr/local/bin/
COPY --from=tools /out/licenses/ /usr/share/licenses/
COPY --from=tools /out/pi-clean/ /opt/pi-clean/
RUN mkdir -m 0700 /data && chown node:node /data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json LICENSE ./
COPY packages ./packages
COPY --from=web /app/packages/web/dist ./packages/web/dist
COPY --from=web /app/packages/extension-github/browser/dist ./packages/extension-github/browser/dist

# Everything Paca and Pi write lives in /data. GH_TOKEN, PACA_OIDC_CLIENT_SECRET and model
# credentials are runtime environment, never build arguments.
ENV NODE_ENV=production \
    PACA_DATA_DIR=/data \
    PI_CODING_AGENT_DIR=/data/pi \
    PACA_HOST=0.0.0.0 \
    PACA_PORT=4302 \
    GH_PROMPT_DISABLED=1 \
    GH_NO_UPDATE_NOTIFIER=1
USER node
VOLUME /data
EXPOSE 4302
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4302/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/tini", "--"]
CMD ["node", "packages/api/src/main.ts"]
