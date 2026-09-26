// Queue-only web adaptation of BitChord QueueBuilder, QueueCoordinator and
// QueueShuffle. GPL-3.0; see BITCHORD-NOTICE.md and licenses/BitChord-GPL-3.0.txt.
export const QueueTier = Object.freeze({ USER: 'USER_QUEUE', CONTEXT: 'CONTEXT', AUTO: 'AUTOPLAY' });
export const MAX_AUTOPLAY = 10;
let serial = 0;

export function queueEntry(track, tier = QueueTier.CONTEXT, fresh = false) {
    return { ...track, _queueTier: tier, _queueEntryId: (!fresh && track._queueEntryId) ||
        globalThis.crypto?.randomUUID?.() || `sf-${Date.now()}-${++serial}` };
}

export function titleKey(raw) {
    return String(raw || '').normalize('NFKC').toLowerCase()
        .split(' | ')[0].replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
        .replace(/\s+[-–—|]\s+.*\b(?:remix|mix|version|cover|slowed|reverb|sped\s*up|remaster(?:ed)?|instrumental|acoustic|edit|live|reprise|lo[ -]?fi|unplugged|hindi|tamil|telugu|malayalam|kannada|english)\b.*$/g, ' ')
        .replace(/\b(?:official (?:video|audio|music video)|lyrical video|full video|4k video)\b/g, ' ')
        .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').replace(/\s+/g, ' ').trim()
        .replace(/\s+(?:(?:remix|reprise|version|cover|slowed|reverb|lo\s?fi|sped\s*up|instrumental|acoustic|mashup|remaster(?:ed)?|unplugged)\s*)+$/g, '').trim();
}

export function artistSet(track) {
    const credits = track.artists?.length ? track.artists : [track.artist];
    return new Set(credits.flatMap(a => String(a?.name || a || '').toLowerCase()
        .replace(/\s*-\s*topic\b/g, ' ').split(/,|&|·|•|;| feat\.? | ft\.? | x | with /))
        .map(a => a.replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim()).filter(Boolean));
}

export function sameRecording(a, b) {
    if (String(a.id) === String(b.id)) return true;
    if (a.isrc && b.isrc && a.isrc.toUpperCase() === b.isrc.toUpperCase()) return true;
    // SoundFean also suppresses same-title covers/versions, as requested.
    const title = titleKey(a.title);
    return Boolean(title && title === titleKey(b.title));
}

export function extendQueue(existing, candidates, limit, seed = existing.at(-1), blocked = () => false) {
    const seedArtists = seed ? artistSet(seed) : new Set();
    const perArtist = new Map();
    const out = [];
    for (const track of candidates || []) {
        if (out.length >= limit) break;
        if (!track?.id || !titleKey(track.title) || track.isUnavailable || track.isLocal ||
            track.isPodcast || track.isVideo || track.type === 'video' || blocked(track)) continue;
        if ([...existing, ...out].some(queued => sameRecording(queued, track))) continue;
        const artists = artistSet(track);
        if ([...artists].some(a => (perArtist.get(a) || 0) >= (seedArtists.has(a) ? 4 : 2))) continue;
        artists.forEach(a => perArtist.set(a, (perArtist.get(a) || 0) + 1));
        out.push(track);
    }
    return out;
}

export function contextQueue(old, index, tracks, start = 0) {
    if (!tracks.length) return { tracks: [], index: -1 };
    const manual = old.slice(Math.max(0, index + 1)).filter(t => t._queueTier === QueueTier.USER);
    const context = tracks.map(t => queueEntry(t, QueueTier.CONTEXT, true));
    start = Math.max(0, Math.min(context.length - 1, start));
    return { tracks: [...context.slice(0, start + 1), ...manual, ...context.slice(start + 1)], index: start };
}

export function insertionIndex(queue, current, next = false) {
    let index = Math.max(0, current + 1);
    if (!next) while (queue[index]?._queueTier === QueueTier.USER) index++;
    return index;
}

export function jumpQueue(queue, current, target) {
    if (target <= current || !queue[target]) return null;
    const track = queue[target];
    const future = queue.slice(current + 1);
    const after = queue.slice(target + 1);
    const manual = (track._queueTier === QueueTier.USER ? after : future).filter(t => t._queueTier === QueueTier.USER);
    const context = (track._queueTier === QueueTier.USER ? future : after).filter(t => !t._queueTier || t._queueTier === QueueTier.CONTEXT);
    const auto = (track._queueTier === QueueTier.USER ? future : after).filter(t => t._queueTier === QueueTier.AUTO);
    return [...queue.slice(0, current + 1), queueEntry(track, track._queueTier === QueueTier.AUTO ? QueueTier.CONTEXT : track._queueTier),
        ...manual, ...(track._queueTier === QueueTier.AUTO ? [] : context), ...auto];
}

function shuffled(items) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    if (out.length > 1 && out.every((t, i) => t === items[i])) out.push(out.shift());
    return out;
}

export function shuffleUpcoming(queue, current, original = null) {
    const upcoming = queue.slice(current + 1);
    const order = original && new Map(original.map((t, i) => [t._queueEntryId, i]));
    const arrange = section => order ? section.sort((a, b) =>
        (order.get(a._queueEntryId) ?? Infinity) - (order.get(b._queueEntryId) ?? Infinity)) : shuffled(section);
    return [...queue.slice(0, current + 1), ...upcoming.filter(t => t._queueTier === QueueTier.USER),
        ...arrange(upcoming.filter(t => !t._queueTier || t._queueTier === QueueTier.CONTEXT)),
        ...arrange(upcoming.filter(t => t._queueTier === QueueTier.AUTO))];
}

const interleave = groups => {
    const out = [];
    for (let i = 0; i < Math.max(0, ...groups.map(g => g.length)); i++) groups.forEach(g => { if (g[i]) out.push(g[i]); });
    return out;
};

function bounded(request, milliseconds = 12000) {
    let timer;
    return Promise.race([request, new Promise(resolve => { timer = setTimeout(() => resolve([]), milliseconds); })])
        .finally(() => clearTimeout(timer));
}

// Supplies catalog metadata only. It never resolves, loads, pauses or seeks audio.
export class BitChordStation {
    constructor(api, blocked) {
        this.api = api;
        this.blocked = blocked;
        this.pool = [];
        this.generation = 0;
        this.pending = null;
        this.lastAttempt = null;
    }

    reset() {
        this.generation++;
        this.pool = [];
        this.lastAttempt = null;
        this.pending = null;
    }

    async candidates(queue, current, seeds = []) {
        if (this.pending) return this.pending;
        const generation = this.generation;
        const seed = queue[current];
        if (!seed || seed.isLocal || seed.isPodcast || seed.type === 'video') return [];
        const knownTrackIds = new Set(queue.map(t => String(t.id)));
        const selectedSeeds = [seed, ...seeds, ...queue.slice(Math.max(0, current - 2), current).reverse()]
            .filter((t, i, all) => t?.id && all.findIndex(x => String(x.id) === String(t.id)) === i).slice(0, 3);
        this.lastAttempt = seed._queueEntryId || String(seed.id);
        const work = (async () => {
            let candidates = [...this.pool];
            let selected = extendQueue(queue, candidates, MAX_AUTOPLAY, seed, this.blocked);
            if (selected.length < MAX_AUTOPLAY) {
                const recommended = await bounded(this.api.getRecommendedTracksForPlaylist(selectedSeeds, 80, { knownTrackIds, retryOnRateLimit: false }))
                    .catch(() => []);
                if (generation !== this.generation) return [];
                candidates.push(...recommended);
                selected = extendQueue(queue, candidates, MAX_AUTOPLAY, seed, this.blocked);
            }
            if (selected.length < MAX_AUTOPLAY) {
                const artists = [...new Map(selectedSeeds.flatMap(t => [t.artist, ...(t.artists || [])])
                    .filter(a => a?.id).map(a => [String(a.id), a])).values()].slice(0, 3);
                const related = await Promise.allSettled(artists.map(a => bounded(this.api.getSimilarArtists(a.id), 8000)));
                if (generation !== this.generation) return [];
                const similar = [...new Map(interleave(related.map(r => r.status === 'fulfilled' ? r.value || [] : []))
                    .filter(a => a?.id).map(a => [String(a.id), a])).values()].slice(0, 6);
                const tops = await Promise.allSettled(similar.map(a => bounded(this.api.getArtistTopTracks(a.id, { limit: 20 }), 8000)));
                if (generation !== this.generation) return [];
                candidates.push(...interleave(tops.map(r => r.status === 'fulfilled' ? r.value?.tracks || [] : [])));
            }
            if (generation !== this.generation) return [];
            // Keep unused candidates for later refills; no ever-growing network/queue fan-out.
            this.pool = [...new Map(candidates.map(t => [String(t.id), t])).values()].slice(-240);
            return candidates;
        })();
        this.pending = work;
        try { return await work; }
        finally { if (this.pending === work) this.pending = null; }
    }
}
