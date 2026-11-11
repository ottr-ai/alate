---
name: blast-radius
description: Find what a change could break somewhere else before it ships, beyond the diff, and prove the one fact the change is safe because of by running real code. Use for 'blast radius of X', 'what could this break', a diff you do not trust, or the merge turn's diff check.
---

# Blast radius

> Ported from [cursor/plugins](https://github.com/cursor/plugins/tree/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack/skills/blast-radius)
> (`pstack/skills/blast-radius/SKILL.md` at commit `4dd1d05818d19792e7cd6e818f1667f95f7e1dbe`,
> 2026-10-29, MIT — license text at the bottom). Local edits for omp: pstack's `why`
> cross-references became omp memory (`xd://recall`) and the global rules, pstack `arena` became the
> `interrogate` skill, the `unslop` step is dropped, and the one safety fact must reach ladder step 4
> ('a script ran') — upstream asks only for best effort.

Find what a change breaks somewhere else, before it ships. Use for 'blast radius of X', 'what could
this break', or a diff you do not trust yet.

Listing the callers is not the job. `ripwire --impact` and grep list them in seconds. The job is the
breakage that grep does not show.

## Do not trust your own writeup

A blast-radius writeup that sounds right is worthless. It reads as convincing whether or not it is
true. Do not hand back the writeup alone. Find the one or two facts the whole thing depends on and
prove them by running code.

### The proof ladder

For each fact the change's safety depends on, get it as far down this ladder as you can, and say where
it stopped:

1. You said so. Worthless on its own.
2. You pointed at the line. A real `file:line`, or the library's own source.
3. You showed the bad case cannot happen. You walked the failure step by step and it does not reach it.
4. You ran it. A script or test that calls the real code and fails loud if you are wrong.
5. You reproduced it in the running app.

Step 4 is usually one small script that imports the same module the app ships and calls the exact
function you worry about.

**Rule: the one fact the change is safe because of must reach at least step 4.** Below step 4 the
change is unproven: say so in the report, and do not call the change safe.

## Steps

1. Read the change. The diff, the symbols it adds, changes, and deletes, and what it now does
   differently, including the part the diff does not spell out. `git log` and `git show` on the branch
   give the history; omp memory (`xd://recall`) and the project rules hold why the code is shaped the
   way it is.
2. Find the one fact it is safe because of. Most changes that look risky are safe because of a single
   fact, like 'this call only drops already-dead cache entries and does nothing else'. Find that fact.
   If it holds, most risky cases are cleared at once. Spend your time here, not on a long list of
   maybes.
3. Look where grep stops. Read the source of the library you call, and check its pinned version and
   any local patch. Work out when things run: microtasks, unmount and teardown, framework lifecycle.
   Follow what a symbol search misses: the JSON an API returns, a DB column, a wire format, another
   language reading the same bytes, a feature flag, code three hops downstream.
4. Be honest about each risk. Give it a real chance of happening and a real cost if it does. Keep the
   risks you confirmed. List the ones you checked and cleared separately. Ground every claim in the
   global rules: never fabricate output. Cite a real `file:line`. A search that finds nothing is still
   an answer, and never make up a caller or an API.
5. Prove the one fact. Write a script or test that runs the real code, run it, and paste what
   happened. Record the command and its output.
6. For a big or wide change, also run the `interrogate` skill: several reviewers try to break the
   diff, and a finding stays only when a run proves it with a command and its output.

## What to hand back

- **What it does.** What changed, including the part that is not obvious.
- **The one fact it is safe because of.** State it, say which ladder step you got it to, and show the
  proof: the command and its output. If you could not prove it, write unproven.
- **Risks.** Each names how it breaks, the `file:line`, how likely and how bad, and how to check.
  Paste the proof for the ones that matter.
- **Cleared.** What you checked and why it is fine.
- **Before you merge.** The cheapest test or repro that catches the real bug, including the script you
  wrote.

Strip anything private before the writeup goes anywhere public.

**Reply:** the writeup above, with the one safety fact either proven or marked unproven.

---

## License

MIT License — this file ports `pstack/skills/blast-radius/SKILL.md` from
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
