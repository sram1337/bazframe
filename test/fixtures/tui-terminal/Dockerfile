FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

ENV BAZFRAME_TUI_BASE_IMAGE="node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client openssh-server procps tmux util-linux \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . ./
CMD ["node", "./scripts/test-tui-terminal-linux-inner.mjs"]
