# FAVMOA development workflow

## Commit and push after verified changes

The user has requested that completed changes in this repository be committed
and pushed promptly, without requiring a separate push request each time.

- Complete and verify the requested change, then commit only its relevant files
  and push the current branch to `origin`. The current release branch is `main`;
  follow any explicit user request to use a different branch or pull request.
- Preserve unrelated working-tree changes. Do not commit unrelated work merely
  to obtain a clean working tree.
- Run `npm test` and `npm run check:extension-package` for extension changes.
  For a release, increment the patch version, build the ZIP, and verify it with
  the packaging script before reporting the release ready.
- This is a public repository. Check the staged diff for secrets and private
  identifiers. Keep signing keys, local credentials, profiles, personal data,
  generated artifacts, and installation backups out of commits. Use synthetic
  identifiers in regression fixtures.
- Check the destination before pushing; never force-push or overwrite remote
  work. If tests, authentication, or remote changes block delivery, report the
  blocker instead of claiming the push succeeded.
- After pushing, verify the remote branch points to the local commit and report
  the commit link. Distinguish tests, package verification, installation checks,
  and actual extension runtime validation.

This standing workflow does not authorize publishing to the Chrome Web Store,
changing access permissions, or uploading ignored release artifacts.
