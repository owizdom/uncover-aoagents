# uncover-aoagents

A minimal reverse-engineered version of [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) — the tool that runs N coding agents in parallel on the same repo without them stepping on each other.

~400 lines of TypeScript. One trick per file. MIT.

All credit to [@aoagents](https://x.com/aoagents) / ComposioHQ — this repo exists so you can read the whole harness in one sitting and understand *why* it works.

---

## What it does

```
$ uncover spawn int-1 --branch feat/INT-1 --repo ~/code/myrepo
uncover session ready:
  session:      int-1
  worktree:     ~/.uncover/worktrees/int-1
  branch:       feat/INT-1
  metadata:     ~/.uncover/sessions/int-1
  shim dir:     ~/.uncover/bin

Run your agent inside the worktree with:
  cd ~/.uncover/worktrees/int-1
  export UNCOVER_DATA_DIR=~/.uncover/sessions
  export UNCOVER_SESSION=int-1
  export PATH=~/.uncover/bin:$PATH
  claude     # or codex, aider, opencode — any CLI agent

$ uncover list
SESSION         STATUS      BRANCH                    PR
--------------------------------------------------------
int-1           pr_open     feat/INT-1                https://github.com/you/myrepo/pull/42
int-2           working     feat/INT-2                -
int-3           merged      feat/INT-3                https://github.com/you/myrepo/pull/41
```

`uncover` spawns an isolated git worktree for each agent, installs shell wrappers that intercept `gh pr create` / `git checkout -b`, and writes observed state to a flat file that both bash and TypeScript can read. The agent has no idea it's being watched.

## The five tricks

These are the ideas I extracted from agent-orchestrator. Each one is isolated in a single file so you can read them without going through a monorepo.

### 1. PATH shim on `gh` and `git`

**uncover:** [`src/shims.ts`](src/shims.ts) · **upstream:** [`packages/core/src/agent-workspace-hooks.ts`](https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/core/src/agent-workspace-hooks.ts)

Instead of building an SDK, patching agents, or writing a coordination protocol, `uncover` installs fake `gh` and `git` binaries at `~/.uncover/bin/` and prepends that directory to the agent's `$PATH`.

Any agent that eventually shells out — Codex, Aider, OpenCode, your own bash loop — runs through the wrapper. When the agent runs `gh pr create`, the wrapper calls real `gh`, parses the PR URL from stdout, and atomically writes it to the session metadata file.

The agent has no idea it's being observed. **Zero agent code modified.**

(Claude Code has its own `PostToolUse` hook system and upstream uses that instead for Claude specifically — the PATH shim is how the harness stays agent-agnostic for everything else.)

### 2. Atomic metadata writes

**uncover:** [`src/metadata.ts`](src/metadata.ts) · **upstream:** [`packages/core/src/atomic-write.ts`](https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/core/src/atomic-write.ts)

```ts
export function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}
```

That's the whole thing. `rename()` is atomic on POSIX, so N concurrent writers never produce a torn read. This is the only reason the orchestrator (TypeScript), the `gh` wrapper (bash), and the `git` wrapper (bash) can hammer the same file without corrupting each other's state.

The bash helper does the equivalent with `sed > tmp; mv tmp actual` — same idea, same guarantee.

### 3. Git worktrees with 3-deep base-ref fallback

**uncover:** [`src/worktree.ts`](src/worktree.ts) · **upstream:** [`packages/plugins/workspace-worktree/src/index.ts`](https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/plugins/workspace-worktree/src/index.ts)

Each agent gets its own `git worktree`, not a clone and not a tarball. 50 agents = 50 worktrees on the same `.git` database. Cheap, fast, isolated — `git push` from any worktree is as fast as it would be from the main repo, because it *is* the main repo.

The underappreciated part is base-ref resolution. Online, offline, duplicate branches — it all Just Works because of a 3-deep fallback:

1. `origin/<branch>` if the feature branch already exists on remote
2. `origin/<defaultBranch>` otherwise (latest main from remote)
3. `refs/heads/<defaultBranch>` if offline (local main)

And if `git worktree add -b` fails because the branch already exists, it silently falls through to `git worktree add` + `git checkout <branch>`. Boring but load-bearing.

### 4. Flat `key=value` metadata (bash-readable on purpose)

**uncover:** [`src/metadata.ts`](src/metadata.ts) · **upstream:** [`packages/core/src/metadata.ts`](https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/core/src/metadata.ts)

The metadata format is:

```
worktree=/Users/foo/.uncover/worktrees/int-1
branch=feat/INT-1234
status=pr_open
pr=https://github.com/foo/bar/pull/42
createdAt=2026-04-12T00:57:40.326Z
```

Not JSON. Not SQLite. Not a daemon. Just `key=value` lines. Why? So the bash wrappers can `grep` / `sed` them without shelling back into Node for every `gh` call. The performance cost of the shim becomes ~2 ms of bash overhead per observed command instead of spawning a JSON parser.

### 5. LLM-as-merge-conflict-resolver

**upstream:** [`packages/plugins/scm-github/src/index.ts`](https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/plugins/scm-github/src/index.ts)

`uncover` doesn't implement this (it'd double the line count), but it's too clever not to call out.

Upstream doesn't ship an AST-based merge resolver. It runs `git merge`, captures the raw `<<<<<<<` / `=======` / `>>>>>>>` markers, and feeds them back to the agent. The LLM already understands diff format, so why write a resolver?

The laziest solution is the best one.

## Architecture

```
                    ┌───────────────────────────┐
                    │     uncover CLI (TS)      │
                    │   src/index.ts            │
                    └──────────────┬────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
┌───────────────┐          ┌───────────────┐          ┌───────────────┐
│  shims.ts     │          │  worktree.ts  │          │  metadata.ts  │
│               │          │               │          │               │
│ install fake  │          │ git worktree  │          │ atomic write  │
│ gh + git at   │          │ add with 3-   │          │ key=value     │
│ ~/.uncover/   │          │ deep base-ref │          │ flat files    │
│ bin/          │          │ fallback      │          │               │
└───────┬───────┘          └───────┬───────┘          └───────┬───────┘
        │                          │                          │
        │                          ▼                          │
        │                  ┌───────────────────┐              │
        │                  │ ~/.uncover/       │              │
        │                  │   worktrees/      │              │
        │                  │     int-1/        │              │
        │                  │     int-2/        │              │
        │                  │     int-3/        │              │
        │                  └───────────────────┘              │
        │                                                     │
        ▼                                                     ▼
┌──────────────────┐                            ┌──────────────────────┐
│  ~/.uncover/bin/ │                            │ ~/.uncover/sessions/ │
│    gh  (bash)    │ ──── observes ──────────▶ │   int-1              │
│    git (bash)    │      PR urls,              │   int-2              │
│    helper.sh     │      branch switches       │   int-3              │
└────────┬─────────┘                            └──────────┬───────────┘
         │                                                 ▲
         │                                                 │
         │             agent's shell                       │
         ▼                                                 │
    ┌──────────────────────────────────────────┐           │
    │  $ cd ~/.uncover/worktrees/int-1         │           │
    │  $ export PATH=~/.uncover/bin:$PATH      │           │
    │  $ claude                                │           │
    │      ↓ agent runs `gh pr create`         │           │
    │      ↓ hits the shim                     │           │
    │      ↓ shim → real gh → parses URL       │           │
    │      ↓ shim writes pr=... ───────────────┼───────────┘
    └──────────────────────────────────────────┘
```

## Quickstart

```bash
# 1. Install
git clone https://github.com/<your-handle>/uncover-aoagents
cd uncover-aoagents
npm install
npm run build   # optional — tsx works fine for dev

# 2. Spawn a session against any git repo
npx tsx src/index.ts spawn int-1 \
  --branch feat/INT-1 \
  --repo ~/code/myrepo \
  --default-branch main \
  --issue INT-1

# 3. In another terminal, start your agent with the env block printed above
cd ~/.uncover/worktrees/int-1
export UNCOVER_DATA_DIR=~/.uncover/sessions
export UNCOVER_SESSION=int-1
export PATH=~/.uncover/bin:$PATH
claude                # or codex, aider, opencode

# 4. Watch state change live
npx tsx src/index.ts watch

# 5. Clean up when done
npx tsx src/index.ts destroy int-1
# Removes the worktree. Does NOT delete the branch —
# same policy as upstream, same reason: deleting branches by name
# risks nuking pre-existing local branches that happen to match.
```

## Run the demo (two modes)

### 🔥 Real demo — 3 Claude Code agents, real commits, ~25s

`demo/real.sh` spawns 3 headless `claude -p` processes in parallel, each
inside its own git worktree on [@owizdom/bobIsAlive](https://github.com/owizdom/bobIsAlive).
Each agent edits `README.md` with a different section and commits. The
`uncover` git shim intercepts every commit and the `watch` command shows
the cascade in real time.

```bash
# Terminal 1 — create 3 sessions + launch 3 real Claude Code agents
bash demo/real.sh

# Terminal 2 — leave this running to see the state cascade
npx tsx src/index.ts watch
```

Requires: `claude` CLI installed and authenticated (Max OAuth via keychain
or `ANTHROPIC_API_KEY`), and `/Users/Apple/Desktop/all/swarm-escrow` on
disk. See [`demo/RECORDING.md`](demo/RECORDING.md) for the exact commands
to record this as a tweet-ready screencast.

### Simulate demo — no agents required, ~6s

If you don't have claude installed, `demo/simulate.sh` fires the bash
helper directly to prove the end-to-end observation loop works. Good for
debugging, not for video:

```bash
# Terminal 1 — create 3 sessions against a scratch git repo
bash demo/setup.sh

# Terminal 2 — live-watch
npx tsx src/index.ts watch

# Terminal 1 again — simulate 3 agents transitioning state
bash demo/simulate.sh
```

`simulate.sh` sources the exact same bash helper the PATH shims install,
then calls `update_uncover_metadata` with different `UNCOVER_SESSION`
values. Terminal 2 (pure TypeScript) picks up the changes via the shared
flat files.

## What's *not* in uncover-aoagents

`uncover-aoagents` keeps the harness kernel. It deliberately omits:

- **Agent runtimes** — upstream has [`agent-claude-code`](https://github.com/ComposioHQ/agent-orchestrator/tree/main/packages/plugins/agent-claude-code), `agent-codex`, `agent-aider`, `agent-cursor`, `agent-opencode` plugins. `uncover` lets you export the env and run the agent yourself.
- **tmux runtime** — upstream can spawn each agent in its own tmux window (`runtime-tmux`). `uncover` just prints the `cd` + `export` block.
- **SCM pollers** — upstream has `scm-github` / `scm-gitlab` plugins that poll for CI status, merge conflicts, and review state. `uncover` stops at "observe PR creation."
- **CI fingerprinting** — upstream has a beautiful trick in `lifecycle-manager.ts` where it hashes CI failure output and suppresses re-dispatching the same fingerprint. Worth reading. Not in `uncover`.
- **The dashboard, notifier plugins (Slack/Discord/Desktop), tracker plugins (Linear/Github/GitLab), and the web UI.**

Read the upstream repo for the full thing. `uncover-aoagents` is the single-sitting explainer.

## File index

| File | LOC | What it is |
|---|---|---|
| [`src/types.ts`](src/types.ts) | 47 | Session + spawn config types |
| [`src/metadata.ts`](src/metadata.ts) | 121 | Atomic key=value store |
| [`src/worktree.ts`](src/worktree.ts) | 164 | Git worktree spawner with 3-deep base-ref fallback |
| [`src/shims.ts`](src/shims.ts) | 305 | PATH shim installer + embedded bash wrappers (the hero) |
| [`src/index.ts`](src/index.ts) | 256 | CLI glue: `spawn`, `list`, `watch`, `destroy` |
| **Total** | **~893** | (≈ 420 LOC excluding comments and embedded bash) |

## Credits

- [@aoagents](https://x.com/aoagents) / [ComposioHQ](https://github.com/ComposioHQ) for agent-orchestrator. Every single trick in this repo is theirs — `uncover-aoagents` just lifts them out of the monorepo so they're legible.
- [shlokkhemani/OpenPoke](https://github.com/shlokkhemani/OpenPoke) for the reverse-engineering-as-explainer format that made this kind of post a thing.

MIT.
