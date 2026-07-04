# auto-pr

A GitHub Action that keeps an **always-open release pull request** from a
staging branch (`dev`) to a production branch (`master`), so the release PR is
a living changelog of everything that has not been deployed yet. Merging it is
the (human-driven) deploy.

## How it works

Every push to `dev` (i.e. every PR that lands there):

1. **Collects pending changes** — compares `master...dev` and resolves every
   commit ahead of `master` to the merged PR that introduced it. Commits pushed
   directly to `dev` without a PR are listed too.
2. **Upserts the release PR** —
   - If no open `dev → master` PR exists, one is created. Its title is the
     previously released version with the **minor bumped** (configurable via
     the `bump` input; `v0.1.0` if there is no previous release), and its body
     contains the changelog.
   - If one is already open, only the changelog section of its body is
     rewritten. The title is **never touched after creation**.

### Versioning rules

- The version source of truth is the title of the most recently **merged**
  `dev → master` PR.
- New release PRs bump the **minor** of that version automatically (set the
  `bump` input to `major`, `minor`, or `patch` to change this).
- Humans own the title after creation: rename the open release PR to `v2.0.0`
  and it stays `v2.0.0`; once merged, the next release PR will be `v2.1.0`.
- Merged release PRs with unparseable titles are skipped (with a warning) and
  the search continues into older releases.

### Body rules

The changelog lives between two markers in the PR body:

```markdown
<!-- auto-pr:begin -->
### Changes since last deploy

- #12 Add user login (@bruno)
- #14 Fix cart total rounding (@bruno)

_2 pull requests · last updated from push to `dev`_
<!-- auto-pr:end -->
```

Anything you write **outside** the markers (release notes, checklists,
warnings) is preserved across updates. If you delete the markers, the
changelog section is re-appended at the end.

> [!IMPORTANT]
> Merge the release PR with a **merge commit** (not squash), so that `master`
> ends up containing `dev`'s commits. Squash-merging would leave the two
> branches permanently diverged and already-deployed PRs would keep showing up
> in the next changelog.

## Usage

```yaml
name: Release PR

on:
  push:
    branches: [dev]
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: release-pr
  cancel-in-progress: false

jobs:
  release-pr:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: BrunoPanizzi/auto-pr@master
```

This repository dogfoods the action with `uses: ./` in
[`.github/workflows/release-pr.yml`](.github/workflows/release-pr.yml).

> [!NOTE]
> For the default `GITHUB_TOKEN` to be allowed to open PRs, enable
> **Settings → Actions → General → Allow GitHub Actions to create and approve
> pull requests** on the repository.

### Inputs

| Input             | Default               | Description                                             |
| ----------------- | --------------------- | ------------------------------------------------------- |
| `github-token`    | `${{ github.token }}` | Token used for the API calls (`pull-requests: write`).  |
| `base`            | `master`              | Production branch the release PR targets.               |
| `head`            | `dev`                 | Staging branch the release PR comes from.               |
| `initial-version` | `v0.1.0`              | Version of the very first release PR.                   |
| `bump`            | `minor`               | Component bumped for new release PRs (`major`, `minor`, `patch`). |

### Outputs

| Output      | Description                                                        |
| ----------- | ------------------------------------------------------------------ |
| `pr-number` | Number of the open release PR (empty if there was nothing to do).  |
| `pr-url`    | URL of the open release PR.                                        |
| `version`   | Current title of the release PR, human edits included.             |
| `created`   | `true` if this run created the PR, `false` if it updated one.      |

## Development

The logic lives in [`src/release-pr.js`](src/release-pr.js) and is executed by
`actions/github-script` from the composite action in
[`action.yml`](action.yml). Pure functions (version parsing/bumping, changelog
rendering, body splicing) are unit-tested:

```sh
node --test
```
