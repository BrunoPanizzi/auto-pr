// Pure logic shared by the three auto-pr actions.
//
// Invariants maintained by the release PR action:
//  - There is at most one open PR from `head` (staging) to `base` (production).
//  - Its body contains a changelog of every PR merged into `head` that is not
//    yet on `base`, kept between MARKER_BEGIN/MARKER_END so human-written text
//    outside the markers survives updates.
//  - Its title is set exactly once, at creation, to the previous released
//    version bumped by the configured level (minor by default). Human edits to
//    the title are never overwritten; the next release cycle bumps from
//    whatever title was merged.

export const MARKER_BEGIN = '<!-- auto-pr:begin -->'
export const MARKER_END = '<!-- auto-pr:end -->'

// Markers pre-filled into PR bodies by the PR template or the /novidades
// command; authors write the customer-facing changelog lines between them.
export const CHANGELOG_BEGIN = '<!-- changelog:begin -->'
export const CHANGELOG_END = '<!-- changelog:end -->'

// What an author writes between the changelog markers to say "this PR is not
// customer-visible" (trailing punctuation ignored).
const INTERNAL_NOTE_WORDS = new Set(['interno', 'internal', 'skip'])

// Kept in sync with .github/PULL_REQUEST_TEMPLATE/novidades.md so a bare
// /novidades command inserts the same section the template would.
export const CHANGELOG_INSTRUCTION = `<!-- O que muda para o cliente? Escreva em bullets abaixo desta linha,
     ou escreva "interno" se a mudança não for visível para o cliente. -->`

const SEMVER_RE = /v?(\d+)\.(\d+)\.(\d+)/

// Squash merges produce "Title (#N)" first lines; merge commits produce
// "Merge pull request #N from ...".
const SQUASH_MESSAGE_RE = /\(#(\d+)\)\s*$/
const MERGE_MESSAGE_RE = /^Merge pull request #(\d+)/

export interface Version {
  major: number
  minor: number
  patch: number
}

export const BUMP_LEVELS = ['major', 'minor', 'patch'] as const
export type BumpLevel = (typeof BUMP_LEVELS)[number]

export interface PendingPR {
  number: number
  title: string
  author: string
  mergedAt: string
  notes: string[] | null
}

export interface DirectCommit {
  sha: string
  message: string
}

export type Groups = Map<string, string>

export function parseVersion(text: string | null | undefined): Version | null {
  const m = SEMVER_RE.exec(text ?? '')
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

export function isBumpLevel(level: string): level is BumpLevel {
  return (BUMP_LEVELS as readonly string[]).includes(level)
}

export function bump(version: Version, level: string): Version {
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

export function formatVersion(version: Version): string {
  return `v${version.major}.${version.minor}.${version.patch}`
}

// Parses the `groups` input: one "ACRONYM: Display name" mapping per line.
// Blank lines and #-comments are ignored; anything else malformed fails loudly.
export function parseGroups(input: string | null | undefined): Groups {
  const groups: Groups = new Map()
  for (const rawLine of (input ?? '').split('\n')) {
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
export function splitPrefix(title: string | null | undefined): { acronym: string; rest: string } | null {
  const m = /^([A-Za-z][A-Za-z0-9]{1,11})\s*-\s*(.+)$/.exec((title ?? '').trim())
  if (!m) return null
  return { acronym: m[1]!, rest: m[2]!.trim() }
}

export function prNumberFromCommitMessage(message: string | null | undefined): number | null {
  const firstLine = (message ?? '').split('\n')[0]!
  const m = SQUASH_MESSAGE_RE.exec(firstLine) ?? MERGE_MESSAGE_RE.exec(firstLine)
  return m ? Number(m[1]) : null
}

// Extracts the customer-facing notes an author wrote between the changelog
// markers of a PR body. Returns normalized bullet lines, or null when there
// is nothing customer-visible: markers missing, section empty (the template's
// instruction comment does not count), or explicitly marked internal.
export function extractCustomerNotes(body: string | null | undefined): string[] | null {
  const text = body ?? ''
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
  if (lines.length === 1 && isInternalWord(lines[0]!)) return null
  return lines.map((line) => `- ${line.replace(/^[-*]\s+/, '')}`)
}

function isInternalWord(line: string): boolean {
  const bare = line.replace(/^[-*]\s+/, '')
  return INTERNAL_NOTE_WORDS.has(bare.toLowerCase().replace(/[.!]+$/, ''))
}

// Bullet-normalizes free text destined for the changelog section, except a
// lone internal-marker word, which must stay bare so extractCustomerNotes
// still recognizes the opt-out.
function normalizeNotesText(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 1 && isInternalWord(lines[0]!)) {
    return lines[0]!.replace(/^[-*]\s+/, '')
  }
  return lines.map((line) => `- ${line.replace(/^[-*]\s+/, '')}`).join('\n')
}

// Applies a /novidades command to a PR body. With text, the marker section is
// created or its content replaced; without text, an empty template section is
// appended when missing. A freshly created section is prefixed with the
// visible heading (matching the PR template); replacements leave the
// surroundings alone so an existing heading is never duplicated. Returns the
// new body, or null when nothing changes.
export function upsertCustomerSection(
  existingBody: string | null | undefined,
  notesText: string,
  heading = ''
): string | null {
  const body = existingBody ?? ''
  const begin = body.indexOf(CHANGELOG_BEGIN)
  const end = body.indexOf(CHANGELOG_END)
  const hasMarkers = begin !== -1 && end !== -1 && end >= begin
  const appendFreshSection = (content: string): string => {
    const section = [CHANGELOG_BEGIN, content, CHANGELOG_END].join('\n')
    const withHeading = heading ? `${heading}\n\n${section}` : section
    return (body ? body.trimEnd() + '\n\n' : '') + withHeading + '\n'
  }
  if (!notesText) {
    if (hasMarkers) return null
    return appendFreshSection(CHANGELOG_INSTRUCTION)
  }
  if (hasMarkers) {
    const section = [CHANGELOG_BEGIN, normalizeNotesText(notesText), CHANGELOG_END].join('\n')
    const next = body.slice(0, begin) + section + body.slice(end + CHANGELOG_END.length)
    return next === body ? null : next
  }
  return appendFreshSection(normalizeNotesText(notesText))
}

// Content of the auto-managed block of a release PR body, without the
// markers. Used to freeze the changelog into a GitHub Release on merge.
export function extractAutoBlock(body: string | null | undefined): string | null {
  const text = body ?? ''
  const begin = text.indexOf(MARKER_BEGIN)
  const end = text.indexOf(MARKER_END)
  if (begin === -1 || end === -1 || end < begin) return null
  return text.slice(begin + MARKER_BEGIN.length, end).trim()
}

// Distributes PRs into ordered [label, prs] sections: mapped groups first (in
// mapping order), unknown all-caps acronyms alphabetically, ungrouped last.
// Each PR gains a displayTitle with the acronym prefix stripped when grouped.
function bucketByProject<T extends { title: string }>(
  prs: T[],
  groups: Groups,
  ungroupedLabel: string
): Array<[string, Array<T & { displayTitle: string }>]> {
  const items = new Map<string, Array<T & { displayTitle: string }>>()
  const unknownAcronyms = new Set<string>()
  const add = (label: string, item: T & { displayTitle: string }): void => {
    const list = items.get(label)
    if (list) list.push(item)
    else items.set(label, [item])
  }
  for (const pr of prs) {
    const split = splitPrefix(pr.title)
    const key = split ? split.acronym.toUpperCase() : null
    if (split && key && groups.has(key)) {
      add(groups.get(key)!, { ...pr, displayTitle: split.rest })
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
  return order.filter((label) => items.has(label)).map((label) => [label, items.get(label)!])
}

export interface RenderOptions {
  prs: PendingPR[]
  directCommits: DirectCommit[]
  head: string
  groups?: Groups
  ungroupedLabel?: string
  customerHeading?: string
}

export function renderChangelog({
  prs,
  directCommits,
  head,
  groups,
  ungroupedLabel = 'Other',
  customerHeading = 'Customer changelog',
}: RenderOptions): string {
  const entry = (pr: PendingPR, title: string): string => `- #${pr.number} ${title} (@${pr.author})`
  const grouped = groups !== undefined && groups.size > 0
  const lines: string[] = [MARKER_BEGIN, '### Changes since last deploy', '']
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
  const withNotes = prs.filter((pr) => pr.notes !== null && pr.notes.length > 0)
  if (withNotes.length > 0) {
    lines.push('', `### ${customerHeading}`, '')
    if (!grouped) {
      lines.push(...withNotes.flatMap((pr) => pr.notes!))
    } else {
      for (const [i, [label, list]] of bucketByProject(withNotes, groups, ungroupedLabel).entries()) {
        if (i > 0) lines.push('')
        lines.push(`#### ${label}`, ...list.flatMap((pr) => pr.notes!))
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
export function spliceBody(existingBody: string | null | undefined, changelog: string): string {
  const body = existingBody ?? ''
  const begin = body.indexOf(MARKER_BEGIN)
  const end = body.indexOf(MARKER_END)
  if (begin !== -1 && end !== -1 && end >= begin) {
    return body.slice(0, begin) + changelog + body.slice(end + MARKER_END.length)
  }
  return (body ? body.trimEnd() + '\n\n' : '') + changelog
}

export function initialBody(changelog: string, base: string, head: string): string {
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
