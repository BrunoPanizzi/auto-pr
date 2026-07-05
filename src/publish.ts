// Entry point of the release/ action: when a release PR merges, tag the merge
// commit with the PR title's version and publish a GitHub Release whose body
// is the frozen changelog block. Idempotent: an existing release for the tag
// is left untouched, so workflow_dispatch reruns are safe.

import * as core from '@actions/core'
import * as github from '@actions/github'
import { latestMergedReleasePR, statusOf } from './api.ts'
import { extractAutoBlock, formatVersion, parseVersion } from './lib.ts'

interface ReleasePR {
  number: number
  title: string
  body: string | null
  merge_commit_sha: string | null
}

interface PullRequestPayload extends ReleasePR {
  merged: boolean
  base: { ref: string }
  head: { ref: string }
}

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const base = core.getInput('base') || 'master'
  const head = core.getInput('head') || 'dev'
  const updateMajorTag = core.getInput('update-major-tag').toLowerCase() === 'true'

  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo

  const payloadPR = github.context.payload.pull_request as PullRequestPayload | undefined
  let pr: ReleasePR
  if (payloadPR) {
    if (!(payloadPR.merged && payloadPR.base.ref === base && payloadPR.head.ref === head)) {
      core.info('Event pull request is not a merged release PR; nothing to publish')
      return
    }
    pr = payloadPR
  } else {
    const latest = await latestMergedReleasePR(octokit, { owner, repo }, base, head)
    if (!latest) {
      core.info(`No merged ${head} -> ${base} PR found; nothing to publish`)
      return
    }
    pr = latest
  }

  const version = parseVersion(pr.title)
  if (!version) {
    core.warning(`Could not parse a version from release PR title "${pr.title}"; skipping release`)
    return
  }
  const tag = formatVersion(version)

  try {
    const existing = await octokit.rest.repos.getReleaseByTag({ owner, repo, tag })
    core.info(`Release ${tag} already exists: ${existing.data.html_url}`)
    core.setOutput('release-url', existing.data.html_url)
    core.setOutput('tag', tag)
    return
  } catch (err) {
    if (statusOf(err) !== 404) throw err
  }

  const body = extractAutoBlock(pr.body) ?? pr.body ?? ''
  const release = await octokit.rest.repos.createRelease({
    owner,
    repo,
    tag_name: tag,
    name: tag,
    target_commitish: pr.merge_commit_sha ?? undefined,
    body,
  })
  core.info(`Published release ${tag} from PR #${pr.number}: ${release.data.html_url}`)

  // Keep a moving major tag (v1, v2, ...) on the release commit so consumers
  // of this repo's actions can pin `@v1` instead of `@master`.
  if (updateMajorTag && pr.merge_commit_sha) {
    const majorTag = `v${version.major}`
    try {
      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `tags/${majorTag}`,
        sha: pr.merge_commit_sha,
        force: true,
      })
      core.info(`Moved ${majorTag} to ${pr.merge_commit_sha}`)
    } catch (err) {
      const status = statusOf(err)
      if (status === 404 || status === 422) {
        await octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/tags/${majorTag}`,
          sha: pr.merge_commit_sha,
        })
        core.info(`Created ${majorTag} at ${pr.merge_commit_sha}`)
      } else {
        throw err
      }
    }
  }

  core.setOutput('release-url', release.data.html_url)
  core.setOutput('tag', tag)
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err))
})
