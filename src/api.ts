// Octokit flows shared by the action entry points.

import type * as core from '@actions/core'
import type { getOctokit } from '@actions/github'
import {
  extractCustomerNotes,
  parseVersion,
  prNumberFromCommitMessage,
  type DirectCommit,
  type PendingPR,
  type Version,
} from './lib.ts'

export type Octokit = ReturnType<typeof getOctokit>
export type Core = typeof core

export interface RepoRef {
  owner: string
  repo: string
}

// The shape we rely on from the various endpoints that return pull requests.
interface PullLike {
  number: number
  title: string
  merged_at: string | null
  base: { ref: string }
  user: { login: string } | null
  body: string | null
}

export function statusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status?: unknown }).status
    return typeof status === 'number' ? status : undefined
  }
  return undefined
}

// Everything reachable from `head` but not from `base`, resolved to the PRs
// that brought those commits in. Commits with no merged PR into `head` are
// reported separately (direct pushes); merge commits without a PR are skipped
// as noise since their parents are listed individually.
export async function collectPendingChanges(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  base: string,
  head: string
): Promise<{ prs: PendingPR[]; directCommits: DirectCommit[] }> {
  const commits = []
  for (let page = 1; ; page++) {
    const res = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${base}...${head}`,
      per_page: 100,
      page,
    })
    commits.push(...res.data.commits)
    if (res.data.commits.length < 100 || commits.length >= res.data.total_commits) break
  }

  const prsByNumber = new Map<number, PendingPR>()
  const directCommits: DirectCommit[] = []
  for (const commit of commits) {
    const assoc = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo,
      commit_sha: commit.sha,
    })
    let mergedIntoHead: PullLike[] = assoc.data.filter(
      (pr) => pr.merged_at !== null && pr.base.ref === head
    )
    if (mergedIntoHead.length === 0) {
      // The commit -> PR association index is eventually consistent, and the
      // commit that triggered this very run is often not indexed yet. Fall
      // back to the PR number embedded in squash/merge commit messages.
      const number = prNumberFromCommitMessage(commit.commit.message)
      if (number !== null) {
        try {
          const res = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
          if (res.data.merged_at !== null && res.data.base.ref === head) mergedIntoHead = [res.data]
        } catch (err) {
          if (statusOf(err) !== 404) throw err
        }
      }
    }
    if (mergedIntoHead.length === 0 && commit.parents.length < 2) {
      directCommits.push({ sha: commit.sha, message: commit.commit.message.split('\n')[0]! })
    }
    for (const pr of mergedIntoHead) {
      if (!prsByNumber.has(pr.number)) {
        prsByNumber.set(pr.number, {
          number: pr.number,
          title: pr.title,
          author: pr.user ? pr.user.login : 'unknown',
          mergedAt: pr.merged_at!,
          notes: extractCustomerNotes(pr.body),
        })
      }
    }
  }

  const prs = [...prsByNumber.values()].sort((a, b) => (a.mergedAt < b.mergedAt ? -1 : 1))
  return { prs, directCommits }
}

async function mergedReleasePRs(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  base: string,
  head: string
) {
  const closed = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: 'closed',
    base,
    head: `${owner}:${head}`,
    per_page: 100,
  })
  return closed
    .filter((pr) => pr.merged_at !== null)
    .sort((a, b) => (a.merged_at! < b.merged_at! ? 1 : -1))
}

// The version we bump from: the title of the most recently merged release PR
// (head -> base). Unparseable titles are skipped with a warning so a renamed
// PR can't wedge the whole system.
export async function lastReleasedVersion(
  octokit: Octokit,
  core: Core,
  repoRef: RepoRef,
  base: string,
  head: string
): Promise<Version | null> {
  for (const pr of await mergedReleasePRs(octokit, repoRef, base, head)) {
    const version = parseVersion(pr.title)
    if (version) return version
    core.warning(`Merged release PR #${pr.number} has unparseable title "${pr.title}", skipping it`)
  }
  return null
}

// The most recently merged head -> base PR, with full body. Used by the
// workflow_dispatch republish path of the release publisher.
export async function latestMergedReleasePR(
  octokit: Octokit,
  repoRef: RepoRef,
  base: string,
  head: string
) {
  const merged = await mergedReleasePRs(octokit, repoRef, base, head)
  return merged[0] ?? null
}
