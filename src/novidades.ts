// Entry point of the novidades/ action: a comment starting with the command
// word writes the customer changelog section into the PR body, since GitHub's
// /template slash command cannot insert named PR templates. The comment gets
// a 🚀 reaction as acknowledgment.

import * as core from '@actions/core'
import * as github from '@actions/github'
import { upsertCustomerSection } from './lib.ts'

interface IssuePayload {
  number: number
  pull_request?: unknown
}

interface CommentPayload {
  id: number
  body?: string
}

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const command = core.getInput('command') || 'novidades'
  const heading = core.getInput('heading')

  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo

  const issue = github.context.payload.issue as IssuePayload | undefined
  const comment = github.context.payload.comment as CommentPayload | undefined
  if (!issue || !comment) {
    core.info('No comment payload; nothing to do')
    return
  }
  if (!issue.pull_request) {
    core.info(`Comment is on an issue, not a PR; /${command} only works on pull requests`)
    return
  }
  const match = new RegExp(`^/${command}\\b([\\s\\S]*)$`).exec((comment.body ?? '').trim())
  if (!match) {
    core.info(`Comment does not start with /${command}; ignoring`)
    return
  }
  const notesText = match[1]!.trim()

  const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: issue.number })
  const newBody = upsertCustomerSection(pr.data.body, notesText, heading)
  if (newBody !== null) {
    await octokit.rest.pulls.update({ owner, repo, pull_number: issue.number, body: newBody })
    core.info(`Updated the changelog section of PR #${issue.number}`)
  } else {
    core.info(`PR #${issue.number} already has the requested changelog section; no edit needed`)
  }
  await octokit.rest.reactions.createForIssueComment({
    owner,
    repo,
    comment_id: comment.id,
    content: 'rocket',
  })
  core.setOutput('updated', String(newBody !== null))
  core.setOutput('pr-number', String(issue.number))
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err))
})
