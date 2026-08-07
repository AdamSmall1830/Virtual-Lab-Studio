# The runner image.
#
# This image is the inside of the sandbox: it holds Prime Agent, a Python
# interpreter and this worker's compiled runner, and nothing else that a
# research participant could use. It is built to be boring -- pinned base, one
# unprivileged user, no shell tooling beyond what Python needs -- because every
# extra binary is one more thing model-generated code can reach for.
#
# Build it from the worker directory:
#
#   docker build -f docker/Dockerfile -t vls-bridge-runner:0.1.0 .
#
# The container is started by the worker with --read-only, --cap-drop ALL,
# --network on an internal-only bridge and a non-root --user, so nothing here
# should assume it can write outside /tmp or reach the internet.

# Pinned by digest-bearing tag: a floating :22 would silently change the
# interpreter under a research participant between two runs of the same study.
FROM node:22.19.0-bookworm-slim AS build

WORKDIR /build
COPY package.json tsconfig.json ./
COPY src ./src

# The SDK is an optionalDependency of the worker, but inside this image it is
# required: this is the one place a real job actually runs.
RUN npm install --no-audit --no-fund \
 && npm install --no-audit --no-fund --save-exact @earendil-works/pi-coding-agent@0.84.0 \
 && npx tsc -p tsconfig.json

FROM node:22.19.0-bookworm-slim AS runtime

# python3 for the participant's Python tool and the evidence skill; ca-certificates
# so the model proxy can be reached over TLS when the operator's endpoint uses it.
# No curl, no git, no build toolchain: nothing that turns a code-execution tool
# into a download-and-run tool.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-numpy ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && apt-get clean

# A fixed, unprivileged uid that matches the --user flag the worker passes.
# Named rather than numeric-only so Python's getpass and Node's os.userInfo()
# do not fail inside a read-only container.
RUN groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --home-dir /home/agent --shell /usr/sbin/nologin agent \
 && mkdir -p /home/agent /job/input /job/output \
 && chown -R 10001:10001 /home/agent /job

WORKDIR /app
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist

ENV NODE_ENV=production \
    PI_OFFLINE=1 \
    NO_COLOR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/home/agent \
    TMPDIR=/tmp \
    VLS_INPUT_DIR=/job/input \
    VLS_OUTPUT_DIR=/job/output

USER 10001:10001

# No shell in the entrypoint: the container runs one program, and PID 1 being
# node rather than sh means a signal from the host reaches the runner directly.
ENTRYPOINT ["node", "/app/dist/runner/entrypoint.js"]
