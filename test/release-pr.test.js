'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  parseVersion,
  bump,
  formatVersion,
  prNumberFromCommitMessage,
  parseGroups,
  splitPrefix,
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

test('bump minor increments minor and resets patch', () => {
  assert.equal(formatVersion(bump(parseVersion('v0.1.0'), 'minor')), 'v0.2.0')
  assert.equal(formatVersion(bump(parseVersion('v1.0.3'), 'minor')), 'v1.1.0')
  assert.equal(formatVersion(bump(parseVersion('v2.9.9'), 'minor')), 'v2.10.0')
})

test('bump patch only touches the patch component', () => {
  assert.equal(formatVersion(bump(parseVersion('v0.1.0'), 'patch')), 'v0.1.1')
  assert.equal(formatVersion(bump(parseVersion('v2.3.9'), 'patch')), 'v2.3.10')
})

test('bump major resets minor and patch', () => {
  assert.equal(formatVersion(bump(parseVersion('v1.4.2'), 'major')), 'v2.0.0')
})

test('bump rejects unknown levels', () => {
  assert.throws(() => bump(parseVersion('v1.0.0'), 'huge'), /Invalid bump level "huge"/)
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

test('parseGroups reads acronym mappings, skipping blanks and comments', () => {
  const groups = parseGroups('OTF: Operação Terra Forte\n\n# comment\ninfra: Infraestrutura\n')
  assert.deepEqual([...groups], [
    ['OTF', 'Operação Terra Forte'],
    ['INFRA', 'Infraestrutura'],
  ])
  assert.equal(parseGroups('').size, 0)
  assert.equal(parseGroups(undefined).size, 0)
})

test('parseGroups rejects malformed lines', () => {
  assert.throws(() => parseGroups('OTF Operação Terra Forte'), /Invalid groups line/)
  assert.throws(() => parseGroups('OTF:'), /Invalid groups line/)
  assert.throws(() => parseGroups(': nome'), /Invalid groups line/)
})

test('splitPrefix splits the acronym before the dash', () => {
  assert.deepEqual(splitPrefix('OTF - Adiciona módulo de eventos'), {
    acronym: 'OTF',
    rest: 'Adiciona módulo de eventos',
  })
  assert.deepEqual(splitPrefix('INFRA- sem espaço'), { acronym: 'INFRA', rest: 'sem espaço' })
  assert.equal(splitPrefix('Sem prefixo nenhum'), null)
  assert.equal(splitPrefix('OTF - '), null)
  assert.equal(splitPrefix('A - prefixo de uma letra'), null)
})

test('renderChangelog groups by prefix with mapped names, unknown acronyms, and ungrouped last', () => {
  const groups = parseGroups('OTF: Operação Terra Forte\nINFRA: Infraestrutura')
  const changelog = renderChangelog({
    prs: [
      { number: 1, title: 'Sem prefixo', author: 'a' },
      { number: 2, title: 'OTF - Adiciona módulo de eventos', author: 'b' },
      { number: 3, title: 'QA - Adiciona testes de fumaça', author: 'c' },
      { number: 4, title: 'INFRA - Atualiza pipeline', author: 'd' },
      { number: 5, title: 'OTF - Corrige relatório', author: 'e' },
    ],
    directCommits: [],
    head: 'dev',
    groups,
    ungroupedLabel: 'Outros',
  })
  assert.equal(
    changelog,
    [
      '<!-- auto-pr:begin -->',
      '### Changes since last deploy',
      '',
      '#### Operação Terra Forte',
      '- #2 Adiciona módulo de eventos (@b)',
      '- #5 Corrige relatório (@e)',
      '',
      '#### Infraestrutura',
      '- #4 Atualiza pipeline (@d)',
      '',
      '#### QA',
      '- #3 Adiciona testes de fumaça (@c)',
      '',
      '#### Outros',
      '- #1 Sem prefixo (@a)',
      '',
      '_5 pull requests · last updated from push to `dev`_',
      '<!-- auto-pr:end -->',
    ].join('\n')
  )
})

test('renderChangelog leaves non-all-caps dash titles ungrouped and intact', () => {
  const groups = parseGroups('OTF: Operação Terra Forte')
  const changelog = renderChangelog({
    prs: [{ number: 6, title: 'Fix - typo no readme', author: 'a' }],
    directCommits: [],
    head: 'dev',
    groups,
  })
  assert.match(changelog, /#### Other\n- #6 Fix - typo no readme \(@a\)/)
})

test('renderChangelog matches known acronyms case-insensitively', () => {
  const groups = parseGroups('OTF: Operação Terra Forte')
  const changelog = renderChangelog({
    prs: [{ number: 7, title: 'Otf - typo no acrônimo', author: 'a' }],
    directCommits: [],
    head: 'dev',
    groups,
  })
  assert.match(changelog, /#### Operação Terra Forte\n- #7 typo no acrônimo \(@a\)/)
})

test('renderChangelog stays flat when no groups are configured', () => {
  const changelog = renderChangelog({
    prs: [{ number: 8, title: 'OTF - Continua plano', author: 'a' }],
    directCommits: [],
    head: 'dev',
    groups: parseGroups(''),
  })
  assert.match(changelog, /- #8 OTF - Continua plano \(@a\)/)
  assert.doesNotMatch(changelog, /####/)
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
