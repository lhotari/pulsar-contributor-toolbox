---
name: pulsar-create-pr
description: Create a pull request to apache/pulsar
allowed-tools: Bash(gh *), Bash(find *), Bash(grep *), Read, Glob, Grep
---

# Create a pull request to apache/pulsar

To create a pull request to the apache/pulsar repository, you can follow these steps:

1. Unless a specific branch other than master is provided, create a new branch for the changes.
   Follow the naming convention: `${PULSAR_PR_BRANCH_PREFIX}[fix|improve|feat]-[brief-description]`.
   - The `[fix|improve|feat]` prefix reflects the type of change, matching the semantic commit message types defined in @.github/workflows/ci-semantic-pull-request.yml.
   - The brief description should be concise and not exceed 30 characters.
   - `PULSAR_PR_BRANCH_PREFIX` is typically set to the user's initials followed by a hyphen (e.g., `my-`).
   - Example: `my-fix-auth-npe-in-some-scenario`.
   Create the branch using the following command:
   ```shell
   git switch -c [branch-name]
   ```
2. Push the branch to the forked repository on GitHub. The remote name is specified by the `PULSAR_FORKED_REMOTE` environment variable (default: `forked`). Set the upstream branch:
   ```shell
   git push -u ${PULSAR_FORKED_REMOTE:-forked} [branch-name]
   ```
3. Create a pull request using the GitHub CLI (`gh`). Follow the format described in @.github/PULL_REQUEST_TEMPLATE.md and ensure the title matches the semantic conventions defined in @.github/workflows/ci-semantic-pull-request.yml.
4. If the `PULSAR_PR_REVIEWERS` environment variable is set, request reviews from the specified reviewers using the GitHub CLI (`gh`).
5. When revisiting the PR later, update the description to reflect the latest changes and provide context for reviewers. Ensure it complies with @.github/PULL_REQUEST_TEMPLATE.md.