# macOS signing assets

The macOS build already imports the Developer ID identity and notarizes the app.
Data Protection Keychain additionally requires a Developer ID provisioning profile
for `com.crystal.design`, matching that identity and its team.

Add repository secret `APPLE_PROVISIONING_PROFILE_BASE64` in `crystal-inc/crystal-releases`:
base64 of the complete `.provisionprofile` file, not a development profile or a
certificate. Never commit its contents. Existing certificate and notarization
configuration stays unchanged.

Repository settings used by macOS signing:

| Setting | Kind | Value |
| --- | --- | --- |
| `APPLE_PROVISIONING_PROFILE_BASE64` | Secret | Base64 of the production Developer ID `.provisionprofile`. |
| `APPLE_CERTIFICATE` | Secret | Base64 of the existing Developer ID Application `.p12`, including its private key. |
| `APPLE_CERTIFICATE_PASSWORD` | Secret | Password protecting that `.p12`. |
| `APPLE_ID` | Secret | Apple Account used for notarization. |
| `APPLE_PASSWORD` | Secret | App-specific password for notarization. |
| `APPLE_SIGNING_IDENTITY` | Variable | Full Developer ID Application certificate name. |
| `APPLE_TEAM_ID` | Variable | The certificate and profile's Apple Developer team ID. |

Only `APPLE_PROVISIONING_PROFILE_BASE64` is new. The existing updater secrets
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` remain required.
Development profiles and Apple Development private keys are not used by release CI.

`npm run ci -- apple-profile` stages it as
`$RUNNER_TEMP/crystal-signing.provisionprofile` with owner-only read/write access.
It checks that Security.framework can decode the CMS envelope, then exports
`APPLE_PROVISIONING_PROFILE` as a path through `GITHUB_ENV` for packaging. Crystal's
native build validates app ID, team, certificate, platform and expiration and
embeds the profile in the signed main app. CI does not duplicate those rules.
The existing `always()` cleanup removes the staged profile on success or failure.
It is outside all dependency caches and the loose-file artifact allowlist.
The signed app itself includes its required profile.

This workflow change is prepared for the native Data Protection Keychain change.
Configure the real profile and test both changes together before merging or
publishing. No Apple-account login, profile creation, secret update or workflow
execution is performed by this code change.

## Optional Crystal analytics

Set these **Actions Variables in crystal-inc/crystal-releases**, not only in the application repository:

| Variable | Purpose |
| --- | --- |
| `VITE_ANALYTICS_MODE` | `local` by default; change to `remote` only after the matching application/server changes, privacy gates and smoke tests are ready |
| `VITE_POSTHOG_KEY` | Public write-only PostHog project token |
| `VITE_POSTHOG_HOST` | EU ingestion host (`https://eu.i.posthog.com`) unless using an explicitly configured proxy |
| `VITE_SENTRY_DSN` | Public client DSN for the intended Sentry project |
| `SENTRY_ORG`, `SENTRY_PROJECT` | Sentry organization and project slugs |

Store the private symbol-upload token as the **Actions Secret `SENTRY_AUTH_TOKEN`**. It is available only to the packaging step, never as `VITE_` data. The workflow derives `VITE_APP_BUILD` from its prepared version and immutable source commit; both architectures, JavaScript and Rust use the same identity.

The environment wrapper removes GitHub's empty optional values. In local mode it also removes the Sentry upload token, so merely adding credentials does not start uploads. Remote mode requires all SDK endpoints, project identifiers and upload credentials, and fails before packaging if incomplete. The wrapper preserves the child's exit status and never prints credential values. This does not initiate a build or enable collection on its own.

### Activation checklist

- [ ] Sentry project/DSN and release-upload token configured (no dummy secrets).
- [ ] Matching analytics application and private-server changes included in the source revision.
- [ ] OVH `/etc/crystal/api.env` configured separately: PostHog export and Sentry admission, verified supplier periods and fixed shared quotas. The code deployment does not overwrite this file.
- [ ] Required privacy/retention/erasure gates completed before real-user collection.
- [ ] Signed test build verifies actual event receipt, symbolication, offline/restart and exhausted budgets.
- [ ] Explicitly switch `VITE_ANALYTICS_MODE` to `remote` and build a new release. Local `.env.local` files are not uploaded to CI; changing a variable does not modify existing installers.
