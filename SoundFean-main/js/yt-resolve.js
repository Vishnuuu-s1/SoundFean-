/**
 * YouTube track resolver client for SoundFean.
 *
 * Does NOT replace Tidal metadata or cover art.
 * Only fetches a matching youtubeVideoId for playback.
 *
 * Backend: backend/resolve_server.py  (default http://127.0.0.1:8765)
 * Override with localStorage key: yt-resolve-base
 */

const DEFAULT_BASE = '';
const MEMORY_CACHE = new Map(); // trackId or title|artist → result

function getBaseUrl() {
    try {
        let base = localStorage.getItem('yt-resolve-base') || DEFAULT_BASE;
        base = (base || '').trim();
        // If user saved without scheme, force http so fetch is not relative to Vite
        if (base && !/^https?:\/\//i.test(base)) {
            base = 'http://' + base.replace(/^\/+/, '');
        }
        return base || DEFAULT_BASE;
    } catch {
        return DEFAULT_BASE;
    }
}

function artistsToString(track) {
    if (!track) return '';
    if (typeof track.artist === 'string' && track.artist) return track.artist;
    if (Array.isArray(track.artists) && track.artists.length) {
        return track.artists
            .map((a) => (typeof a === 'string' ? a : a?.name))
            .filter(Boolean)
            .join(', ');
    }
    if (track.artist?.name) return track.artist.name;
    return '';
}

function trackCacheKey(track) {
    if (track?.id) return `id:${track.id}`;
    const title = track?.title || '';
    const artist = artistsToString(track);
    return `ta:${title}|${artist}`;
}

/**
 * Resolve a Tidal-metadata track to a YouTube video id.
 * Returns the original metadata fields unchanged, plus youtubeVideoId / playbackSource.
 * On failure returns { unavailable: true, reason }.
 */
export async function resolveTrackToYouTube(track, options = {}) {
    if (!track) {
        return { unavailable: true, reason: 'no track' };
    }

    // Already resolved on this object
    if (track.youtubeVideoId && track.playbackSource === 'youtube') {
        return {
            title: track.title,
            artist: artistsToString(track),
            album: track.album?.title || track.album || '',
            cover: track.image || track.cover || track.album?.cover,
            youtubeVideoId: track.youtubeVideoId,
            playbackSource: 'youtube',
            confidence: track.ytConfidence,
            cached: true,
        };
    }

    const key = trackCacheKey(track);
    if (!options.force && MEMORY_CACHE.has(key)) {
        return MEMORY_CACHE.get(key);
    }

    const title = track.title || track.name || '';
    const artist = artistsToString(track);
    const album =
        (typeof track.album === 'string' ? track.album : track.album?.title || track.album?.name) || '';
    const cover = track.image || track.cover || track.album?.cover || null;

    const base = getBaseUrl().replace(/\/$/, '');
    const url = `${base}/api/resolve-track`;

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, artist, album, cover }),
        });

        const data = await res.json();

        if (!res.ok || data.unavailable || !data.youtubeVideoId) {
            const fail = {
                unavailable: true,
                reason: data.reason || `HTTP ${res.status}`,
                title,
                artist,
                album,
                cover,
            };
            // Don't cache hard failures for long; allow retry later
            return fail;
        }

        const ok = {
            title: data.title ?? title,
            artist: data.artist ?? artist,
            album: data.album ?? album,
            cover: data.cover ?? cover, // ORIGINAL Tidal cover — never overwrite
            youtubeVideoId: data.youtubeVideoId,
            playbackSource: 'youtube',
            confidence: data.confidence,
            ytTitle: data.ytTitle,
            ytArtist: data.ytArtist,
            cached: !!data.cached,
        };
        MEMORY_CACHE.set(key, ok);
        return ok;
    } catch (err) {
        console.warn('[yt-resolve] backend unreachable:', err);
        return {
            unavailable: true,
            reason: 'resolve backend unreachable',
            title,
            artist,
            album,
            cover,
        };
    }
}

/**
 * Attach YouTube ids onto a track object in-place WITHOUT changing displayed fields.
 */
export async function attachYouTubeId(track) {
    if (!track || track.youtubeVideoId) return track;
    const resolved = await resolveTrackToYouTube(track);
    if (resolved.unavailable) {
        track.ytUnavailable = true;
        track.ytUnavailableReason = resolved.reason;
        return track;
    }
    track.youtubeVideoId = resolved.youtubeVideoId;
    track.playbackSource = 'youtube';
    track.ytConfidence = resolved.confidence;
    // Do NOT touch title, artist, album, cover/image
    return track;
}

export function isYouTubePlaybackEnabled() {
    try {
        // Default ON (YouTube). Only off if user explicitly set tidal.
        const v = localStorage.getItem('playback-source');
        if (v === 'tidal') return false;
        return true;
    } catch {
        return true;
    }
}

export function setYouTubePlaybackEnabled(enabled) {
    try {
        localStorage.setItem('playback-source', enabled ? 'youtube' : 'tidal');
    } catch {
        /* ignore */
    }
}
