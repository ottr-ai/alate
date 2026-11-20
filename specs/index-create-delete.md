# Index create and delete: rules, skills, projects

Status: draft. Decided in the live session of 2026-11-20 (grilling rounds 1 to 3).

## Problem

The dashboard index lists every file of the data repo, but only the "New file" link
creates a file, and only one file at a time. A new skill also needs an origin entry
in `upstreams.json`, and a new project needs a key in `projects/projects.json`. A
delete removes one file; a skill or a project is a folder plus references.

## Behavior

### Create

- The index groups Rules, Skills and Projects get a **+** button on their group row,
  beside the file count. The bundles folder keeps its own **+** (bundle create).
- **+** opens an inline name field. The name must match `[a-z0-9][a-z0-9-]*`. For a
  skill in bundles mode, the row also has an optional bundle picker; its default is
  "Not in any bundle".
- Enter opens the editor on the new main file with a template, as an unsaved draft.
  Nothing is written until the user presses **Commit and push**. Escape closes the
  name field.
  - Rule: `<name>.md` at the repo root. Template: a `description:` frontmatter line
    and a `# <name>` heading.
  - Skill: `user/omp/agent/skills/<name>/SKILL.md`. Template: `name:` and
    `description:` frontmatter and a `# <name>` heading.
  - Project: `projects/<name>/AGENTS.md`. Template: a `# <name>` heading.
- The commit of the draft is one save (one commit, one push) through
  `POST /api/entry` with `{ action: 'create', kind, name, content, bundle?, message? }`:
  - Rule: writes `<name>.md`. It adds `<name>.md` to `own` in `upstreams.json` only
    when no `own` pattern and no item `paths` pattern covers it already.
  - Skill: writes `SKILL.md` and appends the exact folder path
    `user/omp/agent/skills/<name>` to `own`. With a bundle, it appends the name to
    `bundles/<bundle>/skills.txt` in the same save.
  - Project: writes `projects/<name>/AGENTS.md` and adds the key `<name>` with
    `{ "extras": [], "bundles": [] }` to `projects/projects.json`.
- A new project gets no bundles at create. The project card offers "Add bundle".

### Delete

- A file view inside a skill folder or a project folder offers **Delete skill** or
  **Delete project** beside **Delete file**. The index has no delete control.
- A folder view (`#/folder/<path>`) opens when the user clicks a skill or project
  folder row in the index. It lists the folder's files and offers the same delete.
- The delete asks for a confirm that lists every file and every reference it removes.
- The delete is one save through `POST /api/entry` with
  `{ action: 'delete', kind, name }`:
  - Skill: every stored file of the skill folder, the exact folder path in `own`,
    the folder path in each item's `paths` (an item with no path left is removed),
    and the name in every `bundles/*/skills.txt`.
  - Project: every stored file under `projects/<name>/` and the key in
    `projects/projects.json`.
- The delete never touches the workspace checkout of a project or the home.

### Kept

- The "New file" link stays for free paths (User layer, Repository).
- The Overview has no create controls. The "Create bundle" form on the Overview goes;
  the bundles **+** in the index is the one way to create a bundle.

## Boundaries and error cases

- An existing target refuses with 409: a rule file, a skill name that any skill root
  holds, a project key, or a stored file under the project folder.
- An unknown bundle refuses with 400 and writes nothing.
- A missing or unparseable `projects/projects.json` refuses a project create with 400.
- A missing `upstreams.json` is created with `{ "own": [...] }` for a skill or rule.
- A delete of an unknown skill or project refuses with 404.
- Every op checks the stored hash of the file it changes (the editor's base rule), so
  a concurrent change refuses with 409 and writes nothing new.
- A skill in `user/agents/skills/` is deleted with its folder; its `.skill-lock.json`
  entry stays (limit: alate does not edit the lock file).

## Acceptance checks

1. A skill create with a bundle writes `SKILL.md`, the `own` path and the bundle line
   in one commit.
2. A rule create adds no `own` entry when `*.md` is in `own`, and adds `<name>.md`
   when nothing covers it.
3. A project create writes `AGENTS.md` and the `projects.json` key in one commit; a
   second create of the same name refuses with 409.
4. A skill delete removes every file, the `own` path, the item path, and the bundle
   lines in one commit.
5. A project delete removes the folder and the key in one commit.
6. In the browser: **+** on Skills, a name, Enter, the editor shows the template, and
   Commit creates the skill; the new skill shows in its bundle.

## Non-goals

- Plugins get no **+**: adding one is an npm install, not a file.
- No create for the User layer; it keeps "New file".
- No rename.
