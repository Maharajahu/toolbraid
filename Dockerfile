# syntax=docker/dockerfile:1

# ToolBraid has no runtime dependencies, so the image does not need npm
# install, a compiler toolchain, or a shell entrypoint.
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# The image is intentionally non-root. At deployment, also use a read-only
# root filesystem, drop capabilities, and set no-new-privileges.
USER node

CMD ["node", "src/server.js"]
