# FAVMOA 0.1.12 — OAuth client configuration

Date: 2026-09-22 KST.

## Change

- Registered the newly user-supplied public OAuth client ID in `manifest.oauth2`: `24454578838-6nqb1s33u6djs6inpn2jud1nfq0ojevn.apps.googleusercontent.com`.
- OAuth scopes are exactly `openid`, `email`, and `https://www.googleapis.com/auth/drive.appdata`. No general Drive file-read scope or client secret is included.
- The earlier web-application client was not reused.
- Public key, pinned hash, extension ID `ebbgmhdbonpillbfjapebljagnbjembj`, and storage keys are unchanged from 0.1.11.
- Updated the current UI and help from “configuration pending” to “configuration present, real-account verification pending.” The local browser preview still cannot start OAuth.
- Removed an unused platform-level connection-status placeholder that always claimed configuration was missing. The UI already uses the dedicated cloud status service.

## Verification

- **288 Node tests passed, 0 failed**, including **30 cloud-service/client tests** and the existing identity/package checks.
- Tests read the actual release manifest and check the new client ID, exact scopes, and unchanged derived extension ID.
- A configured but disconnected `STATUS` request performs no authentication, network request, catalog change, or upload.
- Explicit `CONNECT` requests interactive authorization and a mocked identity lookup only; it does not upload links.
- Cancellation and missing permission preserve the local catalog. Existing token non-disclosure, account-change, stale revision, immutable backup, and size-limit tests continue to pass.
- The browser-preview client refuses real Google operations. Extension messaging uses the expected flat payloads for connect, disconnect, upload, list, and read.
- Package validation still limits runtime distribution to 27 files. Version/manifest/help consistency is tested.

## Evidence boundary / remaining checks

This run did **not** inspect Google Cloud credentials, sign in to an actual Google account, grant consent, enable an API, or read/write Drive. A client ID's text cannot prove its Cloud application type, Item ID binding, consent-screen/test-user settings, or Drive API enablement. These remain real-account acceptance checks; “configured” is not “authenticated.” No new browser UI run is claimed for this configuration patch.

To verify:

1. If already on keyed 0.1.11, preserve the installation directory, replace runtime files with 0.1.12, and reload the existing extension. Confirm the same ID and version. Do not uninstall.
2. If still on unkeyed 0.1.10 or older, follow [the backup/migration procedure](EXTENSION-IDENTITY.md) before changing IDs.
3. Open the **installed extension**, not the localhost preview. Under **가져오기 · 백업 · 설정**, choose **Google 계정 연결** and approve the intended account/scopes.
4. If blocked, check the Cloud client is Chrome Extension type with Item ID `ebbgmhdbonpillbfjapebljagnbjembj`, Drive API is enabled, and the account is allowed by the app audience/organization policy. No OAuth client secret is required in the extension.
5. After connecting, confirm the destination account and explicitly upload one manual backup. Then list/read it and, only after exporting any local changes, confirm restore in a separate test installation.

Google connection alone does not sign into Notion. Automatic multi-device synchronization, conflict merging, and Drive child-folder exploration are still out of scope for this release.
