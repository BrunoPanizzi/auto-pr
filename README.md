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

### Grouping by title prefix

Teams that prefix PR titles with a project acronym ("OTF - Adiciona módulo de
eventos") can pass a mapping via the `groups` input to get the changelog
grouped by project, with full names as headings:

```yaml
- uses: BrunoPanizzi/auto-pr@master
  with:
    groups: |
      OTF: Operação Terra Forte
      INFRA: Infraestrutura
    ungrouped-label: Outros
```

```markdown
#### Operação Terra Forte
- #12 Adiciona módulo de eventos (@bruno)

#### Infraestrutura
- #14 Atualiza pipeline (@bruno)

#### Outros
- #15 Fix typo (@bruno)
```

Grouping rules:

- The prefix is the acronym before the first dash; it is stripped from the
  entry since the group heading already says which project it is. Known
  acronyms match case-insensitively.
- All-caps prefixes that are **not** in the mapping still get their own group,
  under the raw acronym, so PRs from a new project are not lost while the
  mapping catches up.
- PRs without a recognizable prefix land in a final group named by
  `ungrouped-label` (default `Other`).
- Groups appear in the order of the mapping, then unknown acronyms
  alphabetically, then the ungrouped bucket.
- When `groups` is empty (the default), the changelog is a flat list.

### Customer-facing changelog

PR titles are written for developers; customers deserve better. Authors can
write customer-facing notes in the PR body, between changelog markers:

```markdown
<!-- changelog:begin -->
- Relatórios agora podem ser exportados em PDF.
<!-- changelog:end -->
```

The action collects these notes into a second section of the release PR body
(heading configurable via `customer-heading`), grouped by project like the
dev changelog but rendered **clean** — no PR numbers, no authors — so each
project block can be copied and sent to a client as-is:

```markdown
### Novidades

#### Operação Terra Forte
- Relatórios agora podem ser exportados em PDF.
```

Rules:

- The **PR body is the source of truth**: to fix awkward copy, edit the PR's
  changelog section (even after merge) and the release PR re-renders on the
  next push to `dev` (or a manual `workflow_dispatch` run).
- Write `interno` (or `skip`) between the markers — or leave them empty or
  deleted — and the PR stays out of the customer section. It is always still
  listed in the dev changelog.
- Multiple bullets per PR are fine; plain lines are turned into bullets.
- The template's instruction comment doesn't count as content, so untouched
  templates are treated as "no notes".

#### Getting the markers into a PR

Three ways, from most to least convenient:

1. **The `/novidades` comment command** (the `novidades/` action, below):
   comment on the PR and the section is written into the body for you.
2. **The optional PR template**
   ([`.github/PULL_REQUEST_TEMPLATE/novidades.md`](.github/PULL_REQUEST_TEMPLATE/novidades.md)):
   append `?template=novidades.md` to the compare URL when opening a PR.
3. **Manually**: copy the markers into the body.

> [!NOTE]
> GitHub's native `/template` slash command (public preview) only inserts the
> *default* `PULL_REQUEST_TEMPLATE.md` — named templates never appear in it,
> and there is no template picker UI for PRs. That gap is exactly why the
> comment command exists. Make the template the default (rename it to
> `.github/PULL_REQUEST_TEMPLATE.md`) if you'd rather have the markers
> pre-filled into every PR.

### The `/novidades` comment command

Comment on any PR and the `novidades/` action writes the changelog section
into the PR body (and reacts 🚀 to acknowledge):

- `/novidades Relatórios agora exportam PDF` — creates the section with that
  note (under a visible `## Novidades 🎉` heading, configurable via the
  `heading` input), or replaces the current section content without touching
  its surroundings. Multiline comments work; lines are bulleted automatically.
- `/novidades interno` — marks the PR as internal.
- `/novidades` (bare) — inserts the empty template section for later editing;
  no-op if the markers already exist.

The comment must *start* with the command. Editing the PR body directly is
always possible too — the command is sugar over the same markers.

```yaml
name: Novidades Command

on:
  issue_comment:
    types: [created]

permissions:
  pull-requests: write
  issues: write

jobs:
  novidades:
    if: github.event.issue.pull_request && startsWith(github.event.comment.body, '/novidades')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: BrunoPanizzi/auto-pr/novidades@master
```

> [!NOTE]
> `issue_comment` workflows only run from the workflow file on the
> **default branch**, and anyone who can comment can trigger the command —
> fine for private team repos, but add an author check before using it on a
> public one. The command word is configurable via the `command` input.

### Publishing GitHub Releases

The companion `release/` action freezes the changelog when a release PR
merges: it tags the merge commit with the version from the PR title and
creates a GitHub Release whose body is the changelog block — a permanent,
linkable record of what shipped.

```yaml
name: Publish Release

on:
  pull_request:
    types: [closed]
    branches: [master]
  workflow_dispatch:   # republish the latest release if a run was missed

permissions:
  contents: write

jobs:
  publish:
    if: github.event_name == 'workflow_dispatch' || (github.event.pull_request.merged == true && github.event.pull_request.head.ref == 'dev')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: BrunoPanizzi/auto-pr/release@master
```

Publishing is idempotent (an existing release for the tag is left untouched)
and entirely decoupled from deploys — no artifacts are involved unless you
decide to attach some later.

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
| `groups`          | _(empty)_             | Newline-separated `ACRONYM: Display name` mapping enabling grouped changelogs. |
| `ungrouped-label` | `Other`               | Heading for PRs without a recognizable prefix (only used with `groups`). |
| `customer-heading` | `Customer changelog` | Heading of the customer-facing section built from PR body notes. |

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
