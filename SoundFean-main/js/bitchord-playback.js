// BitChord audio transport only. Catalog metadata and queues remain in SoundFean.
export async function resolveBitChordPlayback(videoId, { signal } = {}) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) throw new Error('No playable YouTube match.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 90000);
    try {
        const response = await fetch('/api/bitchord-playback/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId }),
            signal: controller.signal,
        });
        const info = await response.json().catch(() => ({}));
        if (!response.ok || info.error) {
            const messages = {
                playback_runtime_missing: 'The BitChord playback backend needs the updated requirements file.',
                playback_adapter_missing: 'Upload the complete BitChord playback backend folder, then redeploy.',
                playback_busy: 'Playback is busy. Please try this song again.',
                restricted_content: 'This track is unavailable.',
            };
            throw new Error(messages[info.error] || 'BitChord could not load this audio stream. Please try again.');
        }
        if (typeof info.url !== 'string' || !info.url.startsWith(`/api/bitchord-playback/stream/${videoId}?`)) {
            throw new Error('The playback backend returned an invalid stream.');
        }
        return { ...info, provider: 'bitchord-youtube', playbackType: 'direct',
            youtubeVideoId: videoId, validUntil: Date.now() + 5 * 60 * 1000 };
    } catch (error) {
        if (controller.signal.aborted && !signal?.aborted) {
            throw new Error('Audio took too long to load. Please try again.');
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
    }
}
