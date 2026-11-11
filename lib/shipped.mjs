// Ottr's shipped skills, vendored into alate at one pinned upstream commit. Ottr ships its
// agent skills in its own checkout (.agents/skills in github.com/ottr-ai/ottr), and that
// tree is the single source: alate vendors the whole tree and installs every skill folder
// in it, so a new Ottr skill needs no alate code change (user decision 2026-11-11). omp
// only loads .agents/skills for runs inside the Ottr checkout itself, so provisioned
// worker homes lack the skills unless the data repo carries copies; install-user installs
// the vendored copies into every home it provisions, and a data repo skill of the same
// name wins, with the shipped copy skipped and logged (README, section "Skills alate
// ships").
//
// The tree below mirrors the upstream repo layout (shipped/ottr/<path>), so re-pinning is
// a byte-for-byte copy of the whole .agents/skills tree at the new commit plus this file's
// commit bump. The bytes must stay exactly the upstream commit's bytes: SkillSpector
// baselines fingerprint the upstream LF bytes, and the update checker offers the pinned
// commit as the row's current.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SHIPPED_TREE = 'shipped/ottr';

export const SHIPPED_SKILLS_DIR = '.agents/skills';

export const SHIPPED_PIN = {
  repo: 'ottr-ai/ottr',
  source: 'https://github.com/ottr-ai/ottr',
  commit: 'affd848b7e02c08339561c7282957e2a5fc9c201',
};

// One entry per skill folder vendored under shipped/ottr/.agents/skills, sorted by name:
// [{ name, path ('.agents/skills/<name>'), dir (absolute path in this tool checkout) }].
// Only directories count; an absent tree enumerates empty, so a broken vendor installs
// nothing and rows nothing instead of crashing a provision.
export function shippedSkills(toolRoot) {
  let entries;
  try {
    entries = readdirSync(join(toolRoot, SHIPPED_TREE, SHIPPED_SKILLS_DIR), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(entry => ({
      name: entry.name,
      path: `${SHIPPED_SKILLS_DIR}/${entry.name}`,
      dir: join(toolRoot, SHIPPED_TREE, SHIPPED_SKILLS_DIR, entry.name),
    }));
}
