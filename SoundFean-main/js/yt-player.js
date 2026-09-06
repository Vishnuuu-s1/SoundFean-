/**
 * Minimal YouTube IFrame Player wrapper for SoundFean.
 * Compliant playback via official IFrame API.
 * UI metadata continues to come from the Tidal track object — this only drives audio/video.
 */

import { resolveTrackToYouTube, isYouTubePlaybackEnabled } from './yt-resolve.js';

let apiReadyPromise = null;

function loadYouTubeAPI() {
    if (window.YT && window.YT.Player) {
        return Promise.resolve(window.YT);
    }
    if (apiReadyPromise) return apiReadyPromise;

    apiReadyPromise = new Promise((resolve, reject) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
            if (typeof prev === 'function') prev();
            resolve(window.YT);
        };
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        tag.onerror = () => reject(new Error('Failed to load YouTube IFrame API'));
        document.head.appendChild(tag);
        // Safety timeout
        setTimeout(() => {
            if (window.YT && window.YT.Player) resolve(window.YT);
        }, 8000);
    });
    return apiReadyPromise;
}

export class YouTubePlaybackController {
    constructor({ onStateChange, onError, onReady } = {}) {
        this.player = null;
        this.container = null;
        this.videoId = null;
        this._onStateChange = onStateChange;
        this._onError = onError;
        this._onReady = onReady;
        this._ready = false;
        this._volume = 70;
    }

    async ensureContainer() {
        if (this.container && document.body.contains(this.container)) return this.container;
        let el = document.getElementById('soundfean-yt-player');
        if (!el) {
            el = document.createElement('div');
            el.id = 'soundfean-yt-player';
            // Keep off-screen / minimal so UI stays Tidal-looking
            el.style.cssText =
                'position:fixed;width:1px;height:1px;bottom:0;right:0;opacity:0.01;pointer-events:none;z-index:-1;overflow:hidden;';
            document.body.appendChild(el);
        }
        this.container = el;
        return el;
    }

    async init() {
        await loadYouTubeAPI();
        await this.ensureContainer();
        if (this.player) return this.player;

        return new Promise((resolve, reject) => {
            try {
                this.player = new window.YT.Player(this.container.id, {
                    height: '1',
                    width: '1',
                    playerVars: {
                        autoplay: 0,
                        controls: 0,
                        disablekb: 1,
                        fs: 0,
                        modestbranding: 1,
                        rel: 0,
                        playsinline: 1,
                        origin: window.location.origin,
                    },
                    events: {
                        onReady: (e) => {
                            this._ready = true;
                            try {
                                e.target.setVolume(this._volume);
                            } catch {
                                /* ignore */
                            }
                            this._onReady?.(e);
                            resolve(this.player);
                        },
                        onStateChange: (e) => this._onStateChange?.(e),
                        onError: (e) => this._onError?.(e),
                    },
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    async loadVideo(videoId, startSeconds = 0) {
        await this.init();
        this.videoId = videoId;
        if (typeof this.player.loadVideoById === 'function') {
            this.player.loadVideoById({ videoId, startSeconds: startSeconds || 0 });
        } else {
            this.player.cueVideoById({ videoId, startSeconds: startSeconds || 0 });
        }
    }

    play() {
        try {
            this.player?.playVideo?.();
        } catch {
            /* ignore */
        }
    }

    pause() {
        try {
            this.player?.pauseVideo?.();
        } catch {
            /* ignore */
        }
    }

    stop() {
        try {
            this.player?.stopVideo?.();
        } catch {
            /* ignore */
        }
    }

    seekTo(seconds, allowSeekAhead = true) {
        try {
            this.player?.seekTo?.(seconds, allowSeekAhead);
        } catch {
            /* ignore */
        }
    }

    setVolume(vol0to1) {
        this._volume = Math.round(Math.max(0, Math.min(1, vol0to1)) * 100);
        try {
            this.player?.setVolume?.(this._volume);
        } catch {
            /* ignore */
        }
    }

    getCurrentTime() {
        try {
            return this.player?.getCurrentTime?.() ?? 0;
        } catch {
            return 0;
        }
    }

    getDuration() {
        try {
            return this.player?.getDuration?.() ?? 0;
        } catch {
            return 0;
        }
    }

    getPlayerState() {
        try {
            return this.player?.getPlayerState?.();
        } catch {
            return undefined;
        }
    }

    destroy() {
        try {
            this.player?.destroy?.();
        } catch {
            /* ignore */
        }
        this.player = null;
        this._ready = false;
        this.videoId = null;
    }
}

/**
 * Resolve track and return { videoId } or { unavailable, reason }.
 * Never mutates displayed Tidal fields.
 */
export async function resolveForPlayback(track) {
    if (!isYouTubePlaybackEnabled()) {
        return { skip: true };
    }
    const result = await resolveTrackToYouTube(track);
    if (result.unavailable || !result.youtubeVideoId) {
        return { unavailable: true, reason: result.reason || 'no match' };
    }
    // Attach only playback fields
    track.youtubeVideoId = result.youtubeVideoId;
    track.playbackSource = 'youtube';
    track.ytConfidence = result.confidence;
    return { videoId: result.youtubeVideoId, confidence: result.confidence };
}

export { isYouTubePlaybackEnabled };
