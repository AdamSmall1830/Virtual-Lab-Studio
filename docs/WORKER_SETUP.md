# Running the bridge worker on Windows 11

This is the walkthrough for standing up a Virtual Lab Studio bridge worker on
your own Windows 11 workstation with a local NVIDIA GPU and local models.
Follow it with the studio open in one window and PowerShell in the other.

The reference machine is Windows 11 + RTX 3090 (24 GB) + Ollama. Everything
here works on smaller cards and other model servers; where the choice matters,
it is called out.

This is the *Windows* guide only. It does not repeat the full config reference,
the security model or the protocol details — those live in `worker/README.md`,
and you should read that file's **Security** section before you run a real
study. This guide points back to the README where the README is the authority.

---

## 1. Before you start

### What this gets you

A recursive participant is an agent that thinks for several turns and can
delegate sub-questions to child agents. The studio does not run that code on its
own infrastructure. Instead it queues the work, and this worker — on your
machine, behind your firewall — leases it, runs it against your local models
inside a disposable container, and streams the result back. The worker only
makes **outbound** requests; nothing listens, and you open no ports.

### Prerequisites

| What | Detail |
|---|---|
| **Node.js** | 22.19.0 or newer. Check with `node --version`. The worker's `package.json` sets `engines.node` to `>=22.19.0`. |
| **Docker Desktop + WSL2** | The sandbox is a container. On Windows, Docker Desktop with the WSL2 backend is the supported engine. Install WSL2 first (`wsl --install`), then Docker Desktop, and confirm `docker version` returns both a client and a server. |
| **GPU / VRAM** | An NVIDIA GPU your model server can use. A 24 GB card (RTX 3090/4090) comfortably runs a 32B model at the context sizes these jobs use. Less VRAM works; it simply thinks more slowly (see §2). |
| **A local model server** | Anything OpenAI-compatible. Ollama is the primary path here; LM Studio, vLLM and `llama.cpp`'s server are all fine alternatives. |
| **An enrollment token** | Minted in the studio, one machine at a time. See §5. |

You do **not** need Python, Prime Agent, or any build toolchain on the host. All
of that is installed *inside* the sandbox image, not on Windows.

A note on the sandbox on Windows: proxy mode (the default) runs a second small
container — a plain TCP forwarder — so the job container can reach your model
server without being able to reach your host or LAN directly. This exists
because the cleaner Linux-only alternatives do not work on Docker Desktop for
Windows. The full explanation is in the **Security → The relay** section of
`worker/README.md`; read it before a real study.

---

## 2. Install the local model server and pull a model

### Ollama (primary)

Install Ollama for Windows from the official installer. It runs as a background
service and listens on `127.0.0.1:11434`. Its OpenAI-compatible endpoint is at
`http://127.0.0.1:11434/v1`.

Pull a model that fits your card. On a 24 GB card:

```powershell
ollama pull qwen3:32b
```

How model size maps to VRAM, roughly, for a quantised model at a working
context: a 32B model at 32k context needs about 20 GB, which is why 24 GB is the
comfortable target. On a smaller card (say 12–16 GB), pull a smaller model —
`ollama pull qwen3:14b` or an 8B — rather than a 32B. If a 32B model does not
fit, Ollama will spill layers to CPU and the run becomes very slow rather than
failing outright; watch for that with `nvidia-smi` during a job.

### OpenAI-compatible alternatives

Any of these works in place of Ollama; you point the worker's `baseUrl` at their
endpoint (see §6):

- **LM Studio** — start its local server; it listens on `127.0.0.1:1234`, so
  `baseUrl` is `http://127.0.0.1:1234/v1`.
- **vLLM** — serves an OpenAI-compatible API; use the host and port you start it
  on, with a `/v1` suffix.
- **llama.cpp** — its `server` binary exposes an OpenAI-compatible endpoint;
  again, use its address with `/v1`.

### Verify it responds before going further

The worker talks to the server's `/models` and chat-completions endpoints, so
prove those work first:

```powershell
curl.exe http://127.0.0.1:11434/api/tags
curl.exe http://127.0.0.1:11434/v1/models
```

The second call is the one the worker's doctor uses. It should list the model
you pulled. (`curl.exe` is the real curl on Windows; PowerShell's bare `curl` is
an alias for `Invoke-WebRequest` and formats output differently.)

---

## 3. Get the worker onto the machine

The worker is deliberately standalone: no monorepo, no pnpm. Copy the `worker/`
directory anywhere on the machine, then from inside it:

```powershell
cd worker
npm install
npm run build
```

`npm run build` runs `tsc` and produces `dist/`. The CLI you will run for the
rest of this guide is `node dist/index.js <command>`. The package also installs
a `vls-worker` bin, so if you ran `npm link` or installed it globally you can
use `vls-worker <command>`; this guide uses the `node dist/index.js` form
because it works straight after a local build.

---

## 4. Build the sandbox container image

Still inside `worker/`:

```powershell
docker build -f docker/Dockerfile -t vls-bridge-runner:0.1.0 .
```

This takes a few minutes the first time. The image contains Prime Agent (pinned
to 0.84.0), a Python 3 interpreter with numpy, and this worker's compiled
runner — and nothing else. There is no curl, no git and no build toolchain
inside it, so model-generated code has nothing to download-and-run with. The tag
`vls-bridge-runner:0.1.0` is the exact value the worker's default config
expects; do not rename it unless you also change `sandbox.image` in the config.

Docker Desktop must be running for this and for every later `run`. If it is not,
the build and the worker will both tell you the sandbox is not ready.

---

## 5. Enrol

### Where the token comes from

In the studio, go to **Settings → Recursive Workers**. This is an admin-only
screen. Type a recognisable name for this machine into the field — the
placeholder suggests *"Lab workstation (RTX 3090)"* — and click **Create
enrollment token**.

The token is shown exactly once, in a card you can copy. The server keeps only a
hash of it, so it cannot be shown again; if you lose it, mint a new one. It has
a limited lifetime — by default 15 minutes (`RECURSIVE_WORKER_ENROLLMENT_TTL_SECONDS`
is 900 seconds server-side) — and it is single-use, consumed the first time a
worker enrols with it.

### Redeem it on the machine

The token is a credential, so pass it through the environment rather than on the
command line, where it would land in your shell history:

```powershell
$env:VLS_ENROLLMENT_TOKEN = "<paste the token>"
node dist/index.js enroll
```

Bash equivalent:

```bash
export VLS_ENROLLMENT_TOKEN=<paste the token>
node dist/index.js enroll
```

(You can also pass `--token <token>` instead of the environment variable, but
the environment form keeps it out of your history.)

On first enrolment the worker exchanges the one-time token for a long-lived
worker credential and writes it to `.vls/worker-token`, relative to the config
file, with owner-only permissions. That credential is never written to the
config file and never logged; the only place it ever appears is an
`Authorization` header on outbound requests to the studio. Enrolment also
reports this build's version, sandbox mode and model catalogue to the studio, so
the machine appears in the workers list immediately.

---

## 6. Configure `worker.config.json`

Copy the example and edit it:

```powershell
Copy-Item worker.config.example.json worker.config.json
```

Bash: `cp worker.config.example.json worker.config.json`.

The worker refuses to start while any `<REPLACE_ME>` placeholder remains,
naming the field it found — an unconfigured worker that started anyway would
enroll, win jobs and fail every one, which reads as a broken product rather
than an unconfigured machine. The three fields shipped as placeholders are
`serverUrl`, `displayName`, and everything inside the `models[]` entry
(`modelKey`, `displayName`, `baseUrl`, `providerModelId`).

A fully worked example for the reference machine:

```json
{
  "serverUrl": "https://your-studio.example.com",
  "displayName": "Lab workstation (RTX 3090)",
  "concurrency": 1,
  "agentRuntime": "auto",
  "workspaceRoot": ".vls/jobs",
  "workerTokenFile": ".vls/worker-token",
  "sandbox": {
    "kind": "container",
    "engine": "docker",
    "image": "vls-bridge-runner:0.1.0",
    "network": "proxy",
    "memory": "4g",
    "cpus": "2",
    "pidsLimit": 256,
    "maxRuntimeSecondsCeiling": 3600,
    "allowUnsafeProcessRunner": false
  },
  "models": [
    {
      "modelKey": "local-qwen3-32b",
      "displayName": "Qwen3 32B (local)",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "providerModelId": "qwen3:32b",
      "apiKeyEnv": null,
      "contextWindow": 32768,
      "maxTokens": 8192,
      "supportsTools": true,
      "pricing": {
        "input_per_million_usd": 0,
        "output_per_million_usd": 0,
        "currency": "USD"
      }
    }
  ]
}
```

Every field, one line each (the full reference is in `worker/README.md`):

- **`serverUrl`** — your studio's address. Must be `https://`, unless the host
  is `localhost`/`127.0.0.1` (allowed only for local development).
- **`displayName`** — how this machine appears in the studio; researchers pick a
  worker by this name, so make it recognisable.
- **`concurrency`** — how many jobs run at once (1–8). Leave at 1 unless the GPU
  can genuinely serve two runs in parallel.
- **`agentRuntime`** — leave at `auto`; it uses the real Prime Agent SDK when
  present.
- **`workspaceRoot`** — where per-job throwaway directories are created, relative
  to the config file.
- **`workerTokenFile`** — where the enrolment credential lives; the default is
  fine.
- **`sandbox.kind`** — `container` for any real research. (`process` runs jobs
  with no isolation; do not use it.)
- **`sandbox.engine`** — `docker` on Windows (`podman` also accepted).
- **`sandbox.image`** — the image you built in §4; keep it matched to the tag.
- **`sandbox.network`** — leave at `proxy`. `none` isolates the container
  completely and blocks model calls too.
- **`sandbox.memory` / `cpus` / `pidsLimit`** — hard resource caps on the job
  container.
- **`sandbox.maxRuntimeSecondsCeiling`** — ceiling on job runtime regardless of
  what a job asks for (60–86400).
- **`sandbox.allowUnsafeProcessRunner`** — leave `false`. It exists only for
  developing the worker and refuses to start under `NODE_ENV=production`.
- **`models[].modelKey`** — the stable key researchers select in the studio.
- **`models[].displayName`** — the human label shown next to it.
- **`models[].baseUrl`** — your server's OpenAI-compatible endpoint, with the
  `/v1` suffix. Ollama: `http://127.0.0.1:11434/v1`.
- **`models[].providerModelId`** — what your server calls the model
  (`qwen3:32b`), which may differ from `modelKey`.
- **`models[].apiKeyEnv`** — the *name of an environment variable* holding the
  API key, never the key itself. `null` for a keyless local server.
- **`models[].contextWindow` / `maxTokens` / `supportsTools`** — what the model
  can do; `supportsTools` must be `true` to be usable for recursive work.
- **`models[].pricing`** — leave at zero for a local model; the studio then
  reports a truthful cost of zero rather than inventing one.

If your model server needs a key, set `apiKeyEnv` to a variable name and export
that variable in the shell that starts the worker (`$env:MY_KEY = "..."`). The
key is read late from the environment and never stored in the config.

### Check everything before running

```powershell
npm run doctor
```

The doctor is strictly read-only: it leases no job and spends no token, so it is
safe to run whenever something looks wrong. A healthy result looks like:

```
OK    Configuration: 1 model, concurrency 1, sandbox container.
OK    Sandbox: docker 27.3.1 with image vls-bridge-runner:0.1.0.
OK    Model local-qwen3-32b: Reachable, serving qwen3:32b.
OK    Virtual Lab Studio: Connected. The studio reports this worker as online.

Everything checks out. Start the worker with: vls-worker run
```

Each check names what it tried, so a failure tells you *which* of the four
moving parts (config, sandbox, model server, studio) is wrong.

---

## 7. First run

```powershell
npm start
```

(`npm start` runs `node dist/index.js run`.) A healthy start logs that it is
waiting for work, naming the server, concurrency and sandbox mode. It then
heartbeats every 20 seconds and polls for a lease when it has a free slot.

Back in the studio, **Settings → Recursive Workers** now shows this machine.
"Online" means the studio heard from it recently: a worker counts as online for
90 seconds after each check-in, and is marked offline after that. The card also
shows the bridge version, the Prime Agent version, the sandbox mode, and the
**advertised models** — the catalogue the worker reported, with the
recursive-capable ones highlighted. That catalogue is how a researcher's model
dropdown gets populated when they assign work to this machine.

Leave it running. `Ctrl-C` finishes the current job before exiting; press it a
second time to stop immediately, at the cost of a job that will have to be
retried.

---

## 8. Run your first recursive meeting end to end

1. In the studio, build or open a meeting and add a participant.
2. On that participant, set **Execution runtime** to **Recursive agent (beta)**.
   The option is only enabled when an online worker advertises a
   recursive-capable model.
3. Choose the **Worker machine** (this one), the **Coordinator model**, and
   optionally a **Child model** (defaults to the coordinator's). Optionally open
   **Limits for this participant** to set child/depth/turn/runtime/token/cost
   ceilings — these are ceilings, not targets.
4. Launch the run.

What to watch in the **live room**: the recursive panel shows the agent tree for
the run, refreshing as worker events arrive. You will see the coordinator start,
child agents appear as it delegates, node counts climb, and finally the answer
with its citations. The worker leases the job, downloads the frozen-evidence
bundle, runs it in a fresh container, streams progress, submits the validated
result, and destroys the container and directory — nothing about the job
survives on your machine.

A first run is a good place to confirm the model is actually on the GPU: run
`nvidia-smi` during the meeting and check the model is resident in VRAM rather
than spilling to CPU.

---

## 9. Keeping it running

### Autostart on Windows

**We do not ship a service installer.** The worker is a foreground process you
start with `node dist/index.js run`. If you want it to come up automatically,
the honest options are:

- **Task Scheduler** — create a task that runs `node` with argument
  `dist/index.js run`, with "Start in" set to the `worker/` directory, triggered
  **At log on** (or at startup, if the model server also starts without a login
  session). Set it to restart on failure. This is the simplest approach that
  works out of the box.
- **A third-party service wrapper** (e.g. NSSM) — if you want it to run as a
  true Windows service independent of login. This is not part of this project;
  you are wrapping the same `node dist/index.js run` command yourself.

Whichever you pick, the model server and Docker Desktop must be up before the
worker leases a job; the worker will simply keep polling and its jobs will fail
until they are. Docker Desktop can be set to start at login in its own settings.

### Logs

The worker logs to the console (stdout/stderr). It does not write a log file of
its own, so if you run it under Task Scheduler or a wrapper, redirect its output
to a file yourself. Raise detail with `--log-level debug`; all commands accept
`--log-level debug|info|warn|error` and `--config <path>`.

### Updating the worker

Replace the `worker/` directory contents with the new version, then from inside
it:

```powershell
npm install
npm run build
docker build -f docker/Dockerfile -t vls-bridge-runner:0.1.0 .
```

Rebuild the image whenever the worker or its pinned Prime Agent version changes;
the image is versioned by tag for a reason. Your `worker.config.json` and
`.vls/worker-token` are not touched by an update, so you do not re-enrol.
`node dist/index.js version` prints the worker and pinned Prime Agent versions
if you need to confirm what a build is.

---

## 10. Troubleshooting

Run `npm run doctor` first for any of these; it isolates which part is wrong
without touching a job.

| Symptom | Likely cause | What to check |
|---|---|---|
| **Worker will not start**, complaining a field "still contains `<REPLACE_ME>`" | An unfilled placeholder in the config | Open `worker.config.json` and fill the named field. Every `<REPLACE_ME>` must be replaced. |
| **Worker will not start**, "No configuration file at …" | Config missing or wrong path | Copy the example (§6). Pass `--config <path>` if it is not `worker.config.json` in the current directory. |
| **`run` says "This machine is not enrolled yet"** | No `.vls/worker-token` | Enrol first (§5). The token file lives next to the config. |
| **Enrolment rejected** ("not valid or has expired") | Token expired, already used, or mistyped | Mint a fresh token in the studio; it is single-use and expires after ~15 minutes. Copy it exactly. |
| **Worker stays offline in the studio** | Process stopped, or a proxy dropping long-lived outbound connections | Confirm the process is running; the studio marks a worker offline 90s after its last heartbeat (sent every 20s). Check nothing between you and the studio is closing idle connections. |
| **Studio rejects the credential; worker stops** | Worker disabled or revoked in the studio, or the server's pepper was rotated | Re-enable it on the Recursive Workers page, or enrol again if it was revoked/rotated (a revoked worker cannot be re-enabled). |
| **Never leases a job** | No model advertised, or no meeting assigned to this worker/model | Confirm the worker's advertised models include a recursive-capable one, and that a running meeting has a recursive participant pointed at this machine and model. |
| **Job fails immediately with `invalid_result`** | The model cited evidence not attached to the meeting (smaller models do this) | Try a larger model, or attach the sources the question needs. |
| **Job fails with `limit_exceeded`** | Participant tried to exceed its child/depth/turn/token bounds | Raise the participant's limits in the studio, or ask a narrower question. |
| **Model server unreachable** (doctor "Could not reach the model server") | Server down, wrong `baseUrl`, or missing `/v1` suffix | Start the server; confirm `curl.exe http://127.0.0.1:11434/v1/models` responds. If the server is on another machine, `127.0.0.1` will not work — use its LAN address. |
| **Model listed as not served** (doctor warns your model is not listed) | Server reachable but that model is not pulled | `ollama pull <model>`, or set `providerModelId` to one of the ids the warning lists. |
| **Docker not running** (doctor "sandbox is not ready" / "will not run") | Docker Desktop stopped, or image never built | Start Docker Desktop; rebuild the image (§4). |
| **Out of VRAM / everything very slow** | Model too large for the card, spilling to CPU | Run `nvidia-smi` during a job; if layers are on CPU, pull a smaller model (§2). |

---

## 11. Turning it off safely

There are three levels, from least to most permanent:

- **Stop the process.** `Ctrl-C` in the worker's window finishes the in-flight
  job before exiting; a second `Ctrl-C` stops now and that job is retried
  elsewhere. Stopping the process leaves the enrolment intact — restart with
  `npm start` and it comes back online.
- **Disable the worker in the studio.** On **Settings → Recursive Workers**,
  click **Disable** on the machine's card. It stops being handed new jobs and
  the worker's next heartbeat is rejected, so its loop stops; the credential is
  preserved and you can **Enable** it again later.
- **Revoke the credential.** Click **Revoke** for a permanent cut. The token
  stops working immediately and the worker cannot be re-enabled — the machine
  must enrol again with a fresh token. Use this if the credential may have
  leaked.

What happens to a job in flight: if the meeting is cancelled or the worker's
lease is lost mid-job, the worker stops work on it and does not overwrite a
result the studio may have reassigned. A lease is a countdown — if the process
dies mid-job, the studio hands the work to another eligible worker once the
lease expires, so a job is never silently lost, only delayed.
