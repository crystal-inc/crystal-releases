# macOS distribution signing

Both architecture jobs sign Crystal with Developer ID and notarize the app and
DMG before preparing upload artifacts. The updater archive contains the final
signed app and its stapled notarization ticket; its Tauri updater signature is
independent of Apple code signing. New build artifacts with ad-hoc signing are
rejected. Existing channel releases can still be promoted without rebuilding.

## Repository configuration

Set these GitHub Actions secrets in `crystal-inc/crystal-releases`:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` export of the Developer ID Application certificate and its private key |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting that `.p12` export |
| `APPLE_ID` | Apple Account used for notarization |
| `APPLE_PASSWORD` | App-specific password for that account |

Set these GitHub Actions variables in the same repository:

| Variable | Value |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | Full certificate name, `Developer ID Application: … (TEAMID)` |
| `APPLE_TEAM_ID` | The team identifier from that certificate |

The existing `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets remain required for updater signing.

Export only the intended signing identity, not every identity in a login
keychain. Keep its private key and all passwords out of source control. The
workflow imports the identity into a temporary keychain, authorizes code-signing
tools without an interactive prompt, and checks the notarization credentials
before compiling. An unconditional cleanup step removes the export and keychain
after success or failure. The keychain's random password exists only for that job.

## Identity across updates

Every release must retain the `com.crystal.design` bundle identifier and a
compatible Developer ID signing requirement from the same Apple team. The
private packaging code checks the canonical identifier before notarization.
Both architecture jobs use the same configured signing identity and source commit.

Switching an existing installation from an ad-hoc signature can require a
one-time Keychain authorization. Verify access again after updating from one
Developer ID-signed release to another; notarization alone does not preserve
Keychain access. Development apps retain their separate identifiers and signing.

Run a manual test build on the signing branch before merging. Confirm both
architecture jobs complete signing, notarization and stapling, then test the
installed app across a subsequent signed update. Test builds do not change a
published channel.
