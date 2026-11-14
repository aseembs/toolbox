// ==UserScript==
// @name         Chessable JSON Vimeo Video Helper (1080p prototype)
// @namespace    local.chessable.vimeo.helper
// @version      0.1.0
// @description  Detects the active Vimeo adaptive JSON playlist on Chessable and downloads the 1080p video and AAC audio tracks for authorized offline use.
// @match        https://player.vimeo.com/*
// @run-at       document-start
// @sandbox      MAIN_WORLD
// @grant        none
// ==/UserScript==

// After downloading, combine the video and audio tracks into one MP4 using FFmpeg:
// ffmpeg -i video.mp4 -i audio.mp4 -c copy -movflags +faststart combined_video.mp4

(() => {
  'use strict';

  const VIMEO_HOST = 'vod-adaptive-ak.vimeocdn.com';
  const state = {
    playlist: null,
    playlistUrl: null,
    panel: null,
    busy: false
  };

  function isPlaylistUrl(value) {
    try {
        const u = new URL(value, location.href);

        return (
            u.hostname.endsWith('.vimeocdn.com') &&
            /\/playlist\.json(?:\?|$)/i.test(u.pathname + u.search)
        );
    } catch (_) {
        return false;
    }
  }

  function acceptPlaylist(url, json) {
    if (!json || !Array.isArray(json.video) ||
        !Array.isArray(json.audio)) return;

    state.playlist = json;
    state.playlistUrl = url;
    renderPanel();
  }

  // Observe fetch-based player requests.
  const nativeFetch = window.fetch;

  window.fetch = function (...args) {
    const requestUrl =
      typeof args[0] === 'string'
        ? args[0]
        : (args[0] && args[0].url);

    const promise = nativeFetch.apply(this, args);

    if (requestUrl && isPlaylistUrl(requestUrl)) {
      promise.then(response => {
        if (response.ok) {
          response.clone()
            .json()
            .then(json =>
              acceptPlaylist(response.url || requestUrl, json)
            )
            .catch(() => {});
        }
      }).catch(() => {});
    }

    return promise;
  };

  // Also observe XHR-based players.
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__chessablePlaylistUrl =
      isPlaylistUrl(url)
        ? new URL(url, location.href).href
        : null;

    return nativeOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__chessablePlaylistUrl) {
      this.addEventListener('load', () => {
        try {
          if (this.status >= 200 && this.status < 300) {
            acceptPlaylist(
              this.responseURL || this.__chessablePlaylistUrl,
              JSON.parse(this.responseText)
            );
          }
        } catch (_) {}
      }, { once: true });
    }

    return nativeSend.apply(this, args);
  };

  function el(tag, attrs = {}, text = '') {
    const node = document.createElement(tag);

    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'style') {
        node.style.cssText = v;
      } else if (k.startsWith('on')) {
        node.addEventListener(k.slice(2), v);
      } else {
        node.setAttribute(k, v);
      }
    });

    if (text) node.textContent = text;

    return node;
  }

  function renderPanel() {
    if (!document.documentElement) return;

    if (!state.panel) {
      const panel = el('section', {
        id: 'chessable-vimeo-helper',
        style: `
          position:fixed;
          z-index:2147483647;
          right:18px;
          bottom:18px;
          width:310px;
          background:#17191f;
          color:#f5f6f8;
          border:1px solid #454955;
          border-radius:12px;
          box-shadow:0 8px 30px #0008;
          font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
          padding:14px;
        `
      });

      const head = el('div', {
        style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px'
      });

      head.append(el('strong', {}, 'Chessable video helper'));

      head.append(el('button', {
        id: 'cvh-close',
        style: 'background:transparent;color:#ddd;border:0;font-size:18px;cursor:pointer'
      }, '×'));

      panel.append(head);

      panel.append(el('div', {
        id: 'cvh-status',
        style: 'color:#c7cbd4;margin:6px 0 10px'
      }, 'Waiting for a Vimeo video playlist…'));

      panel.append(el('div', {
        id: 'cvh-meta',
        style: 'margin-bottom:10px;color:#aeb4c0'
      }, 'Start playing a course video.'));

      const button = el('button', {
        id: 'cvh-download',
        style: 'width:100%;padding:10px;border:0;border-radius:8px;background:#4c83f5;color:white;font-weight:600;cursor:pointer;opacity:.55'
      }, 'Download 1080p + AAC');

      button.disabled = true;
      panel.append(button);

      panel.append(el('div', {
        id: 'cvh-progress',
        style: 'font-size:11px;color:#aeb4c0;margin-top:9px;white-space:pre-wrap'
      }, 'Files are saved as separate video and audio tracks.'));

      panel.append(el('div', {
        style: 'font-size:10px;color:#858c99;margin-top:9px'
      }, 'Prototype · use only for content you are authorized to download.'));

      document.documentElement.append(panel);

      state.panel = panel;

      panel.querySelector('#cvh-close')
        .addEventListener('click', () => panel.remove());

      button.addEventListener('click', download1080);
    }

    if (!state.playlist) {
  state.panel.querySelector('#cvh-status').textContent =
    'Waiting for a Vimeo video playlist…';

  state.panel.querySelector('#cvh-meta').textContent =
    'Start playing a course video.';

  state.panel.querySelector('#cvh-download').disabled = true;

  return;
    }

    const video = state.playlist.video.find(
      v => Number(v.height) === 1080 &&
           v.mime_type === 'video/mp4'
    );

    const audio =
      state.playlist.audio.find(
        a => a.codecs === 'mp4a.40.2'
      ) ||
      state.playlist.audio.find(
        a => a.mime_type === 'audio/mp4'
      );

    const status = state.panel.querySelector('#cvh-status');
    const meta = state.panel.querySelector('#cvh-meta');
    const button = state.panel.querySelector('#cvh-download');

    if (video && audio) {
      status.textContent = 'Vimeo playlist detected';

      meta.textContent =
        `1080p · ${video.width}×${video.height} · ` +
        `${video.segments?.length || 0} video fragments · ` +
        `${audio.segments?.length || 0} audio fragments · ` +
        `${Math.round(video.duration)} sec`;

      button.disabled = state.busy;
      button.style.opacity = state.busy ? '.55' : '1';
    } else {
      status.textContent =
        'Playlist detected, but 1080p + AAC were not both available.';

      meta.textContent =
        'Try starting playback or choose a video with 1080p availability.';

      button.disabled = true;
    }
  }

  function setProgress(message) {
    if (state.panel) {
      state.panel.querySelector('#cvh-progress').textContent = message;
    }
  }

  function decodeBase64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
  }

  function buildTrackBaseUrl(track, playlistUrl, playlist) {
    return new URL(
      track.base_url || playlist.base_url || '.',
      playlistUrl
    );
  }

  async function fetchWithRetry(url, attempt = 1) {
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        cache: 'no-store'
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return new Uint8Array(await response.arrayBuffer());

    } catch (err) {
      if (attempt >= 3) throw err;

      await new Promise(resolve =>
        setTimeout(resolve, 500 * attempt)
      );

      return fetchWithRetry(url, attempt + 1);
    }
  }

  async function downloadTrack(track, playlist, playlistUrl, label) {
    if (!track.init_segment ||
        !Array.isArray(track.segments) ||
        !track.segments.length) {
      throw new Error(
        `${label}: missing initialization data or media segments`
      );
    }

    const base = buildTrackBaseUrl(
      track,
      playlistUrl,
      playlist
    );

    const pieces = [
      decodeBase64ToBytes(track.init_segment)
    ];

    let completed = 0;
    const total = track.segments.length;
    const results = new Array(total);
    let next = 0;

    async function worker() {
      while (true) {
        const index = next++;

        if (index >= total) return;

        const segment = track.segments[index];
        const url = new URL(segment.url, base).href;

        results[index] = await fetchWithRetry(url);

        completed++;

        setProgress(
          `${label}: ${completed}/${total} fragments downloaded`
        );
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(4, total) },
        worker
      )
    );

    pieces.push(...results);

    return new Blob(pieces, {
      type: track.mime_type || 'video/mp4'
    });
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download = filename;

    document.body.append(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function download1080() {
    if (state.busy || !state.playlist) return;

    const playlist = state.playlist;

    const video = playlist.video.find(
      v => Number(v.height) === 1080 &&
           v.mime_type === 'video/mp4'
    );

    const audio =
      playlist.audio.find(
        a => a.codecs === 'mp4a.40.2'
      ) ||
      playlist.audio.find(
        a => a.mime_type === 'audio/mp4'
      );

    if (!video || !audio) return;

    state.busy = true;
    renderPanel();

    const button = state.panel.querySelector('#cvh-download');
    button.textContent = 'Downloading…';

    try {
      setProgress('Downloading 1080p video fragments…');

      const videoBlob = await downloadTrack(
        video,
        playlist,
        state.playlistUrl,
        'Video'
      );

      setProgress('Downloading AAC audio fragments…');

      const audioBlob = await downloadTrack(
        audio,
        playlist,
        state.playlistUrl,
        'Audio'
      );

      const stem =
        `chessable-${playlist.clip_id || 'video'}`;

      saveBlob(
        videoBlob,
        `${stem}-1080p-video.mp4`
      );

      await new Promise(resolve =>
        setTimeout(resolve, 700)
      );

      saveBlob(
        audioBlob,
        `${stem}-aac-audio.mp4`
      );

      setProgress(
        'Downloads started. The two tracks must be muxed together with FFmpeg.'
      );

    } catch (err) {
      console.error('[Chessable video helper]', err);

      setProgress(
        `Download failed: ${err.message}. ` +
        'Refresh the video to obtain a fresh signed playlist, then retry.'
      );

    } finally {
      state.busy = false;
      button.textContent = 'Download 1080p + AAC';
      button.disabled = false;
      button.style.opacity = '1';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      renderPanel,
      { once: true }
    );
  } else {
    renderPanel();
  }

})();
