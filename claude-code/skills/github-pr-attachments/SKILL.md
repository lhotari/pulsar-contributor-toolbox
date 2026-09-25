---
name: github-pr-attachments
description: Attach local images and videos to GitHub pull requests using the built-in gh CLI. Use when creating or editing a PR that needs screenshots, diagrams, plots, images, or videos.
---

# GitHub PR attachments

Use the built-in `--attach` option of `gh pr create`, `gh pr edit`,
or `gh pr comment` to attach local images and videos to pull requests.

Do not use any third-party extension or other third-party tool to attach
images. In particular, do not use the obsolete `gh-attach` extension.

## Supported attachment types

GitHub supports these image and media formats:

- `.png`
- `.gif`
- `.jpg`
- `.jpeg`
- `.svg`
- `.mp4`
- `.mov`
- `.webm`

`gh --attach` is intended for image and video/media attachments.

## Attaching files

Use `--attach` with the local file:

    gh pr create --attach screenshot.png
    gh pr edit --attach screenshot.png
    gh pr comment --attach screenshot.png

`--attach` can be repeated to attach multiple files:

    gh pr edit \
      --attach screenshot1.png \
      --attach screenshot2.png

## Positioning images in the PR body

When an attached image is not already referenced in the PR body, GitHub CLI
appends its generated image tag to the body.

To place the image at a specific location:

1. Attach the image using `--attach`.
2. Read the resulting PR body.
3. Edit the PR body and move the generated image tag to the desired location.
4. Preserve the generated image tag content exactly when moving it.

Do not replace the generated URL with a local file path.

Alternatively, when creating or editing the PR, the body may contain an image
reference to the local file:

    ![Benchmark results](benchmark.png)

and the same file can be passed with:

    gh pr edit \
      --body-file pr-body.md \
      --attach benchmark.png

GitHub CLI will upload the file and rewrite the local reference to the
uploaded asset while retaining the Markdown placement and alt text.

## Important

- Always prefer the built-in GitHub CLI `--attach` functionality.
- Do not use any third-party extension or third-party upload tool.
- `--attach` may be repeated for multiple files.
- Preserve generated attachment URLs when subsequently editing the PR body.