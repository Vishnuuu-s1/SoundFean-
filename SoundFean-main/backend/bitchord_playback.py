"""BitChord's JVM resolvers -> a seekable, same-origin native audio stream.

Only public, unrestricted YouTube audio is accepted. Signed upstream URLs and
their client headers remain on the server. No arbitrary URL proxy is exposed.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from threading import BoundedSemaphore, Lock
from urllib.parse import parse_qs, urljoin, urlsplit
import json
import re
import subprocess
import time

from flask import Blueprint, Response, jsonify, request, stream_with_context
import requests

playback_blueprint = Blueprint("bitchord_playback", __name__)
ROOT = Path(__file__).resolve().parent
VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}\Z")
CONTENT_RANGE = re.compile(r"bytes (\d+)-(\d+)/(\d+)\Z")
CHUNK_SIZE = 512 * 1024
MAX_AUDIO_BYTES = 150 * 1024 * 1024
_slots = BoundedSemaphore(2)
_lock = Lock()
_cache: dict[str, Audio] = {}


class PlaybackError(Exception):
    def __init__(self, code: str, status: int = 502, reason: str | None = None):
        self.code, self.status = code, status
        # Only short identifiers can cross the public API. Never expose URLs,
        # exception messages, account data or raw JVM output.
        self.reason = reason if isinstance(reason, str) and re.fullmatch(r"[A-Za-z0-9_]{1,80}", reason) else None
        super().__init__(code)


@dataclass(frozen=True)
class Audio:
    url: str
    headers: dict[str, str]
    mime: str
    length: int
    itag: str
    bitrate: int
    expires: float


def _safe_url(url: str) -> str:
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        allowed = host.endswith(".googlevideo.com")
        if (parsed.scheme != "https" or not allowed or parsed.port not in (None, 443)
                or parsed.username or parsed.password or parsed.fragment
                or parsed.path != "/videoplayback"):
            raise ValueError()
    except (TypeError, ValueError):
        raise PlaybackError("invalid_media_source") from None
    return url


def _java_command(video_id: str) -> list[str]:
    try:
        from jdk4py import JAVA
    except ImportError:
        raise PlaybackError("playback_runtime_missing", 503) from None
    libs = ROOT / "bitchord-resolver" / "lib"
    if not (libs / "soundfean-bitchord-resolver.jar").is_file():
        raise PlaybackError("playback_adapter_missing", 503)
    return [str(JAVA), "-Xms32m", "-Xmx256m", "-XX:ActiveProcessorCount=2",
            "-Djava.io.tmpdir=/tmp", "-cp", str(libs / "*"), "MainKt", video_id]


def _extract(video_id: str) -> dict:
    if not _slots.acquire(blocking=False):
        raise PlaybackError("playback_busy", 503)
    try:
        # The libraries redact logs; still keep both pipes private.
        result = subprocess.run(_java_command(video_id), capture_output=True,
                                text=True, timeout=65, check=False)
        if result.returncode:
            markers = {
                "UnsupportedClassVersionError": "JavaVersionMismatch",
                "UnsatisfiedLinkError": "NativeLibraryUnavailable",
                "OutOfMemoryError": "ResolverOutOfMemory",
                "Could not find or load main class": "AdapterClassMissing",
                "ClassNotFoundException": "DependencyClassMissing",
                "NoClassDefFoundError": "DependencyClassMissing",
                "Error occurred during initialization of VM": "JavaRuntimeInitializationFailed",
            }
            reason = next((value for marker, value in markers.items() if marker in result.stderr), "JavaProcessFailed")
            raise PlaybackError("stream_unavailable", reason=reason)
        lines = result.stdout.strip().splitlines()
        if not lines:
            raise PlaybackError("stream_unavailable", reason="EmptyResolverResponse")
        data = json.loads(lines[-1])
        if not isinstance(data, dict):
            raise PlaybackError("stream_unavailable", reason="InvalidResolverResponse")
        if data.get("error"):
            code = data["error"]
            raise PlaybackError("restricted_content" if code == "restricted_content"
                                else "stream_unavailable", 403 if code == "restricted_content" else 502,
                                reason=data.get("reason"))
        if not isinstance(data.get("url"), str):
            raise PlaybackError("stream_unavailable", reason="MissingAudioURL")
        return {"streams": [data]}
    except subprocess.TimeoutExpired:
        raise PlaybackError("stream_unavailable", reason="ResolverTimeout") from None
    except FileNotFoundError:
        raise PlaybackError("stream_unavailable", reason="JavaExecutableMissing") from None
    except PermissionError:
        raise PlaybackError("stream_unavailable", reason="JavaExecutionDenied") from None
    except OSError:
        raise PlaybackError("stream_unavailable", reason="JavaLaunchFailed") from None
    except (ValueError, IndexError, TypeError):
        raise PlaybackError("stream_unavailable", reason="InvalidResolverResponse") from None
    finally:
        _slots.release()


def _open_range(url: str, headers: dict, start: int, end: int, *, timeout=(8, 20)):
    headers = {**headers, "Range": f"bytes={start}-{end}", "Accept-Encoding": "identity"}
    for _ in range(4):
        response = requests.get(_safe_url(url), headers=headers, stream=True,
                                allow_redirects=False, timeout=timeout)
        if response.status_code in (301, 302, 303, 307, 308):
            target = response.headers.get("Location", "")
            response.close()
            url = _safe_url(urljoin(url, target))
            continue
        return response
    raise PlaybackError("too_many_media_redirects")


def _resolve(video_id: str, *, refresh: bool = False) -> Audio:
    with _lock:
        cached = _cache.get(video_id)
        if cached and cached.expires > time.time() and not refresh:
            return cached
    candidates = _extract(video_id)["streams"]
    failure_reason = None
    for data in candidates[:3]:
        try:
            audio = _probe(data)
            break
        except PlaybackError as error:
            failure_reason = error.reason or error.code
            continue
        except requests.RequestException as error:
            failure_reason = type(error).__name__
            continue
    else:
        raise PlaybackError("stream_probe_failed", reason=failure_reason)
    with _lock:
        if len(_cache) >= 64:
            _cache.pop(next(iter(_cache)))
        _cache[video_id] = audio
    return audio


def _probe(data: dict) -> Audio:
    url = _safe_url(data["url"])
    headers = {}
    for name, value in data.get("headers", {}).items():
        if name.lower() in ("user-agent", "origin", "referer"):
            if not isinstance(value, str) or len(value) > 2048 or "\r" in value or "\n" in value:
                raise PlaybackError("invalid_media_headers")
            headers[name] = value
    query = parse_qs(urlsplit(url).query)
    itag = query.get("itag", [""])[0]
    if not re.fullmatch(r"\d{1,5}", itag):
        raise PlaybackError("unsupported_media_format")
    # BitChord probes past 1 MiB when possible to catch streams which stop there.
    claimed_length = query.get("clen", [""])[0]
    if not re.fullmatch(r"\d{1,9}", claimed_length):
        raise PlaybackError("invalid_media_metadata")
    size = int(claimed_length)
    start = 1024 * 1024 if size > 1024 * 1024 + 16384 else 0
    end = min(start + 16384, size) - 1
    if not 2 <= size <= MAX_AUDIO_BYTES:
        raise PlaybackError("invalid_media_metadata")
    with _open_range(url, headers, start, end, timeout=(5, 6)) as probe:
        if probe.status_code != 206:
            raise PlaybackError("stream_probe_failed", reason=f"MediaHTTP{probe.status_code}")
        match = CONTENT_RANGE.fullmatch(probe.headers.get("Content-Range", ""))
        mime = probe.headers.get("Content-Type", "").split(";")[0].lower()
        if (probe.status_code != 206 or not match or match.groups()[:2] != (str(start), str(end))
                or mime not in ("audio/mp4", "audio/webm", "audio/mpeg", "audio/ogg")):
            raise PlaybackError("stream_probe_failed")
        length = int(match[3])
        if length != size or len(probe.raw.read(end - start + 1)) != end - start + 1:
            raise PlaybackError("stream_probe_failed")
    try:
        expires = min(time.time() + 600, float(query.get("expire", [time.time() + 600])[0]) - 60)
        bitrate = max(0, min(1000, int(data.get("bitrateKbps") or 0)))
    except (TypeError, ValueError):
        raise PlaybackError("invalid_media_metadata") from None
    return Audio(url, headers, mime, length, itag, bitrate, expires)


def _range(value: str | None, length: int) -> tuple[int, int, int]:
    if not value:
        return 0, length - 1, 200
    if len(value) > 128:
        raise PlaybackError("invalid_range", 416)
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
    if not match or not any(match.groups()):
        raise PlaybackError("invalid_range", 416)
    first, last = match.groups()
    if first:
        start, end = int(first), min(int(last) if last else length - 1, length - 1)
    else:
        size = int(last)
        if size <= 0:
            raise PlaybackError("invalid_range", 416)
        start, end = max(0, length - size), length - 1
    if start >= length or start > end:
        raise PlaybackError("invalid_range", 416)
    return start, end, 206


def _chunk(audio: Audio, start: int, end: int) -> bytes:
    with _open_range(audio.url, audio.headers, start, end) as response:
        if response.status_code in (403, 410):
            raise PlaybackError("expired_stream")
        expected = f"bytes {start}-{end}/{audio.length}"
        if response.status_code != 206 or response.headers.get("Content-Range") != expected:
            raise PlaybackError("invalid_media_range")
        data = response.raw.read(end - start + 2)
        if len(data) != end - start + 1:
            raise PlaybackError("incomplete_media_range")
        return data


def _checked_chunk(video_id: str, audio: Audio, start: int, end: int) -> tuple[Audio, bytes]:
    try:
        return audio, _chunk(audio, start, end)
    except PlaybackError as error:
        if error.code != "expired_stream":
            raise
        refreshed = _resolve(video_id, refresh=True)
        if (refreshed.itag, refreshed.length, refreshed.mime) != (audio.itag, audio.length, audio.mime):
            raise PlaybackError("media_changed") from None
        return refreshed, _chunk(refreshed, start, end)


def _error(error: PlaybackError):
    payload = {"error": error.code}
    if error.reason:
        payload["reason"] = error.reason
    # Bounded, sanitized diagnostics are useful even when the client cannot
    # access the Vercel logs. Neither pipe from Java is printed.
    print(json.dumps({"event": "bitchord_playback_error", **payload}), flush=True)
    response = jsonify(payload)
    response.status_code = error.status
    response.headers["Cache-Control"] = "no-store"
    if error.status == 503:
        response.headers["Retry-After"] = "5"
    return response


@playback_blueprint.get("/api/bitchord-playback/check")
def check_playback():
    """Public, fixed-input check for the deployed runtime and audio transport."""
    try:
        # Blender's publicly released Big Buck Bunny test video.
        audio = _resolve("aqz-KE-bpKQ")
        response = jsonify({"diagnosticVersion": 1, "status": "ok",
                            "stage": "audio_probe_passed", "mimeType": audio.mime})
    except PlaybackError as error:
        response = _error(error)
        response.set_data(json.dumps({"diagnosticVersion": 1, "status": "failed", **response.get_json()}))
    except requests.RequestException as error:
        response = _error(PlaybackError("media_network_error", reason=type(error).__name__))
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    return response


@playback_blueprint.post("/api/bitchord-playback/resolve")
def resolve_playback():
    if request.content_length and request.content_length > 1024:
        return _error(PlaybackError("invalid_request", 400))
    body = request.get_json(silent=True)
    video_id = body.get("videoId") if isinstance(body, dict) else None
    if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id):
        return _error(PlaybackError("invalid_video_id", 400))
    try:
        audio = _resolve(video_id)
        response = jsonify({
            "url": f"/api/bitchord-playback/stream/{video_id}?itag={audio.itag}&length={audio.length}",
            "provider": "bitchord-youtube", "playbackType": "direct",
            "mimeType": audio.mime, "bitrateKbps": audio.bitrate,
            "codec": "AAC" if audio.mime == "audio/mp4" else "OPUS" if audio.mime == "audio/webm" else "",
            "lossless": False, "youtubeVideoId": video_id,
        })
        response.headers["Cache-Control"] = "no-store"
        return response
    except PlaybackError as error:
        return _error(error)
    except requests.RequestException:
        return _error(PlaybackError("media_network_error"))


@playback_blueprint.route("/api/bitchord-playback/stream/<video_id>", methods=["GET", "HEAD"])
def stream_playback(video_id: str):
    if not VIDEO_ID.fullmatch(video_id):
        return _error(PlaybackError("invalid_video_id", 400))
    itag, expected_length = request.args.get("itag", ""), request.args.get("length", "")
    if not re.fullmatch(r"\d{1,5}", itag) or not re.fullmatch(r"\d{1,9}", expected_length):
        return _error(PlaybackError("invalid_request", 400))
    try:
        audio = _resolve(video_id)
        if audio.itag != itag or audio.length != int(expected_length):
            raise PlaybackError("media_changed", 409)
        try:
            start, end, status = _range(request.headers.get("Range"), audio.length)
        except PlaybackError as error:
            response = _error(error)
            response.headers["Content-Range"] = f"bytes */{audio.length}"
            return response
        headers = {"Content-Type": audio.mime, "Content-Length": str(end - start + 1),
                   "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
                   "X-Content-Type-Options": "nosniff"}
        if status == 206:
            headers["Content-Range"] = f"bytes {start}-{end}/{audio.length}"
        if request.method == "HEAD":
            return Response(status=status, headers=headers)
        first_end = min(end, start + CHUNK_SIZE - 1)
        audio, first = _checked_chunk(video_id, audio, start, first_end)

        def generate():
            current = audio
            yield first
            offset = first_end + 1
            while offset <= end:
                last = min(end, offset + CHUNK_SIZE - 1)
                current, chunk = _checked_chunk(video_id, current, offset, last)
                yield chunk
                offset = last + 1

        return Response(stream_with_context(generate()), status=status, headers=headers)
    except PlaybackError as error:
        return _error(error)
    except requests.RequestException:
        return _error(PlaybackError("media_network_error"))
