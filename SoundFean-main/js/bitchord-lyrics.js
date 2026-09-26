// Transport for the BitChord provider chain. No playback or audio requests.
import { getTrackArtists } from './utils.js';

const cache = new Map();
const pending = new Map();

function backendUrl() {
    // Follow the existing local backend setting without changing the audio resolver.
    let base = '';
    try { base = (localStorage.getItem('yt-resolve-base') || '').trim(); } catch { /* storage disabled */ }
    if (base && !/^https?:\/\//i.test(base)) base = 'http://' + base.replace(/^\/+/, '');
    return base.replace(/\/$/, '') + '/api/bitchord-lyrics';
}

export async function fetchBitChordLyrics(track, { videoId = '', signal } = {}) {
    const artist = getTrackArtists(track);
    if (!track?.title || !artist || signal?.aborted) return null;
    const appleId = track.appleMusicId || (String(track.id).startsWith('apple:track:') ? String(track.id).slice(12) : '');
    const params = new URLSearchParams({ title: track.title, artist,
        album: typeof track.album === 'string' ? track.album : track.album?.title || '',
        duration: String(Math.max(0, Math.round(Number(track.duration) || 0))) });
    if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) params.set('videoId', videoId);
    if (track.isrc) params.set('isrc', track.isrc);
    if (appleId) params.set('appleId', appleId);
    const key = params.toString();
    if (cache.has(key)) return cache.get(key);
    let entry = pending.get(key);
    if (!entry) {
        const controller = new AbortController();
        entry = { controller, readers: 0 };
        const timeout = setTimeout(() => controller.abort(), 30000);
        entry.promise = (async () => {
            const response = await fetch(`${backendUrl()}?${params}`, { signal: controller.signal });
            if (response.status === 404) return null;
            if (!response.ok) throw new Error('Lyrics service unavailable. Please try again.');
            const data = await response.json();
            if (!data?.ttml || !data.lineCount) return null;
            if (cache.size >= 100) cache.delete(cache.keys().next().value);
            cache.set(key, data);
            return data;
        })().finally(() => {
            clearTimeout(timeout);
            if (pending.get(key) === entry) pending.delete(key);
        });
        pending.set(key, entry);
    }
    entry.readers++;
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            entry.readers--;
            if (!entry.readers && pending.get(key) === entry) {
                entry.controller.abort();
                pending.delete(key);
            }
            fn(value);
        };
        const onAbort = () => finish(resolve, null);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
}
