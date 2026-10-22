# Qobuz Germany addon for Bit-Perfect

This is a separate route/service for the existing SoundFean Vercel project. It does not replace US/GB/original addon files.

## Files
- `qobuz-de-addon/api/index.js`
- `qobuz-de-addon/package.json`
- `qobuz-de-addon/test/api.test.js`
- `vercel-qobuz-de-snippet.json` (merge these entries into existing `vercel.json`; do not replace the whole file)

## Vercel environment variables
Create Production (and Preview if needed) variables:
- `QOBUZ_DE_APP_ID`
- `QOBUZ_DE_APP_SECRET`
- `QOBUZ_DE_USER_AUTH_TOKEN`
- `QOBUZ_DE_ACCESS_KEY` (generate a fresh random secret)

Never put real credentials in GitHub or in URLs shared publicly. Since tokens previously pasted into chats may be exposed, rotate/reissue them before deployment.

## Route / tests
After merging the service + rewrite entries and redeploying:
- `https://soundfean-music.vercel.app/qobuz-de/health`
- `https://soundfean-music.vercel.app/qobuz-de/a/YOUR_ACCESS_KEY/manifest.json`
- `https://soundfean-music.vercel.app/qobuz-de/a/YOUR_ACCESS_KEY/search?q=dracula`

The addon calls Qobuz's API using the supplied app ID and account token. Actual search/streaming still depends on Qobuz authorizing the account and app. A health response only confirms the server is running/configured, not that Qobuz accepts the token.

## Downloads
The manifest intentionally sets `allowDownloads: 0`: a Qobuz Studio subscription and a stream URL do not establish rights to export permanent FLAC files. Do not flip this flag to bypass source authorization. This addon provides search and authorized streaming; add a distinct provider-approved purchase/download flow if available.

## Local tests
From `qobuz-de-addon`, run `npm test` on Node.js 20+.
