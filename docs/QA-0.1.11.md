# FAVMOA 0.1.11 — extension identity validation

Date: 2026-09-22 KST. This patch pins the unpacked extension's development ID; it does not configure OAuth or publish to the Chrome Web Store.

## Results

- Node test suite: **281 passed / 0 failed**, including **12 packaging tests**.
- Manifest public key is a canonical base64 DER SPKI RSA 2048-bit public key.
- Derived extension ID: `ebbgmhdbonpillbfjapebljagnbjembj`.
- Pinned SHA-256: `4116c731edf8bb1590f41b906d194c19ed573841798846e40697095511fe5810`.
- Packaging validates both the full public-key digest and the derived ID against `extension-identity.json`.
- Relocated-source test copies the extension to two independent temporary paths. Both produce the same derived ID and byte-identical package.
- Regression tests reject a missing key/pin, malformed base64, private key data, PKCS#1 data, trailing bytes, short RSA keys, and changed key/ID/hash pins.
- Runtime ZIP allowlist remains 27 files, with no identity-pin file, tests, scripts, or private keys included.
- The local signing private key is outside the extension root, under Git-ignored `.private/`, with directory mode 700 and file mode 600. It was not printed or published.

## Data-safety boundary

- The original Vestigium/Moa 0.1.9 source and the existing unkeyed 0.1.10 ZIP were left intact.
- No installed extension was reloaded, removed, or migrated, and no user browser data was read or changed.
- Existing unkeyed installs have a different ID. The 0.1.11 README/help prescribe export before a separate installation, not in-place key replacement.
- For 0.1.9, migration requires unkeyed 0.1.10 in the original installation path, explicit legacy import into the universal catalog, then JSON export/import. Raw legacy Notion stores do not cross the ID boundary through catalog export.

## Not verified by this patch

- Live installation in Chrome or on a second computer. ID derivation and relocation were verified at the source/package level only.
- Google OAuth consent, real Drive backup/restore, or automatic synchronization. OAuth remains unconfigured.
- Preservation of this locally generated ID in a future Chrome Web Store listing. Compare the actual store Item ID/public key during that separate release workflow.

See [migration and key-handling instructions](EXTENSION-IDENTITY.md). Previous UI/fixture evidence remains separately recorded in [0.1.10 QA](QA-0.1.10.md), not counted as a fresh browser run for this patch.
