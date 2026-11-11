// Ottr's shipped skills, vendored into alate at one pinned upstream commit. Ottr ships four
// agent skills in its own checkout (.agents/skills in github.com/ottr-ai/ottr) and the board
// requires them, but omp only loads .agents/skills for runs inside the Ottr checkout itself,
// so provisioned worker homes lack them unless the data repo carries copies. install-user
// installs the vendored copies into every home it provisions; a data repo skill of the same
// name wins and the shipped copy is skipped (README, section "Skills alate ships").
//
// The tree below mirrors the upstream repo layout (shipped/ottr/<path>), so re-pinning is a
// byte-for-byte copy of the four folders at the new commit plus this file's commit bump. The
// bytes must stay exactly the upstream commit's bytes: SkillSpector baselines fingerprint the
// upstream LF bytes, and the update checker offers the pinned commit as the row's current.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const SHIPPED_TREE = 'shipped/ottr';

export const SHIPPED_PIN = {
  repo: 'ottr-ai/ottr',
  source: 'https://github.com/ottr-ai/ottr',
  commit: 'affd848b7e02c08339561c7282957e2a5fc9c201',
  skills: [
    { name: 'check-ottr-board', path: '.agents/skills/check-ottr-board' },
    { name: 'diff-security-review', path: '.agents/skills/diff-security-review' },
    { name: 'explain-project', path: '.agents/skills/explain-project' },
    { name: 'ui-ux-check', path: '.agents/skills/ui-ux-check' },
  ],
};

// The vendored folder of one pinned skill inside the tool checkout; the pin's path mirrors
// the upstream repo path under SHIPPED_TREE. Returns null for a pin whose folder is absent
// (a broken vendor), so the caller reports that one skill and never fabricates a source.
export function shippedSkillDir(toolRoot, pin) {
  const dir = join(toolRoot, SHIPPED_TREE, pin.path);
  return existsSync(dir) ? dir : null;
}
