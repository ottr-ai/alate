---
name: interrogate
description: Adversarial review of a diff or a design. Several reviewer agents try to break the change; a finding survives only when a run proves it with a command and its output, and a finding without a repro is dropped. Use as the review's adversarial pass, or when asked to interrogate, stress-test, or find blind spots in a diff. Read-only for the code; outputs a findings report, never applies fixes.
---

# Interrogate

Adversaries try to break a change or a design. A finding survives only when a run
proves it with a command and its output. A finding without a repro is dropped and
never files a card. Report the findings; do not apply fixes.

> Ported from [cursor/plugins `pstack/skills/interrogate`](https://github.com/cursor/plugins/blob/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills/interrogate/SKILL.md)
> at commit `4dd1d05818d19792e7cd6e818f1667f95f7e1dbe` (MIT — license text at the
> bottom). Local edits for omp: the Cursor `Task` tool with `subagent_type` becomes
> the omp `task` tool (adversaries are `reviewer` agents, read-only evidence is a
> `scout` agent, approved fixes go to `task` agents; each batch runs in one message),
> the pstack `arena` phase routing and model routing are gone, the
> `in-your-own-words` intent restatement is inline, repro scripts go to the system
> temp directory instead of a worktree, and a dropped finding files no tracker card.

## Frame

The scope is what the user names. Otherwise it is the branch diff from its merge
base with the base branch, through the working tree. State the intent in one short
paragraph from the user's message, the commits, and the PR description. Ask the user
when the intent is unclear.

When the code under the scope is unfamiliar, spawn one `scout` agent first (read
only) and give its module map to each adversary. Collect its result before you fan
out; the adversaries need it in their prompts.

## Fan out

Spawn the adversaries in one message, as parallel `task` calls with agent type
`reviewer`. Use three adversaries; use four for a diff larger than 500 lines. Give
each adversary the scope, the intent, and this brief:

> Break this change. Prove each finding with a run against the real code, such as a
> failing test, a repro script, or command output that shows the wrong behavior. For
> a design or plan, run a prototype or probe the current tree. Keep repro scripts in
> the system temp directory; never write to the repository. Report each finding with
> a title, the exact command, the output it printed, and the output the intent
> requires. Leave out anything you did not run. That covers style, naming,
> structure, and risks that need a future change to matter. No findings is a valid
> result.

If an adversary produces no result, continue with the rest and note the dropout.

## Verify

Rerun each finding's command yourself. Keep a finding only when the rerun prints the
failure and the failure breaks the intent. Adversaries find different failures, so
the result keeps every verified finding, not one adversary's list. Merge findings
that share a root cause. For each dropped finding, give the reason. A dropped
finding is dead: never file it as a tracker card.

## Fixes

This skill never applies fixes. When the user approves a fix, dispatch it as
separate work to a `task` agent, one finding per task.

## Output

- **Intent**: the restatement.
- **Findings**: for each verified finding, the command, its output, how it breaks
  the intent, and the adversaries that found it. Say "no verified findings" when
  none survive.
- **Dropped**: for each adversary, the count of dropped findings and why.

## License

MIT License — this file ports `pstack/skills/interrogate/SKILL.md` from
[cursor/plugins](https://github.com/cursor/plugins) at commit
`4dd1d05818d19792e7cd6e818f1667f95f7e1dbe`.

Copyright (c) 2026 Lauren Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
