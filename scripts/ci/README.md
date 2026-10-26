# macOS signing assets

The macOS build already imports the Developer ID identity and notarizes the app.
Data Protection Keychain additionally requires a Developer ID provisioning profile
for `com.crystal.design`, matching that identity and its team.

Add repository secret `APPLE_PROVISIONING_PROFILE_BASE64` in `crystal-inc/crystal-releases`:
base64 of the complete `.provisionprofile` file, not a development profile or a
certificate. Never commit its contents. Existing certificate and notarization
configuration stays unchanged.

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
