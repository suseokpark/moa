# FAVMOA 0.1.10 validation

Date: 2026-09-22 (Asia/Seoul)

## Evidence boundaries

- Automated Node tests: **277 passed, 0 failed** (`node --test`). Chrome APIs and Google responses are mocked where applicable.
- Legacy Notion browser suite: **8/8 passed**, running the actual packaged UI sources against synthetic Notion DOM fixtures, not a live Notion account.
- New side-panel UI: exercised in Ego Lite at `http://127.0.0.1:4175/extension/notion-favorite-sections/sidepanel/sidepanel.html`. This is explicitly a loopback demo with synthetic current-page and bookmark data, **not proof of installed Chrome-extension execution**.
- No Google sign-in, OAuth consent, Drive upload/download, or cross-device run was performed. The supplied OAuth client is a web-application client; the release intentionally has no `oauth2` manifest configuration.
- Automatic cloud merge/sync and Drive child-folder exploration are not implemented in this release.

## Side-panel browser checks

1. First-link empty-state action opens an add dialog and saves the synthetic current page. A browser tab ID is not reused as a saved link ID.
2. Group and section creation, current-page movement into `업무 > 프로젝트`, and a separate Drive folder URL save succeed.
3. Duplicate current-page save shows the existing destination without adding another record.
4. Folding the current group works during the session; search reveals matching descendants. Search by section name returns both links; an unmatched query displays the empty state.
5. Reload retains saved links and expands the ancestors of the current page with a `현재` indicator.
6. Optional bookmark import presents selection; selecting the synthetic candidate adds only that link.
7. JSON export downloads a compact `favmoa-backup` envelope containing all libraries.
8. Reset requires confirmation with library name and link count. Undo restores all three synthetic links and becomes unavailable after use.
9. Restoring the exported JSON requires a separate whole-catalog replacement confirmation and restores the three links.
10. Google connection is disabled in the hosted demo. The extension's unconfigured OAuth response is covered separately by mocked service tests.
11. Light theme at 400px and dark theme at 320px were visually inspected. Document width equals viewport width at 320px. CSS 200% zoom in a 640px viewport also had no horizontal document overflow (not a full accessibility audit or native browser zoom test).

Synthetic evidence files, excluded from the extension ZIP:

- `artifacts/qa/favmoa-demo-backup.json`
- `artifacts/qa/favmoa-400-light.png`
- `artifacts/qa/favmoa-320-dark.png`

## Regression fixes from review

- Empty-state current-page insertion strips Chrome tab identity before opening the saved-link editor.
- Local JSON exports are compact; file import allows 6 MiB for the maximum validated 5 MiB catalog plus envelope. Cloud backup has a separate explicit 4 MiB limit and does not mutate local data when exceeded.
- Validation repairs genuine empty group/section arrays with an empty default destination, without modifying the input or existing populated tree. Invalid or colliding IDs remain errors.
- Corrupt local storage cannot be uploaded as an empty cloud backup.
- Ambiguous upload network/server outcomes instruct the user to inspect the remote backup list before retrying.
- Tokens never enter the UI response or extension storage. Existing legacy data remains under its original keys; migration is explicit, copied, and idempotent.

## Package

- Artifact: `artifacts/favmoa-v0.1.10.zip`
- Manifest version: `0.1.10`; minimum Chrome version: `116`.
- Runtime allowlist: 27 files. Test fixtures, demo storage, QA screenshots, docs, and client secrets are not packaged.
- Run `npm run check:extension-package` and `node extension/notion-favorite-sections/scripts/package-extension.mjs --verify artifacts/favmoa-v0.1.10.zip` to re-check source/archive consistency.

## Remaining acceptance checks

1. Update the existing unpacked installation **in the same directory** and confirm its extension ID remains unchanged; do not uninstall first.
2. Verify the real Chrome side panel, active-page detection, existing-tab focus, and optional bookmark permission prompt.
3. With that exact extension ID, configure a Chrome Extension OAuth client, enable Drive API, and complete any required test-user setup. A client secret is not needed.
4. Verify sign-in, account confirmation, one manual backup, list/read/confirmed restore on another browser, permission denial, and expired authentication with actual Google accounts.
5. Verify current live Notion DOM compatibility independently of the synthetic 8/8 regression suite.
