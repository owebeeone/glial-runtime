# Release Process

## Glial release preparation

Scope: prepare only `owebeeone/glial-runtime`, published as `@owebeeone/glial`.
The historical `owebeeone/glial` development workspace is reference-only.
Dependency repositories and Chop Stitch are reference-only in this task.
The user authorized publishing the first runtime release, `0.1.0`, after the
bootstrap package and trusted publisher were established. Release changes are
limited to this repository and the GWZ root checkpoint; consumer migration
remains separate.

All runtime dependencies are published registry
packages: Glade declarations `^0.1.1`, Taut Shape `^0.9.1`, and the GRIP Core
peer `^0.3.0`. No Glade server or Python/Rust package release is required.

### Validation

Use Node 24 and pnpm 10.24.0. `pnpm check:release` performs a frozen install,
typechecking, the complete test suite, a build and pack, and runtime plus
strict declaration checks from an isolated consumer for every public entry
point. It fetches exact commits from `scripts/release-fixtures.json` into a
temporary workspace; these Glade, Taut, and Taut Shape repositories are test
fixtures only. It never modifies sibling repositories. Gearu and CI invoke
the same checker. `pnpm pack` is required to apply the distribution exports.

### First publication and trusted publishing

The prepared workflow is `.github/workflows/publish.yml` in
`owebeeone/glial-runtime`. It uses Node 24, a current npm CLI, and OIDC
(`id-token: write`). The npm trusted-publisher connection has now been saved, following explicit
user approval and security-key authentication. Its first successful automated publication validates the connection; verify
the current status in npm after the workflow completes.

The user-authorized bootstrap `@owebeeone/glial@0.0.0-bootstrap.0` is live.
It contains only a placeholder README, license, and package metadata, with no
runtime implementation. It was published from an isolated temporary directory
using the user's npm session as a bootstrap exception; regular releases use
Gearu and the workflow. At bootstrap creation npm pointed both `bootstrap` and `latest` at the
placeholder. The runtime publication replaces `latest`; retain `bootstrap`
only as historical setup metadata.

Saved publisher: owner `owebeeone`, repository `glial-runtime`, workflow
`publish.yml`, no environment name, direct publishing and staging allowed,
no separate dist-tag management permission. npm requires its first automated
publication before **19 October 2026 at 15:06 UTC** (**20 October at 2:06 am
Sydney time**) to validate this connection. Commit and push the workflow before creating the GitHub Release. No runtime
version, release tag, or GitHub Release was created by the bootstrap setup.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

After the setup is committed and release authorization is given, inspect
`gearu plan 0.1.0`, then follow the generated process below. In a GWZ workspace,
use workspace-wide GWZ staging, commits, and a single `gwz push`; the generic
member-only push examples below do not override the workspace policy. Push
an immutable release tag and create its GitHub Release only when authorized.

### Consumer follow-up outside this task

Chop Stitch currently depends on and imports `@owebeeone/glial-runtime`.
Its package manifest, workspace override, source import, and regenerated lock
need migration to `@owebeeone/glial` together. A fresh workspace install will
fail to resolve the old `workspace:*` name after this package rename. This is
a confirmed consumer integration requirement, not a blocker to packaging Glial
independently. Those consumer files remain unchanged and require a separately
scoped follow-up before adopting this rename in the app.

GAP-11 (documented in `dev-docs/DecisionLog.md`) remains: locally minted offline
ops do not ship on later attach. An offline outbox is separate feature work;
it is not implemented or claimed by this packaging release.

<!-- gearu:release:start -->
## Gearu Release Process

Gearu prepares and verifies the repository, creates an immutable tag, and can
create the GitHub Release that starts this repository's publication workflow.
It does not publish directly to package registries.

Full documentation: <https://owebeeone.github.io/gearu/>

### Install

Install the released tool with:

```sh
uv tool install gearu
```

Upgrade an existing installation with:

```sh
uv tool upgrade gearu
```

To test the unreleased `main` branch, install it directly from its repository:

```sh
uv tool install git+https://github.com/owebeeone/gearu.git
```

Verify the installation with `gearu --version`.

### Preconditions

- Read `gearu.toml` and this repository's release workflow.
- Choose an explicit release version or an explicit major, minor, or patch bump.
  Gearu does not infer release intent from commits.
- Use a clean checkout on the branch configured by `project.branch`.
- Synchronize configured release and source branches with their remote.
- Release required cross-repository dependencies first.
- Install and authenticate `gh` before requesting GitHub Release creation.

### Plan

Always inspect the read-only plan first:

```sh
gearu plan VERSION
```

Or ask Gearu to select the next version:

```sh
gearu plan --bump patch
gearu plan --bump minor
gearu plan --bump major
```

Gearu compares configured package versions with valid local and remote release
tags, then bumps the highest version. It reads remote tags directly and does not
fetch or create local tags while planning.

For a release candidate, use a numbered version such as `1.2.3-rc.1`.

Override a configured dependency tag only when the release intentionally uses a
different version:

```sh
gearu plan VERSION --dependency-tag DEPENDENCY=TAG
```

### Prepare the Local Release

After reviewing the plan:

```sh
gearu release VERSION
```

The release command can select the version itself:

```sh
gearu release --bump minor
```

This recalculates the next version at release time. To lock the version reviewed
in a prior bump plan, pass that plan's reported `VERSION` explicitly.

Gearu builds and tests in a temporary worktree. Only a successful candidate is
applied to the local release branch and tagged. This step does not change a
remote repository.

### Push and Create the GitHub Release

Push the exact release commit and tag atomically:

```sh
gearu release VERSION --push
```

Create the GitHub Release after that push:

```sh
gearu release VERSION --push --github-release
```

The final command starts workflows listening for `release.published`, including
package publication and documentation deployment where configured.

### Recovery

- If candidate checks fail, fix the problem and rerun; the normal checkout is
  left unchanged.
- If local preparation succeeds, rerun the same version with `--push`.
- If the push succeeds but GitHub Release creation fails, rerun with
  `--push --github-release`.
- If released contents must change, use a new patch or release-candidate version.
  Never move or replace the existing tag.
- If only a publication workflow fails, repair and rerun that workflow for the
  same GitHub Release.
<!-- gearu:release:end -->
