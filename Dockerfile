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
    && apk del .skillspector-build \
    && skillspector --help > /dev/null
COPY --from=oven/bun:1.4.2-alpine /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
EXPOSE 4570
# The default bind is loopback, which a published container port cannot reach.
ENV ALATE_HOST=0.0.0.0
CMD ["node", "server.ts"]
