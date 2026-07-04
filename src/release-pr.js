'use strict'

// Core logic for the auto-pr release PR action.
//
// Invariants this module maintains:
//  - There is at most one open PR from `head` (staging) to `base` (production).
//  - Its body contains a changelog of every PR merged into `head` that is not
//    yet on `base`, kept between MARKER_BEGIN/MARKER_END so human-written text
//    outside the markers survives updates.
//  - Its title is set exactly once, at creation, to the previous released
//    version with the patch bumped. Human edits to the title are never
//    overwritten; the next release cycle bumps from whatever title was merged.

const MARKER_BEGIN = '<!-- auto-pr:begin -->'
const MARKER_END = '<!-- auto-pr:end -->'

const SEMVER_RE = /v?(\d+)\.(\d+)\.(\d+)/

function parseVersion(text) {
  const m = SEMVER_RE.exec(text || '')
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

function bumpPatch(version) {
  return { major: version.major, minor: version.minor, patch: version.patch + 1 }
}

function formatVersion(version) {
  return `v${version.major}.${version.minor}.${version.patch}`
}

function renderChangelog({ prs, directCommits, head }) {
  const lines = [MARKER_BEGIN, '### Changes since last deploy', '']
  if (prs.length === 0 && directCommits.length === 0) {
    lines.push('_No pending changes detected._')
  }
  for (const pr of prs) {
    lines.push(`- #${pr.number} ${pr.title} (@${pr.author})`)
  }
  if (directCommits.length > 0) {
    lines.push('', 'Commits without a pull request:')
    for (const commit of directCommits) {
      lines.push(`- ${commit.sha.slice(0, 7)} ${commit.message}`)
    }
  }
  const count = `${prs.length} pull request${prs.length === 1 ? '' : 's'}`
  lines.push('', `_${count} · last updated from push to \`${head}\`_`, MARKER_END)
  return lines.join('\n')
}

// Replaces the marker-delimited section of an existing body, appending the
// section if the markers were (re)moved. Everything outside the markers is
// left untouched.
function spliceBody(existingBody, changelog) {
  const body = existingBody || ''
  const begin = body.indexOf(MARKER_BEGIN)
  const end = body.indexOf(MARKER_END)
  if (begin !== -1 && end !== -1 && end >= begin) {
    return body.slice(0, begin) + changelog + body.slice(end + MARKER_END.length)
  }
  return (body ? body.trimEnd() + '\n\n' : '') + changelog
}

function initialBody(changelog, base, head) {
  return [
    '## Pending release',
    '',
    changelog,
    '',
    '> [!IMPORTANT]',
    `> Merge this PR with a **merge commit** so \`${base}\` fully catches up with \`${head}\`.`,
  ].join('\n')
}

// Everything reachable from `head` but not from `base`, resolved to the PRs
// that brought those commits in. Commits with no merged PR into `head` are
// reported separately (direct pushes); merge commits without a PR are skipped
// as noise since their parents are listed individually.
async function collectPendingChanges({ github, owner, repo, base, head }) {
  const commits = []
  for (let page = 1; ; page++) {
    const res = await github.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${base}...${head}`,
      per_page: 100,
      page,
    })
    commits.push(...res.data.commits)
    if (res.data.commits.length < 100 || commits.length >= res.data.total_commits) break
  }

  const prsByNumber = new Map()
  const directCommits = []
  for (const commit of commits) {
    const assoc = await github.rest.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo,
      commit_sha: commit.sha,
    })
    const mergedIntoHead = assoc.data.filter((pr) => pr.merged_at && pr.base.ref === head)
    if (mergedIntoHead.length === 0 && commit.parents.length < 2) {
      directCommits.push({ sha: commit.sha, message: commit.commit.message.split('\n')[0] })
    }
    for (const pr of mergedIntoHead) {
      if (!prsByNumber.has(pr.number)) {
        prsByNumber.set(pr.number, {
          number: pr.number,
          title: pr.title,
          author: pr.user ? pr.user.login : 'unknown',
          mergedAt: pr.merged_at,
        })
      }
    }
  }

  const prs = [...prsByNumber.values()].sort((a, b) => (a.mergedAt < b.mergedAt ? -1 : 1))
  return { prs, directCommits }
}

// The version we bump from: the title of the most recently merged release PR
// (head -> base). Unparseable titles are skipped with a warning so a renamed
// PR can't wedge the whole system.
async function lastReleasedVersion({ github, core, owner, repo, base, head }) {
  const closed = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: 'closed',
    base,
    head: `${owner}:${head}`,
    per_page: 100,
  })
  const merged = closed
    .filter((pr) => pr.merged_at)
    .sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1))
  for (const pr of merged) {
    const version = parseVersion(pr.title)
    if (version) return version
    core.warning(`Merged release PR #${pr.number} has unparseable title "${pr.title}", skipping it`)
  }
  return null
}

async function main({ github, context, core }) {
  const base = process.env.INPUT_BASE || 'master'
  const head = process.env.INPUT_HEAD || 'dev'
  const initialVersion = process.env.INPUT_INITIAL_VERSION || 'v0.1.0'
  const { owner, repo } = context.repo

  const { prs, directCommits } = await collectPendingChanges({ github, owner, repo, base, head })
  core.info(`${prs.length} merged PR(s) and ${directCommits.length} direct commit(s) pending on ${head}`)
  const changelog = renderChangelog({ prs, directCommits, head })

  const open = await github.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    base,
    head: `${owner}:${head}`,
  })

  let pr
  let created = false
  if (open.data.length > 0) {
    pr = open.data[0]
    const newBody = spliceBody(pr.body, changelog)
    if (newBody !== (pr.body || '')) {
      await github.rest.pulls.update({ owner, repo, pull_number: pr.number, body: newBody })
      core.info(`Updated changelog of release PR #${pr.number} ("${pr.title}")`)
    } else {
      core.info(`Release PR #${pr.number} already up to date`)
    }
  } else {
    if (prs.length === 0 && directCommits.length === 0) {
      core.info(`${head} has nothing that is not on ${base}; no release PR needed`)
      core.setOutput('pr-number', '')
      core.setOutput('pr-url', '')
      core.setOutput('version', '')
      core.setOutput('created', 'false')
      return
    }
    const previous = await lastReleasedVersion({ github, core, owner, repo, base, head })
    const initial = parseVersion(initialVersion)
    const title = previous ? formatVersion(bumpPatch(previous)) : initial ? formatVersion(initial) : initialVersion
    const res = await github.rest.pulls.create({
      owner,
      repo,
      base,
      head,
      title,
      body: initialBody(changelog, base, head),
    })
    pr = res.data
    created = true
    core.info(`Created release PR #${pr.number} ("${title}")`)
  }

  core.setOutput('pr-number', String(pr.number))
  core.setOutput('pr-url', pr.html_url)
  core.setOutput('version', pr.title)
  core.setOutput('created', String(created))
}

module.exports = {
  main,
  parseVersion,
  bumpPatch,
  formatVersion,
  renderChangelog,
  spliceBody,
  initialBody,
  MARKER_BEGIN,
  MARKER_END,
}
