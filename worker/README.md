# Virtual Lab Studio — Prime Agent bridge worker

This is the piece of Virtual Lab Studio that runs on **your** machine.

Recursive participants are agents that can think for several turns and delegate
sub-questions to child agents. Running that inside the hosted studio would mean
running model-generated code on shared infrastructure, so the studio does not do
it. Instead, the studio queues the work, and this worker — sitting on your own
hardware, behind your own firewall — picks it up and runs it against your own
local models.

```
   your machine                                  the studio
  ┌───────────────────────────┐                 ┌──────────────────┐
  │  vls-worker               │  outbound HTTPS │                  │
  │    ├─ leases a job    ────┼────────────────>│  job queue       │
  │    ├─ runs it in a        │                 │                  │
  │    │  disposable          │<────────────────┼─ job + evidence  │
  │    │  container           │  events, result │                  │
  │    └─ local model server  │ ───────────────>│  meeting record  │
  └───────────────────────────┘                 └──────────────────┘
```

**Nothing listens.** The worker only makes outbound requests. You do not open a
port, forward anything through your router, or give the studio any way to reach
into your network.

---

## What it needs

| | |
|---|---|
| **Node.js** | 22.19 or newer (`node --version`) |
| **Docker** or **Podman** | for the sandbox. Docker Desktop on Windows/macOS is fine |
| **A local model server** | anything OpenAI-compatible: Ollama, LM Studio, vLLM, llama.cpp's server, text-generation-webui |
| **A worker enrollment token** | from the studio's *Recursive agents* page |

A 24 GB GPU comfortably runs a 32B model at the context sizes these jobs use. It
will work on less; it will simply think more slowly.

---

## Setup

### 1. Copy this folder to the machine that has the GPU

The worker is deliberately standalone — no monorepo, no pnpm, no build tooling
beyond TypeScript. Copy the `worker/` directory anywhere and:

```bash
cd worker
npm install
npm run build
```

### 2. Build the sandbox image

```bash
docker build -f docker/Dockerfile -t vls-bridge-runner:0.1.0 .
```

This takes a few minutes the first time. It installs Prime Agent and Python
inside the image, so nothing needs to be installed on your host beyond Node and
Docker.

### 3. Write your configuration

```bash
cp worker.config.example.json worker.config.json
```

Open it and replace every `<REPLACE_ME>`. The worker refuses to start while any
placeholder remains — an unconfigured worker that started anyway would enroll,
win jobs, and fail every one of them, which looks to the researcher like a
broken product rather than an unconfigured machine.

The values that matter:

- **`serverUrl`** — where your studio lives. Must be `https://` unless it is
  `localhost`.
- **`displayName`** — how this machine appears in the studio. Researchers pick a
  worker by this name, so make it recognisable: *"Lab desktop (RTX 3090)"* beats
  *"worker-1"*.
- **`models[]`** — one entry per model you want to offer.
  - `modelKey` is what researchers select in the studio.
  - `baseUrl` is your model server's OpenAI-compatible endpoint (Ollama:
    `http://127.0.0.1:11434/v1`).
  - `providerModelId` is what your server calls the model (`qwen3:32b`).
  - `apiKeyEnv` names an **environment variable**, never the key itself. Leave
    it `null` for a local server that needs no key.

### 4. Enroll

Get a one-time enrollment token from the studio (*Recursive agents → Add
worker*), then:

```bash
export VLS_ENROLLMENT_TOKEN=<the token>
node dist/index.js enroll
```

The token is a credential, so pass it through the environment rather than as an
argument — command lines are visible to other processes and land in your shell
history.

Enrollment writes a long-lived worker credential to `.vls/worker-token` with
owner-only permissions. It is never written to the config file and never logged.

### 5. Check everything

```bash
npm run doctor
```

```
OK    Configuration: 1 model, concurrency 1, sandbox container.
OK    Sandbox: docker 27.3.1 is available and the runner image is present.
OK    Model local-qwen3-32b: Reachable, serving qwen3:32b.
OK    Virtual Lab Studio: Connected. The studio reports this worker as online.

Everything checks out. Start the worker with: vls-worker run
```

The doctor leases no jobs and spends no tokens, so it is safe to run whenever
something looks wrong.

### 6. Run it

```bash
npm start
```

The worker appears as **online** in the studio. Researchers can now assign
recursive participants to it. Leave it running; `Ctrl-C` finishes the current
job before exiting (press it twice to stop immediately, at the cost of a job
that will have to be retried).

---

## What actually happens during a job

1. The worker asks the studio for work. If there is none, it waits and asks
   again.
2. It downloads a **job bundle**: the task, the meeting's frozen evidence, and a
   manifest listing every source with a stable key.
3. It creates a fresh throwaway directory and starts a container against it.
4. Inside the container, Prime Agent works on the task with exactly three tools:
   **Python**, **evidence search**, and **delegate to a child agent**.
5. Progress streams back to the studio as it happens, so the researcher watches
   the agent tree grow live.
6. The final answer, its citations and its stated limitations are validated and
   submitted.
7. The directory and the container are destroyed. Nothing about the job survives
   on your machine.

---

## Security

Read this section. The short version: **the container is the boundary, and you
should not remove it.**

Prime Agent's Python tool runs model-generated code. Upstream is explicit that
its kernel is not a sandbox — code runs with the permissions of the user that
started it. Everything below exists because of that one fact.

**The sandbox.** Every job runs in a container that is destroyed afterwards. It
runs as an unprivileged user with all Linux capabilities dropped, no ability to
gain new privileges, a read-only root filesystem, a small writable `tmpfs`, and
hard memory / CPU / process limits. The only writable thing that outlives the
container is the output file the runner writes.

**The network.** By default (`"network": "proxy"`) the container is attached to
a per-job network with **no route to the internet, your LAN, or your host**. It
cannot reach your NAS, your router's admin page, or a metadata endpoint. Model
calls go through a small proxy on the host that allows only chat and embedding
requests, and only to the model server you configured. Your provider key stays
on the host: the container is given a random job-scoped token instead, which is
worthless anywhere else and dies with the job.

Setting `"network": "none"` isolates it completely. There is deliberately no
option to attach the job container to your normal Docker bridge.

**The relay, and its residual risk.** A container on a `--internal` network
cannot reach the host, so proxy mode also starts a second container — a dumb TCP
forwarder with no knowledge of your key — attached to both the job's internal
network and a per-job routable network. That forwarder *can* reach your host and
LAN; it is the one routable piece in the design, and it is worth knowing about
rather than glossing over. It runs with the same lockdown as the job container
(unprivileged, no capabilities, read-only root, memory / CPU / process caps) and
runs `dist/runner/relay.js` and nothing else, so reaching your LAN through it
would take a remote hole in a ~50-line forwarder that speaks no protocol. The
cleaner alternatives — mounting a unix socket, or dialling the internal
network's gateway address — do not work on Docker Desktop for Windows, which is
the machine this worker is built for. On Linux you can avoid the relay entirely
by running your model server in a container and attaching it to the job network
yourself.

**Spending is measured, not self-reported.** Every model call passes through the
host proxy, which reads the token counts back off the responses. That measured
figure — not the number the sandbox reports — is what the meeting's token limit
is enforced against, and once it is spent, further calls are refused and the
container is stopped. Three details make that hold against a container that is
not running the code you built:

- Each call's output ceiling is rewritten down to what the budget can still
  afford before the request is forwarded, so no single call can knowingly
  exceed the meeting's limit. The generation limit is then enforced by the
  model server, which is outside the sandbox.
- Every field that could raise the ceiling — both spellings of the output
  limit, `n`, `best_of` — is rewritten to the value the proxy charged for, so
  the request that is forwarded is the request that was accounted for.
- Each call is charged an estimate *before* it is forwarded and settled to the
  real figure when it returns, so a burst of simultaneous calls cannot all slip
  through the same "not over budget yet" reading.
- Streaming requests have usage reporting turned on by the proxy, overriding the
  caller — a request that asks not to be counted does not get its wish.
- A response that declares no usage is counted as *unmeasured*, not as free: the
  turn's cost is then reported as incomplete rather than understated, and a
  separate call ceiling stops a loop that never reports anything.

The one exception is `allowUnsafeProcessRunner` below, which has no proxy in
front of it and therefore no independent accounting.

What this does *not* give you is a token-exact guarantee. The prompt side of the
reservation is estimated from the request's bytes, and bytes are not tokens: a
prompt can cost somewhat more than was held for it until the response reports
the real figure. The output side is clamped and enforced by the model server, a
call too large for the remaining budget is refused before it is sent, and the
measured total is what the meeting is judged against — so the exposure is
bounded and self-correcting rather than open-ended. A hard guarantee would need
the proxy to tokenise prompts with the model's own tokeniser, which it does not
do.

**Evidence is data, not instructions.** Every source the agent reads is labelled
untrusted, and the agent is told so. Evidence is resolved only through the
studio's manifest — the agent asks for a key like `E3`, never a file path — so a
document cannot talk the agent into reading something else.

**What the agent cannot see.** The container gets the job and nothing else: not
your worker credential, not your model API key, not your Prime Agent
configuration, your extensions, your skills, your prompt templates, your
memories or your history. If you use Prime Agent for your own work, none of that
is visible to a research participant.

**Bounds are counted on the host.** Child-agent count, nesting depth, tokens,
runtime and cost are enforced by the worker, not by asking the model nicely. A
runtime that exceeds them has its job stopped and reported, not quietly
truncated. Counts come from the host side of the boundary in every case: the
event stream is checked against the bounds as it arrives, tokens are metered at
the proxy, and the wall clock is enforced by a host timer that kills the
container.

**The one unsafe option.** `allowUnsafeProcessRunner` runs jobs directly on your
machine with no container. It exists for developing the worker itself. It
refuses to start when `NODE_ENV=production`, warns loudly every time, and should
never be used with a model working on real evidence.

---

## Troubleshooting

**`doctor` says the sandbox is not ready.** Docker is not running, or the image
was never built. Start Docker Desktop, then re-run the build command from step 2.

**`doctor` says the model server is unreachable.** Check the server is up and
that `baseUrl` includes the `/v1` suffix. Ollama listens on `11434`, LM Studio
on `1234`. If the model server runs on a *different* machine from the worker,
`127.0.0.1` will not work — use its LAN address.

**`doctor` warns that your model is not listed.** The server is reachable but
does not have that model. `ollama pull qwen3:32b`, or correct
`providerModelId` to one of the ids the warning lists.

**The studio shows the worker as offline.** The worker sends a heartbeat every
20 seconds and the studio marks it offline after 90. Check the process is still
running and that nothing between you and the studio is dropping long-lived
outbound connections.

**Jobs fail with `invalid_result`.** The model produced an answer citing
evidence that was not attached to the meeting. Smaller models do this. It is
reported rather than silently accepted, because a citation that resolves to
nothing is worse than no citation. Try a larger model, or attach the sources the
question actually needs.

**Jobs fail with `limit_exceeded`.** The participant tried to spawn more child
agents, or nest them deeper, than the meeting allows. Raise the limits on the
participant in the studio, or ask a narrower question.

**Everything is very slow.** Check the model is on the GPU and not spilling to
CPU (`nvidia-smi` during a run). A 32B model at 32k context needs roughly 20 GB.

---

## Verifying it really works

The test suite runs against a fake studio and a fake runtime:

```bash
npm test
```

That proves the plumbing — the protocol, the bounds, the redaction, the
validation — and, since the Prime Agent SDK is installed here, it also drives
the real SDK against a scripted model server, so the tool allow-list, the
system prompt and the turn cap are checked against what actually goes on the
wire. One of those tests runs the real runner process against a model that
loops forever, and checks the studio is told the job failed rather than being
handed the participant's half-written answer. What none of it involves is a
container or a real model.

Two further tests cover those, and both are skipped unless you opt in.

The first runs the real runner image against a scripted model, so it needs
Docker but no GPU:

```bash
docker build -f docker/Dockerfile -t vls-bridge-runner:0.1.0 .
VLS_CONTAINER_SMOKE=1 npm test
```

The second is the one that proves real recursion end to end:

```bash
VLS_SMOKE=1 \
VLS_SMOKE_SERVER=https://your-studio.example.com \
VLS_SMOKE_TOKEN=$(cat .vls/worker-token) \
VLS_SMOKE_MODEL_URL=http://127.0.0.1:11434/v1 \
VLS_SMOKE_MODEL_ID=qwen3:32b \
npm test
```

It waits for the studio to hand it a real job, so launch a meeting with a
recursive participant while it runs. When it is skipped, it says so in words —
*"real recursion was NOT exercised by this run"* — because a skipped test that
reads like a pass is how an unproven feature ends up in a release note.

---

## Commands

| Command | What it does |
|---|---|
| `node dist/index.js enroll` | Register this machine with the studio |
| `node dist/index.js doctor` | Check config, sandbox, models and connection |
| `node dist/index.js run` | Poll for work and run it |
| `node dist/index.js version` | Print worker and pinned Prime Agent versions |

All commands accept `--config <path>` and `--log-level debug|info|warn|error`.

---

## Licence

MIT, the same as Virtual Lab Studio. Prime Agent is a separate upstream project
with its own licence; this worker pins version 0.84.0 and installs it inside the
sandbox image.
