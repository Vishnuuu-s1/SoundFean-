# YouTube Playback Integration (SoundFean)

## Goal

- **Keep** all existing Tidal metadata, album artwork, search UI, player chrome, queue, playlists.
- **Change only** the audio/video source: resolve each Tidal track to a matching YouTube/YouTube Music video and play it via the **official YouTube IFrame Player API**.

Displayed fields (`title`, `artist`, `album`, `cover` / Tidal image IDs) are never replaced with YouTube thumbnails or titles.

---

## Architecture

```
Tidal metadata (unchanged)
        │
        ▼
  /api/resolve-track   ← backend (Python + ytmusicapi)
        │
        ▼
  youtubeVideoId + playbackSource: "youtube"
        │
        ▼
  YouTube IFrame API   → SoundFean player controls
```

---

## Files added / modified

| Path | Change |
|------|--------|
| `backend/resolve_server.py` | **New** – Flask resolver using ytmusicapi + SQLite cache |
| `backend/requirements.txt` | **New** – `ytmusicapi`, `flask`, `flask-cors` |
| `js/yt-resolve.js` | **New** – frontend client for `/api/resolve-track` |
| `js/yt-player.js` | **New** – IFrame API wrapper |
| `js/player.js` | **Minimal** – import + YouTube branch in `playTrackFromQueue`, volume/seek/play-pause routing |

No changes to:

- Tidal cover URL helpers (`getCoverUrl` / `getCoverSrcset`)
- Search / album / artist pages
- Song object shape for display
- Now-playing layout CSS

---

## Setup

### 1. Start the resolve backend

```bash
cd backend
pip install -r requirements.txt
# Optional: use the provided ytmusicapi zip as editable install:
#   pip install /path/to/ytmusicapi-1.12.2
python resolve_server.py
# listens on http://127.0.0.1:8765
```

Health check: `GET http://127.0.0.1:8765/health`

### 2. Enable YouTube playback in the client

In the browser console (or your settings UI):

```js
localStorage.setItem('playback-source', 'youtube');
// optional custom backend:
localStorage.setItem('yt-resolve-base', 'http://127.0.0.1:8765');
location.reload();
```

To switch back to Tidal streams:

```js
localStorage.setItem('playback-source', 'tidal');
location.reload();
```

### 3. Run SoundFean as usual

```bash
bun install   # or npm install
bun run dev   # or npm run dev
```

---

## Resolve API

`POST /api/resolve-track`

```json
{
  "title": "Song Name",
  "artist": "Artist Name",
  "album": "Album Name",
  "cover": "<original tidal cover id or url>"
}
```

Success:

```json
{
  "title": "Song Name",
  "artist": "Artist Name",
  "album": "Album Name",
  "cover": "<ORIGINAL – never replaced>",
  "youtubeVideoId": "dQw4w9WgXcQ",
  "playbackSource": "youtube",
  "confidence": 0.91,
  "ytTitle": "...",
  "ytArtist": "...",
  "cached": false
}
```

No confident match:

```json
{
  "unavailable": true,
  "reason": "no confident YouTube match",
  "title": "...",
  "artist": "...",
  "cover": "..."
}
```

The player **does not** play a random substitute; it marks the track unavailable and advances.

Successful matches are cached in SQLite (`yt_resolve_cache.sqlite`) so the same title/artist is not re-searched every time.

---

## Behaviour notes

- **Official / song results preferred** – search uses YT Music `songs` filter first; scoring favours title+artist match and song result type.
- **Player controls** – play/pause, next, previous, seek, volume, queue, and progress are wired to the IFrame player when `playback-source=youtube`.
- **Crossfade / Shaka / ReplayGain** – not applied on the YouTube path (different media surface). Native Tidal path is unchanged when YouTube mode is off.
- **API keys** – none required for unauthenticated YT Music search via ytmusicapi. Backend stays off the frontend bundle.

---

## Compliance

Playback uses the **YouTube IFrame Player API** only. Stream URLs are not scraped or proxied. Matching uses ytmusicapi search (public Innertube-style endpoints), not unauthorized download endpoints.
