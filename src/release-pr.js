'use strict'

// Core logic for the auto-pr release PR action.
//
// Invariants this module maintains:
//  - There is at most one open PR from `head` (staging) to `base` (production).
//  - Its body contains a changelog of every PR merged into `head` that is not
//    yet on `base`, kept between MARKER_BEGIN/MARKER_END so human-written text
//    outside the markers survives updates.
//  - Its title is set exactly once, at creation, to the previous released
//    version bumped by the configured level (minor by default). Human edits to
//    the title are never overwritten; the next release cycle bumps from
//    whatever title was merged.

const MARKER_BEGIN = '<!-- auto-pr:begin -->'
const MARKER_END = '<!-- auto-pr:end -->'

// Markers pre-filled into PR bodies by the PR template; authors write the
// customer-facing changelog lines between them.
const CHANGELOG_BEGIN = '<!-- changelog:begin -->'
const CHANGELOG_END = '<!-- changelog:end -->'

// What an author writes between the changelog markers to say "this PR is not
// customer-visible" (trailing punctuation ignored).
const INTERNAL_NOTE_WORDS = new Set(['interno', 'internal', 'skip'])

// Kept in sync with .github/PULL_REQUEST_TEMPLATE/novidades.md so a bare
// /novidades command inserts the same section the template would.
const CHANGELOG_INSTRUCTION = `<!-- O que muda para o cliente? Escreva em bullets abaixo desta linha,
     ou escreva "interno" se a mudança não for visível para o cliente. -->`

const SEMVER_RE = /v?(\d+)\.(\d+)\.(\d+)/

// Squash merges produce "Title (#N)" first lines; merge commits produce
// "Merge pull request #N from ...".
const SQUASH_MESSAGE_RE = /\(#(\d+)\)\s*$/
const MERGE_MESSAGE_RE = /^Merge pull request #(\d+)/

function parseVersion(text) {
  const m = SEMVER_RE.exec(text || '')
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

const BUMP_LEVELS = ['major', 'minor', 'patch']

function bump(version, level) {
  switch (level) {
    case 'major':
      return { major: version.major + 1, minor: 0, patch: 0 }
    case 'minor':
      return { major: version.major, minor: version.minor + 1, patch: 0 }
    case 'patch':
      return { major: version.major, minor: version.minor, patch: version.patch + 1 }
    default:
      throw new Error(`Invalid bump level "${level}": expected one of ${BUMP_LEVELS.join(', ')}`)
  }
}

function formatVersion(version) {
  return `v${version.major}.${version.minor}.${version.patch}`
}

// Parses the `groups` input: one "ACRONYM: Display name" mapping per line.
// Blank lines and #-comments are ignored; anything else malformed fails loudly.
function parseGroups(input) {
  const groups = new Map()
  for (const rawLine of (input || '').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    const acronym = colon === -1 ? '' : line.slice(0, colon).trim()
    const label = colon === -1 ? '' : line.slice(colon + 1).trim()
    if (!acronym || !label) {
      throw new Error(`Invalid groups line "${line}": expected "ACRONYM: Display name"`)
    }
    groups.set(acronym.toUpperCase(), label)
  }
  return groups
}

// "OTF - Adiciona módulo de eventos" -> { acronym: 'OTF', rest: 'Adiciona...' }
function splitPrefix(title) {
  const m = /^([A-Za-z][A-Za-z0-9]{1,11})\s*-\s*(.+)$/.exec((title || '').trim())
  if (!m) return null
  return { acronym: m[1], rest: m[2].trim() }
}

// Extracts the customer-facing notes an author wrote between the changelog
// markers of a PR body. Returns normalized bullet lines, or null when there
// is nothing customer-visible: markers missing, section empty (the template's
// instruction comment does not count), or explicitly marked internal.
function extractCustomerNotes(body) {
  const text = body || ''
  const begin = text.indexOf(CHANGELOG_BEGIN)
  const end = text.indexOf(CHANGELOG_END)
  if (begin === -1 || end === -1 || end < begin) return null
  const inner = text
    .slice(begin + CHANGELOG_BEGIN.length, end)
    .replace(/<!--[\s\S]*?-->/g, '')
  const lines = inner
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return null
  if (lines.length === 1 && INTERNAL_NOTE_WORDS.has(lines[0].toLowerCase().replace(/[.!]+$/, ''))) {
    return null
  }
  return lines.map((line) => `- ${line.replace(/^[-*]\s+/, '')}`)
}

// Bullet-normalizes free text destined for the changelog section, except a
// lone internal-marker word, which must stay bare so extractCustomerNotes
// still recognizes the opt-out.
function normalizeNotesText(text) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 1) {
    const bare = lines[0].replace(/^[-*]\s+/, '')
    if (INTERNAL_NOTE_WORDS.has(bare.toLowerCase().replace(/[.!]+$/, ''))) return bare
  }
  return lines.map((line) => `- ${line.replace(/^[-*]\s+/, '')}`).join('\n')
}

// Applies a /novidades command to a PR body. With text, the marker section is
// created or its content replaced; without text, an empty template section is
// appended when missing. Returns the new body, or null when nothing changes.
function upsertCustomerSection(existingBody, notesText) {
  const body = existingBody || ''
  const begin = body.indexOf(CHANGELOG_BEGIN)
  const end = body.indexOf(CHANGELOG_END)
  const hasMarkers = begin !== -1 && end !== -1 && end >= begin
  if (!notesText) {
    if (hasMarkers) return null
    const section = [CHANGELOG_BEGIN, CHANGELOG_INSTRUCTION, CHANGELOG_END].join('\n')
    return (body ? body.trimEnd() + '\n\n' : '') + section + '\n'
  }
  const section = [CHANGELOG_BEGIN, normalizeNotesText(notesText), CHANGELOG_END].join('\n')
  if (hasMarkers) {
    const next = body.slice(0, begin) + section + body.slice(end + CHANGELOG_END.length)
    return next === body ? null : next
  }
  return (body ? body.trimEnd() + '\n\n' : '') + section + '\n'
}

// Content of the auto-managed block of a release PR body, without the
// markers. Used to freeze the changelog into a GitHub Release on merge.
function extractAutoBlock(body) {
  const text = body || ''
  const begin = text.indexOf(MARKER_BEGIN)
  const end = text.indexOf(MARKER_END)
  if (begin === -1 || end === -1 || end < begin) return null
  return text.slice(begin + MARKER_BEGIN.length, end).trim()
}

// Distributes PRs into ordered [label, prs] sections: mapped groups first (in
// mapping order), unknown all-caps acronyms alphabetically, ungrouped last.
// Each PR gains a displayTitle with the acronym prefix stripped when grouped.
function bucketByProject(prs, groups, ungroupedLabel) {
  const items = new Map()
  const unknownAcronyms = new Set()
  const add = (label, item) => {
    if (!items.has(label)) items.set(label, [])
    items.get(label).push(item)
  }
  for (const pr of prs) {
    const split = splitPrefix(pr.title)
    const key = split ? split.acronym.toUpperCase() : null
    if (split && groups.has(key)) {
      add(groups.get(key), { ...pr, displayTitle: split.rest })
    } else if (split && split.acronym === key) {
      // All-caps prefix that is not in the mapping yet: group it under the
      // raw acronym rather than losing it among the ungrouped PRs.
      unknownAcronyms.add(key)
      add(key, { ...pr, displayTitle: split.rest })
    } else {
      add(ungroupedLabel, { ...pr, displayTitle: pr.title })
    }
  }
  const order = [...new Set([...groups.values(), ...[...unknownAcronyms].sort(), ungroupedLabel])]
  return order.filter((label) => items.has(label)).map((label) => [label, items.get(label)])
}

function renderChangelog({
  prs,
  directCommits,
  head,
  groups,
  ungroupedLabel = 'Other',
  customerHeading = 'Customer changelog',
}) {
  const entry = (pr, title) => `- #${pr.number} ${title} (@${pr.author})`
  const grouped = groups && groups.size > 0
  const lines = [MARKER_BEGIN, '### Changes since last deploy', '']
  if (prs.length === 0 && directCommits.length === 0) {
    lines.push('_No pending changes detected._')
  } else if (!grouped) {
    for (const pr of prs) {
      lines.push(entry(pr, pr.title))
    }
  } else {
    for (const [i, [label, list]] of bucketByProject(prs, groups, ungroupedLabel).entries()) {
      if (i > 0) lines.push('')
      lines.push(`#### ${label}`, ...list.map((pr) => entry(pr, pr.displayTitle)))
    }
  }
  if (directCommits.length > 0) {
    lines.push('', 'Commits without a pull request:')
    for (const commit of directCommits) {
      lines.push(`- ${commit.sha.slice(0, 7)} ${commit.message}`)
    }
  }
  // Customer-facing section: only PRs whose authors wrote notes, rendered
  // clean (no PR numbers or authors) so each project block can be sent as-is.
  const withNotes = prs.filter((pr) => pr.notes && pr.notes.length > 0)
  if (withNotes.length > 0) {
    lines.push('', `### ${customerHeading}`, '')
    if (!grouped) {
      lines.push(...withNotes.flatMap((pr) => pr.notes))
    } else {
      for (const [i, [label, list]] of bucketByProject(withNotes, groups, ungroupedLabel).entries()) {
        if (i > 0) lines.push('')
        lines.push(`#### ${label}`, ...list.flatMap((pr) => pr.notes))
      }
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

function prNumberFromCommitMessage(message) {
  const firstLine = (message || '').split('\n')[0]
  const m = SQUASH_MESSAGE_RE.exec(firstLine) || MERGE_MESSAGE_RE.exec(firstLine)
  return m ? Number(m[1]) : null
}

function initialBody(changelog, base, head) {
  return [
    '## Pending release',
    '',
    changelog,
    '',
    '---',
    '',
    `_Merging this PR ships everything listed above to production. Merge with a **merge commit** so \`${base}\` stays in sync with \`${head}\`._`,
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
    let mergedIntoHead = assoc.data.filter((pr) => pr.merged_at && pr.base.ref === head)
    if (mergedIntoHead.length === 0) {
      // The commit -> PR association index is eventually consistent, and the
      // commit that triggered this very run is often not indexed yet. Fall
      // back to the PR number embedded in squash/merge commit messages.
      const number = prNumberFromCommitMessage(commit.commit.message)
      if (number !== null) {
        try {
          const res = await github.rest.pulls.get({ owner, repo, pull_number: number })
          if (res.data.merged_at && res.data.base.ref === head) mergedIntoHead = [res.data]
        } catch (err) {
          if (err.status !== 404) throw err
        }
      }
    }
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
          notes: extractCustomerNotes(pr.body),
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
  const bumpLevel = process.env.INPUT_BUMP || 'minor'
  if (!BUMP_LEVELS.includes(bumpLevel)) {
    throw new Error(`Invalid bump input "${bumpLevel}": expected one of ${BUMP_LEVELS.join(', ')}`)
  }
  const groups = parseGroups(process.env.INPUT_GROUPS)
  const ungroupedLabel = process.env.INPUT_UNGROUPED_LABEL || 'Other'
  const customerHeading = process.env.INPUT_CUSTOMER_HEADING || 'Customer changelog'
  const { owner, repo } = context.repo

  const { prs, directCommits } = await collectPendingChanges({ github, owner, repo, base, head })
  core.info(`${prs.length} merged PR(s) and ${directCommits.length} direct commit(s) pending on ${head}`)
  const changelog = renderChangelog({ prs, directCommits, head, groups, ungroupedLabel, customerHeading })

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
    const title = previous ? formatVersion(bump(previous, bumpLevel)) : initial ? formatVersion(initial) : initialVersion
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

// The most recently merged head -> base PR, with full body (unlike main(),
// which only needs titles). Used by the workflow_dispatch republish path.
async function latestMergedReleasePR({ github, owner, repo, base, head }) {
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
  return merged[0] || null
}

// Entry point of the release/ sub-action: when a release PR merges, tag the
// merge commit with the PR title's version and publish a GitHub Release whose
// body is the frozen changelog block. Idempotent: an existing release for the
// tag is left untouched, so workflow_dispatch reruns are safe.
async function publishRelease({ github, context, core }) {
  const base = process.env.INPUT_BASE || 'master'
  const head = process.env.INPUT_HEAD || 'dev'
  const { owner, repo } = context.repo

  let pr = context.payload.pull_request
  if (pr && !(pr.merged && pr.base.ref === base && pr.head.ref === head)) {
    core.info('Event pull request is not a merged release PR; nothing to publish')
    return
  }
  if (!pr) {
    pr = await latestMergedReleasePR({ github, owner, repo, base, head })
    if (!pr) {
      core.info(`No merged ${head} -> ${base} PR found; nothing to publish`)
      return
    }
  }

  const version = parseVersion(pr.title)
  if (!version) {
    core.warning(`Could not parse a version from release PR title "${pr.title}"; skipping release`)
    return
  }
  const tag = formatVersion(version)

  try {
    const existing = await github.rest.repos.getReleaseByTag({ owner, repo, tag })
    core.info(`Release ${tag} already exists: ${existing.data.html_url}`)
    core.setOutput('release-url', existing.data.html_url)
    core.setOutput('tag', tag)
    return
  } catch (err) {
    if (err.status !== 404) throw err
  }

  const body = extractAutoBlock(pr.body) || pr.body || ''
  const release = await github.rest.repos.createRelease({
    owner,
    repo,
    tag_name: tag,
    name: tag,
    target_commitish: pr.merge_commit_sha,
    body,
  })
  core.info(`Published release ${tag} from PR #${pr.number}: ${release.data.html_url}`)
  core.setOutput('release-url', release.data.html_url)
  core.setOutput('tag', tag)
}

// Entry point of the novidades/ sub-action: a comment starting with the
// command word writes the customer changelog section into the PR body, since
// GitHub's /template slash command cannot insert named PR templates. The
// comment gets a 🚀 reaction as acknowledgment.
async function applyNovidadesCommand({ github, context, core }) {
  const command = process.env.INPUT_COMMAND || 'novidades'
  const { owner, repo } = context.repo
  const issue = context.payload.issue
  const comment = context.payload.comment
  if (!issue || !comment) {
    core.info('No comment payload; nothing to do')
    return
  }
  if (!issue.pull_request) {
    core.info(`Comment is on an issue, not a PR; /${command} only works on pull requests`)
    return
  }
  const match = new RegExp(`^/${command}\\b([\\s\\S]*)$`).exec((comment.body || '').trim())
  if (!match) {
    core.info(`Comment does not start with /${command}; ignoring`)
    return
  }
  const notesText = match[1].trim()

  const pr = await github.rest.pulls.get({ owner, repo, pull_number: issue.number })
  const newBody = upsertCustomerSection(pr.data.body, notesText)
  if (newBody !== null) {
    await github.rest.pulls.update({ owner, repo, pull_number: issue.number, body: newBody })
    core.info(`Updated the changelog section of PR #${issue.number}`)
  } else {
    core.info(`PR #${issue.number} already has the requested changelog section; no edit needed`)
  }
  await github.rest.reactions.createForIssueComment({
    owner,
    repo,
    comment_id: comment.id,
    content: 'rocket',
  })
  core.setOutput('updated', String(newBody !== null))
  core.setOutput('pr-number', String(issue.number))
}

module.exports = {
  main,
  publishRelease,
  applyNovidadesCommand,
  parseVersion,
  bump,
  formatVersion,
  prNumberFromCommitMessage,
  parseGroups,
  splitPrefix,
  extractCustomerNotes,
  extractAutoBlock,
  upsertCustomerSection,
  renderChangelog,
  spliceBody,
  initialBody,
  MARKER_BEGIN,
  MARKER_END,
}
