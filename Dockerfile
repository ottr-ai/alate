# alate provisioning server, local build (Node runs TS directly, no build step)
FROM node:24-alpine
RUN apk add --no-cache git
# SkillSpector: install-user.mjs statically scans every skill snapshot before it installs
# and refuses to run without the scanner (fail-closed), so the image that provisions must
# carry it. This ref must match SKILLSPECTOR_REF in install-user.mjs (the test suite checks
# the pair); Python 3.12+ is the script's requirement. A wrong ref fails the build loudly.
# Transitive pip deps float within the pin's ranges; yara-python compiles from source on
# musl, so the compiler toolchain is install-only and leaves with the same layer.
ARG SKILLSPECTOR_REF=v2.13.0
RUN apk add --no-cache python3 py3-pip \
    && apk add --no-cache --virtual .skillspector-build gcc musl-dev python3-dev \
    && pip install --no-cache-dir --break-system-packages \
      "skillspector @ git+https://github.com/NVIDIA/SkillSpector@${SKILLSPECTOR_REF}" \
    && cp "$(command -v skillspector)" /usr/local/bin/skillspector \
    && apk del .skillspector-build \
    && /usr/local/bin/skillspector --help > /dev/null
# SKILLSPECTOR_BIN pins the scanner binary to an absolute image path, and PYTHONNOUSERSITE=1 stops Python from loading user site-packages (.pth, usercustomize.py) from the mounted home volume (see specs/skillspector-scanner-trust.md).
ENV SKILLSPECTOR_BIN=/usr/local/bin/skillspector
ENV PYTHONNOUSERSITE=1
COPY --from=oven/bun:1.4.2-alpine /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
EXPOSE 4570
# The default bind is loopback, which a published container port cannot reach.
ENV ALATE_HOST=0.0.0.0
# Node's built-in fetch honors HTTP_PROXY/HTTPS_PROXY/NO_PROXY only when this is set
# (Node 24): behind a proxy-only corporate egress, every update check otherwise goes
# direct and times out. NO_PROXY keeps internal hosts on the direct route.
ENV NODE_USE_ENV_PROXY=1
CMD ["node", "server.ts"]
