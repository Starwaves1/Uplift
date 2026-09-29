# Paused agent threads (2026-09-27, ~02:00)

All agents from the lead session were paused. Each one's work is in its own folder under
`C:\Users\garre\Documents\code\uplift\.claude\worktrees\agent-<id>` (branch `worktree-agent-<id>`): commits plus any
uncommitted edits, untouched. Each `NN-*.md` file here holds that agent's original brief, the latest feedback it got,
its latest reports, and its last 30 messages, plus the path to its full transcript.

The full transcripts are in
`C:\Users\garre\.claude\projects\C--Users-garre-Documents-code-uplift\d86a6a2a-7487-4555-ae9a-919b0a1b4037\subagents\agent-<id>.jsonl`.
They are sub-conversations of the lead session, so `claude --resume` and T3 Code won't list them on their own.

| Ticket | Folder (agent id) | Commits / uncommitted | Review | Where it was |
|---|---|---|---|---|
| 02 glacial fjords | a40c8c9180f3faab1 | 2 / 3 | `islands/fjord1` on 8765 | Round 2: climate ELA with a colder glacial state, headwall retreat sweep; fixing comb-regular side valleys, wide mouths, adding tarns |
| 08 valley head | a2a6e140d28af3497 | 1 / 2 | `islands/v8head` on 8765 | Not approved by Garrett; was only diagnosing causes (rings, flat floor, corrugation, domes) as input for the regeneration |
| 16 GPU detail | af2be8e7df867cae1 | 6 / 0 | 8770 | Done, waiting for Garrett's review; lead's concern: far slopes look combed |
| 17 rock structure | a6e4a8428d700d309 | 2 / 1 | `islands/rock1`, `rock2` | Round 2 committed; its 2048² run was cut off by the pause; rerun it |
| 19 river water | aa9a1c41975ab1fca | 11 / 2 | 8771 | Lake shores and far water done; was on the brook and the river-into-lake join |
| 20 baked light | ab757c1b3abb0f299 | 2 / 3 | 8780 | Not approved (cell patches, smudges, green bands); was fixing and self-checking |
| 21 landmark footings → 12 | a28852eb0a8abbeac | 3 / 6 | 8773 (not running) | Was writing a Node audit of placements across the island |
| 23 clouds and weather | a87d73b3b15dce631 | 0 / 5 | 8774 (not running) | Was writing the high cloud layer shader; nothing committed yet |
| 27 pause Esc | a1f80725b304da96e | 0 / 1 | — | Stopped earlier (suspected of grabbing the mouse); restart fresh, headless only |
| 28 climate fields | adc9bc8b3d9d35267 | 1 / 2 | `islands/` on 8765 | Was making the side-by-side sheet of calibration variants (obl_w view) |
| 31 topsoil and sediments | aa93365d0022c8466 | 0 / 8 | — | Was about to send its first checkpoint; nothing committed yet |
| 33 headless tool | a894e21c8ed7cdb12 | 1 / 0 | — | Done and verified by the lead; waiting for Garrett's merge OK |

Other sessions (real sessions, resumable with `claude --resume <id>` from the repo folder):
- Lead: `d86a6a2a-7487-4555-ae9a-919b0a1b4037.jsonl` (very long; the handoff note
  `C:\Users\garre\AppData\Local\Temp\windborne-handoff-2026-09-27.md` is the better starting point).
- Materials session: `94708356-73b7-4bc7-bea4-605223206ab7.jsonl`, still open in Claude Desktop.

## Opener for a new thread on an agent's folder

Old briefs told agents to test in the built-in browser. That's now forbidden, so the rules are repeated here.

```
You're continuing ticket NN for Windborne, in this folder (your own git worktree). You were paused mid-work.
Read, in order:
1. C:\Users\garre\Documents\code\uplift\.scratch\island-terrain\threads\NN-*.md — your brief, my feedback, your last messages.
2. The ticket in .scratch/island-terrain/issues/, CLAUDE.md, and `git log main..HEAD` and `git status` here.
Then tell me in a few lines where you were and what you'll do next, and wait for my go.
Rules: Opus only. Test headlessly only, with tools/headless.py (merged to main; merge main into your branch to get it).
Never the browser pane, never pointer lock, never my mouse. Test builds stay muted. One heavy job (generator run,
big render) at a time on this machine: launch every one through the `heavy` queue (below). Check your own work from
many viewpoints before showing me. No merge to main without my approval.
```

## Heavy-job queue (added 2026-09-27 04:50)

Every generator, glacier, finalize, export or bake run at 1024² or larger goes through the WSL `heavy` wrapper. It
waits its turn on a machine-wide lock, so jobs run one at a time without anyone having to watch the others:

```
wsl -d Ubuntu-26.04 -e heavy bash -c 'cd /mnt/c/.../island && bash run.sh gen_island.py 2048 300 k24 && ...'
```

Wrap the whole chain in one `heavy` call, not each step, so nobody jumps in between your stages. From Git Bash, prefix
`MSYS_NO_PATHCONV=1`. A queued job prints `[heavy] … queued`; just wait for it. For GPU timing (`headless.py bench`),
first check the machine is quiet with `wsl -d Ubuntu-26.04 -e flock -n /tmp/uplift-heavy.lock true` (exit 0 = free).
Small tests (512² and below, 4 km crops) don't need the queue.

## Shared-code notes

- Texture units: main's `wind/core.js` keeps the owner list. 22 is the baked sky light (ticket 20); take the next free one (23+).
- Merge order for the generator tickets: 28 (climate) first, then 17 (rock), then 31 (soil). Before merging, merge
  current main into your branch and re-run your checks. One merge into main at a time.
