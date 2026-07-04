'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  parseVersion,
  bumpPatch,
  formatVersion,
  prNumberFromCommitMessage,
  renderChangelog,
  spliceBody,
  initialBody,
  MARKER_BEGIN,
  MARKER_END,
} = require('../src/release-pr.js')

test('parseVersion reads plain and v-prefixed versions', () => {
  assert.deepEqual(parseVersion('v0.1.0'), { major: 0, minor: 1, patch: 0 })
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 })
  assert.deepEqual(parseVersion('v12.34.56'), { major: 12, minor: 34, patch: 56 })
})

test('parseVersion finds the version inside a longer title', () => {
  assert.deepEqual(parseVersion('v2.0.0 - the big one'), { major: 2, minor: 0, patch: 0 })
  assert.deepEqual(parseVersion('Release v1.4.2 (hotfix)'), { major: 1, minor: 4, patch: 2 })
})

test('parseVersion rejects non-versions', () => {
  assert.equal(parseVersion('not a version'), null)
  assert.equal(parseVersion('v1.2'), null)
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion(null), null)
})

test('bumpPatch only touches the patch component', () => {
  assert.equal(formatVersion(bumpPatch(parseVersion('v0.1.0'))), 'v0.1.1')
  assert.equal(formatVersion(bumpPatch(parseVersion('v1.0.0'))), 'v1.0.1')
  assert.equal(formatVersion(bumpPatch(parseVersion('v2.3.9'))), 'v2.3.10')
})

test('prNumberFromCommitMessage reads squash and merge commit messages', () => {
  assert.equal(prNumberFromCommitMessage('Add farewell module (#3)'), 3)
  assert.equal(prNumberFromCommitMessage('Fix thing (#12)\n\nlong body (#99)'), 12)
  assert.equal(prNumberFromCommitMessage('Merge pull request #7 from o/feat'), 7)
  assert.equal(prNumberFromCommitMessage('Mention (#5) mid-title somewhere'), null)
  assert.equal(prNumberFromCommitMessage('Plain direct commit'), null)
  assert.equal(prNumberFromCommitMessage(''), null)
})

test('renderChangelog lists PRs with number, title, and author', () => {
  const changelog = renderChangelog({
    prs: [
      { number: 12, title: 'Add user login', author: 'bruno' },
      { number: 14, title: 'Fix cart total rounding', author: 'bruno' },
    ],
    directCommits: [],
    head: 'dev',
  })
  assert.equal(
    changelog,
    [
      MARKER_BEGIN,
      '### Changes since last deploy',
      '',
      '- #12 Add user login (@bruno)',
      '- #14 Fix cart total rounding (@bruno)',
      '',
      '_2 pull requests · last updated from push to `dev`_',
      MARKER_END,
    ].join('\n')
  )
})

test('renderChangelog uses singular for one PR and lists direct commits', () => {
  const changelog = renderChangelog({
    prs: [{ number: 3, title: 'One thing', author: 'bruno' }],
    directCommits: [{ sha: 'abcdef1234567890', message: 'quick fix on dev' }],
    head: 'dev',
  })
  assert.match(changelog, /_1 pull request · /)
  assert.match(changelog, /Commits without a pull request:/)
  assert.match(changelog, /- abcdef1 quick fix on dev/)
})

test('renderChangelog handles the empty case', () => {
  const changelog = renderChangelog({ prs: [], directCommits: [], head: 'dev' })
  assert.match(changelog, /_No pending changes detected\._/)
})

test('spliceBody replaces only the marker-delimited section', () => {
  const body = [
    'Human intro, do not touch.',
    '',
    MARKER_BEGIN,
    'old changelog',
    MARKER_END,
    '',
    'Human outro, do not touch.',
  ].join('\n')
  const next = spliceBody(body, `${MARKER_BEGIN}\nnew changelog\n${MARKER_END}`)
  assert.equal(
    next,
    [
      'Human intro, do not touch.',
      '',
      MARKER_BEGIN,
      'new changelog',
      MARKER_END,
      '',
      'Human outro, do not touch.',
    ].join('\n')
  )
})

test('spliceBody appends the section when markers were removed', () => {
  const changelog = `${MARKER_BEGIN}\nchangelog\n${MARKER_END}`
  assert.equal(spliceBody('Human text only.', changelog), `Human text only.\n\n${changelog}`)
  assert.equal(spliceBody('', changelog), changelog)
  assert.equal(spliceBody(null, changelog), changelog)
})

test('spliceBody is idempotent', () => {
  const changelog = `${MARKER_BEGIN}\nchangelog\n${MARKER_END}`
  const once = spliceBody('intro', changelog)
  assert.equal(spliceBody(once, changelog), once)
})

test('initialBody wraps the changelog with heading and merge note', () => {
  const body = initialBody(`${MARKER_BEGIN}\nx\n${MARKER_END}`, 'master', 'dev')
  assert.match(body, /^## Pending release\n/)
  assert.match(body, /Merge with a \*\*merge commit\*\* so `master` stays in sync with `dev`\./)
})
