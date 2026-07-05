// Entry point of the root action: keep the always-open release PR up to date.

import * as core from '@actions/core'
import * as github from '@actions/github'
import { collectPendingChanges, lastReleasedVersion } from './api.ts'
import {
  bump,
  formatVersion,
  initialBody,
  isBumpLevel,
  parseGroups,
  parseVersion,
  renderChangelog,
  spliceBody,
} from './lib.ts'

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const base = core.getInput('base') || 'master'
  const head = core.getInput('head') || 'dev'
  const initialVersion = core.getInput('initial-version') || 'v0.1.0'
  const bumpLevel = core.getInput('bump') || 'minor'
  if (!isBumpLevel(bumpLevel)) {
    throw new Error(`Invalid bump input "${bumpLevel}": expected major, minor, or patch`)
  }
  const groups = parseGroups(core.getInput('groups'))
  const ungroupedLabel = core.getInput('ungrouped-label') || 'Other'
  const customerHeading = core.getInput('customer-heading') || 'Customer changelog'

  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo
  const repoRef = { owner, repo }

  const { prs, directCommits } = await collectPendingChanges(octokit, repoRef, base, head)
  core.info(`${prs.length} merged PR(s) and ${directCommits.length} direct commit(s) pending on ${head}`)
  const changelog = renderChangelog({ prs, directCommits, head, groups, ungroupedLabel, customerHeading })

  const open = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    base,
    head: `${owner}:${head}`,
  })

  let prNumber: number
  let prUrl: string
  let version: string
  let created = false
  const existing = open.data[0]
  if (existing) {
    const newBody = spliceBody(existing.body, changelog)
    if (newBody !== (existing.body ?? '')) {
      await octokit.rest.pulls.update({ owner, repo, pull_number: existing.number, body: newBody })
      core.info(`Updated changelog of release PR #${existing.number} ("${existing.title}")`)
    } else {
      core.info(`Release PR #${existing.number} already up to date`)
    }
    prNumber = existing.number
    prUrl = existing.html_url
    version = existing.title
  } else {
    if (prs.length === 0 && directCommits.length === 0) {
      core.info(`${head} has nothing that is not on ${base}; no release PR needed`)
      core.setOutput('pr-number', '')
      core.setOutput('pr-url', '')
      core.setOutput('version', '')
      core.setOutput('created', 'false')
      return
    }
    const previous = await lastReleasedVersion(octokit, core, repoRef, base, head)
    const initial = parseVersion(initialVersion)
    const title = previous
      ? formatVersion(bump(previous, bumpLevel))
      : initial
        ? formatVersion(initial)
        : initialVersion
    const res = await octokit.rest.pulls.create({
      owner,
      repo,
      base,
      head,
      title,
      body: initialBody(changelog, base, head),
    })
    created = true
    prNumber = res.data.number
    prUrl = res.data.html_url
    version = res.data.title
    core.info(`Created release PR #${prNumber} ("${title}")`)
  }

  core.setOutput('pr-number', String(prNumber))
  core.setOutput('pr-url', prUrl)
  core.setOutput('version', version)
  core.setOutput('created', String(created))
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err))
})
