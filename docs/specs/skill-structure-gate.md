# Skill snapshot structure gate

## Behavior

`install-user.mjs` refuses a structurally invalid skill snapshot before it writes to the target home.
The gate checks every skill directory that `collectSkillDirs` finds under `user/`.
This includes `skills/` and `managed-skills/` at any supported snapshot location.

`lib/data.mjs` exports `skillProblems(label, text)` beside `ruleProblems`.
The helper returns a list of problem strings.
An empty list means that the text passes the structural gate.

Each skill directory must contain `SKILL.md`.
The file must start with a `---` frontmatter line at byte 0.
The frontmatter must end with a complete `---` line.
LF and CRLF line endings pass.
Text before the first marker, including a BOM, does not pass.

The frontmatter must contain these fields:

- `name` must contain a non-empty value that matches `^[a-z0-9][a-z0-9-]*$`.
- `description` must contain non-empty text.

Plain and quoted values pass.
The gate checks decoded quoted values.
An invalid or unsupported escape does not pass as literal text.

A description can use the existing literal or folded block scalar forms.
Indented scalar text also passes, including a quoted description on the lines after its key.
A blank value, an empty quoted value, or a comment-only value does not supply text.
Extra metadata fields do not cause a refusal.
The helper checks required fields only inside the frontmatter.

The helper applies the existing hidden-character policy through `ruleProblems` with `frontmatter: false`.
The existing emoji exceptions stay unchanged.
The gate reports all structural problems across all skill directories in one refusal.
A missing or unreadable `SKILL.md` causes a refusal that names the path.
Problem messages do not print skill content or field values.

The structural gate runs for each install, even when SkillSpector has a cached pass.
It runs before the scanner, file writes, file deletions, manifest updates, or layer creation.
The SkillSpector gate, its pin, its cache, and its layer scan stay unchanged.

## Boundaries and assumptions

This task checks the source snapshot bytes.
It does not change the rules for local edits, conflicts, or layer state.
The two fields are required fields, not an exclusive field list.
The requested ASCII name pattern defines this gate.
The gate does not add name-length limits, directory-name equality, or further hyphen rules.
This task does not add a YAML parser or change dashboard description extraction.

The format reference is the [Agent Skills specification](https://agentskills.io/specification.md).
This gate implements the requested minimum, not every constraint in that specification.
No text from `anthropics/skills` enters this repository.

## Acceptance checks

- A missing `SKILL.md` refuses the whole install.
- Missing frontmatter, a marker after byte 0, and an invalid closing marker refuse the install.
- A missing or empty `name` refuses the install.
- Invalid name characters refuse the install.
- A missing or empty `description` refuses the install.
- A forbidden hidden character refuses the install.
- A refusal lists every invalid skill and leaves the target home unchanged.
- Valid demo, managed, and agents skill snapshots pass.
- Quoted metadata, supported block descriptions, extra metadata, LF, and CRLF pass.
- An escaped invalid name or an escaped blank description refuses the install.
- Fixed-seed properties check accepted names, invalid name characters, prefixes, and hidden characters.
- `node install-user.test.mjs` passes.
- The full verified chain in `AGENTS.md` passes.
- `server.test.mjs` preserves the existing `GET /api/state` inventory behavior.
- An install smoke run refuses the malformed skill that passed before this change.

## Non-goals

- No new dependency.
- No skill imports or vendored third-party text.
- No changes to the capture format, inventory API, dashboard, or SkillSpector policy.
- No worker packages, document conversion tools, or broader skill lint rules.
