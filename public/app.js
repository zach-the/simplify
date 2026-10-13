(() => {
  "use strict";

  const CLIENT_ID = (window.SPOTIFY_CLIENT_ID || "").trim();
  const REDIRECT_URI = `${location.origin}/callback`;
  const SCOPES = [
    "streaming",
    "user-read-email",
    "user-read-private",
    "user-library-read",
    "playlist-read-private",
    "playlist-read-collaborative",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-recently-played",
    "user-library-modify",
    "playlist-modify-public",
    "playlist-modify-private",
  ].join(" ");
  const API = "https://api.spotify.com/v1";
  const TOKEN_URL = "https://accounts.spotify.com/api/token";

  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  // ---------- auth (Authorization Code + PKCE, no client secret) ----------

  const store = {
    get: (k) => localStorage.getItem(`simplify.${k}`),
    set: (k, v) => localStorage.setItem(`simplify.${k}`, v),
    del: (k) => localStorage.removeItem(`simplify.${k}`),
  };

  const b64url = (bytes) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  async function login() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    store.set("verifier", verifier);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      code_challenge_method: "S256",
      code_challenge: b64url(new Uint8Array(digest)),
      scope: SCOPES,
    });
    location.href = `https://accounts.spotify.com/authorize?${params}`;
  }

  async function tokenRequest(fields) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }),
    });
    if (!res.ok) throw new Error(`Spotify sign-in failed (${res.status})`);
    const data = await res.json();
    store.set("access", data.access_token);
    store.set("expires", String(Date.now() + (data.expires_in - 60) * 1000));
    if (data.refresh_token) store.set("refresh", data.refresh_token);
    if (data.scope) store.set("scope", data.scope);
    return data.access_token;
  }

  let refreshing = null;
  async function getToken(force = false) {
    if (!force && store.get("access") && Date.now() < Number(store.get("expires"))) {
      return store.get("access");
    }
    const refresh = store.get("refresh");
    if (!refresh) throw new Error("Not signed in");
    refreshing ||= tokenRequest({ grant_type: "refresh_token", refresh_token: refresh }).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  function logout() {
    ["access", "expires", "refresh", "verifier", "scope", "scopeAsked"].forEach(store.del);
    location.href = "/";
  }

  // ---------- Web API ----------

  async function api(path, { method = "GET", body, retry = true, waited = false } = {}) {
    const token = await getToken();
    const res = await fetch(path.startsWith("http") ? path : API + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && retry) {
      await getToken(true);
      return api(path, { method, body, retry: false });
    }
    if (res.status === 429 && !waited) {
      const wait = Math.min(Number(res.headers.get("Retry-After")) || 2, 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return api(path, { method, body, retry, waited: true });
    }
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      const err = new Error(detail?.error?.message || `Spotify error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 || res.headers.get("content-length") === "0" ? null : res.json().catch(() => null);
  }

  async function fetchAll(path) {
    const items = [];
    let url = `${path}?limit=50`;
    while (url) {
      let page;
      try {
        page = await api(url);
      } catch (e) {
        // Some app tiers cap page size lower than 50.
        if (e.status === 400 && url.includes("limit=50")) {
          url = url.replace("limit=50", "limit=10");
          continue;
        }
        throw e;
      }
      items.push(...page.items);
      url = page.next;
    }
    return items;
  }

  // ---------- normalising Spotify objects into tiles ----------

  const bestImage = (images) =>
    images?.length ? images.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a)).url : null;
  // Grid tiles don't need the 640px version.
  const thumb = (images) => {
    if (!images?.length) return null;
    const mid = images.filter((i) => (i.width || 0) >= 200).sort((a, b) => a.width - b.width)[0];
    return (mid || images[0]).url;
  };
  const names = (list) => (list || []).map((a) => a.name).join(", ");

  const toItem = {
    album: (a) => ({ type: "album", uri: a.uri, title: a.name, sub: `Album • ${names(a.artists)}`, by: names(a.artists), image: thumb(a.images) }),
    playlist: (p) => ({ type: "playlist", uri: p.uri, title: p.name, sub: `Playlist • ${p.owner?.display_name || ""}`, by: p.owner?.display_name || "", image: thumb(p.images), cover: bestImage(p.images) }),
    show: (s) => ({ type: "show", uri: s.uri, title: s.name, sub: `Podcast • ${s.publisher || ""}`, by: s.publisher || "", image: thumb(s.images) }),
    track: (t) => ({ type: "track", uri: t.uri, title: t.name, sub: `Song • ${names(t.artists)}`, by: names(t.artists), image: thumb(t.album?.images) }),
  };

  // ---------- player ----------

  let player = null;
  let deviceId = null;
  let lastState = null;

  function loadSdk() {
    return new Promise((resolve) => {
      window.onSpotifyWebPlaybackSDKReady = resolve;
      document.head.append(el("script", { src: "https://sdk.scdn.co/spotify-player.js" }));
    });
  }

  async function initPlayer() {
    await loadSdk();
    player = new Spotify.Player({
      name: "Simplify",
      getOAuthToken: (cb) => getToken().then(cb).catch((e) => toast(e.message)),
      volume: 1,
    });
    player.addListener("ready", ({ device_id }) => {
      deviceId = device_id;
      restoreSession();
    });
    player.addListener("not_ready", () => { deviceId = null; });
    player.addListener("player_state_changed", onState);
    player.addListener("initialization_error", ({ message }) =>
      toast(`Playback isn't available in this window (${message}). Use Google Chrome.`));
    player.addListener("authentication_error", ({ message }) => toast(`Sign-in problem: ${message}`));
    player.addListener("account_error", () => toast("Spotify Premium is required for playback."));
    player.addListener("playback_error", ({ message }) => toast(message));
    await player.connect();
  }

  // After a reload this is a brand-new device with nothing loaded. Pull the
  // account's last track onto it, paused, so the bar and cover fill in again.
  let restoring = false;
  async function restoreSession() {
    if (lastState) return;
    try {
      const current = await api("/me/player").catch(() => null);
      // Don't take over from another device that is playing right now.
      if (current?.is_playing && current.device?.id !== deviceId) return;
      restoring = true;
      setTimeout(() => { restoring = false; }, 5000);
      await api("/me/player", { method: "PUT", body: { device_ids: [deviceId], play: false } });
    } catch {
      restoring = false; // nothing to restore
    }
  }

  async function waitForDevice() {
    for (let i = 0; i < 50 && !deviceId; i++) await new Promise((r) => setTimeout(r, 100));
    if (!deviceId) throw new Error("Player isn't ready yet. Try again in a moment.");
    return deviceId;
  }

  async function play(item, shuffle = false) {
    try {
      restoring = false; // an explicit play beats the paused restore
      player?.activateElement();
      const id = await waitForDevice();
      const setShuffle = () =>
        api(`/me/player/shuffle?state=${shuffle}&device_id=${id}`, { method: "PUT" }).then(() => true, () => false);
      // Set the mode before starting so a shuffled play opens on a random track.
      const preset = await setShuffle();
      const body = item.type === "track" ? { uris: [item.uri] } : { context_uri: item.uri };
      await api(`/me/player/play?device_id=${id}`, { method: "PUT", body });
      if (!preset) {
        // Spotify rejects the mode change until this device is active (first play of a session).
        const applied = await setShuffle();
        if (applied && shuffle) await player.nextTrack();
      }
    } catch (e) {
      toast(e.message);
    }
  }

  async function togglePlay() {
    try {
      restoring = false; // an explicit play beats the paused restore
      player?.activateElement();
      if (lastState) return await player.togglePlay();
      // Nothing loaded here yet: pull whatever was last playing onto this device.
      const id = await waitForDevice();
      await api("/me/player", { method: "PUT", body: { device_ids: [id], play: true } });
    } catch (e) {
      toast(e.status === 404 ? "Pick something from your library first." : e.message);
    }
  }

  function onState(state) {
    // Spotify sometimes starts playing on a paused restore; hold it paused.
    if (restoring && state) {
      restoring = false;
      if (!state.paused) player.pause();
    }
    lastState = state;
    const track = state?.track_window?.current_track;
    // These are SVG elements, which have no .hidden property; use the attribute.
    $("icon-play").toggleAttribute("hidden", !!state && !state.paused);
    $("icon-pause").toggleAttribute("hidden", !state || state.paused);
    if (state) {
      shuffleOn = !!state.shuffle;
      repeatMode = state.repeat_mode || 0;
      paintModes();
    }
    progress = state
      ? { pos: state.position, dur: state.duration, at: performance.now(), paused: state.paused }
      : { pos: 0, dur: 0, at: 0, paused: true };
    renderProgress();
    if (!track) return;

    $("track").textContent = track.name;
    $("artist").textContent = names(track.artists) || track.album?.name || "";
    $("now-track").textContent = $("track").textContent;
    $("now-sub").textContent = [names(track.artists), track.album?.name].filter(Boolean).join(" · ");
    document.title = `${track.name} · ${names(track.artists)}`;

    if (!state.paused) notePlayed(state.context?.uri);

    updateArt();
    updateMediaSession(state, track);
    refreshLike();
    if (menuFor && !trackUris().includes(menuFor)) closeMenu();
  }

  // ---------- shuffle / repeat ----------

  let shuffleOn = false;
  let repeatMode = 0; // 0 off, 1 repeat the album/playlist, 2 repeat the track
  const REPEAT = ["off", "context", "track"];
  const REPEAT_TITLE = ["Repeat: off", "Repeat: all", "Repeat: this track"];

  function paintModes() {
    $("shuffle").classList.toggle("on", shuffleOn);
    $("shuffle").title = shuffleOn ? "Shuffle: on" : "Shuffle: off";
    $("repeat").classList.toggle("on", repeatMode > 0);
    $("repeat").classList.toggle("one", repeatMode === 2);
    $("repeat").title = REPEAT_TITLE[repeatMode];
  }

  async function setMode(kind, value, apply) {
    try {
      const id = await waitForDevice();
      await api(`/me/player/${kind}?state=${value}&device_id=${id}`, { method: "PUT" });
      apply();
      paintModes();
    } catch (e) {
      toast(e.status === 404 ? "Play something first." : e.message);
    }
  }

  $("shuffle").addEventListener("click", () => {
    const next = !shuffleOn;
    setMode("shuffle", next, () => { shuffleOn = next; });
  });
  $("repeat").addEventListener("click", () => {
    const next = (repeatMode + 1) % 3;
    setMode("repeat", REPEAT[next], () => { repeatMode = next; });
  });

  // ---------- keyboard media keys / system Now Playing ----------

  // Register with the OS media controls so the play/pause, next and previous
  // keys (and the Now Playing widget) are aimed at this app while it plays.
  const media = navigator.mediaSession;
  let mediaTrack = null;

  if (media) {
    const handlers = {
      play: () => player?.resume(),
      pause: () => player?.pause(),
      previoustrack: () => player?.previousTrack(),
      nexttrack: () => player?.nextTrack(),
      seekto: (d) => player?.seek(Math.round(d.seekTime * 1000)),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { media.setActionHandler(action, handler); } catch {}
    }
  }

  function updateMediaSession(state, track) {
    if (!media) return;
    if (track.uri !== mediaTrack) {
      mediaTrack = track.uri;
      const art = bestImage(track.album?.images);
      media.metadata = new MediaMetadata({
        title: track.name,
        artist: names(track.artists),
        album: track.album?.name || "",
        artwork: art ? [{ src: art }] : [],
      });
    }
    media.playbackState = state.paused ? "paused" : "playing";
    try {
      media.setPositionState({
        duration: state.duration / 1000,
        position: Math.min(state.position, state.duration) / 1000,
        playbackRate: 1,
      });
    } catch {}
  }

  // ---------- like / add to playlist ----------

  // The playing track can be a regional stand-in for the one that was saved, so check both.
  const trackUris = () => {
    const t = lastState?.track_window?.current_track;
    return t ? [t.linked_from?.uri, t.uri].filter(Boolean) : [];
  };

  let likedFor = null;
  let liked = false;
  const paintLike = () => {
    $("like").classList.toggle("on", liked);
    $("like").title = liked ? "Liked. Click to remove" : "Like";
  };

  async function refreshLike() {
    const uri = trackUris()[0];
    if (!uri || uri === likedFor) return;
    likedFor = uri;
    liked = false;
    paintLike();
    const res = await api(`/me/library/contains?uris=${encodeURIComponent(uri)}`).catch(() => null);
    if (likedFor !== uri) return;
    liked = !!res?.[0];
    paintLike();
  }

  $("like").addEventListener("click", async () => {
    const uri = trackUris()[0];
    if (!uri) return toast("Play something first.");
    const next = !liked;
    try {
      await api(`/me/library?uris=${encodeURIComponent(uri)}`, { method: next ? "PUT" : "DELETE" });
      if (likedFor !== uri) return;
      liked = next;
      paintLike();
    } catch (e) {
      toast(e.message);
    }
  });

  // Track URIs per playlist, fetched once per session and kept in step with our own edits.
  const playlistTracks = {};
  function playlistSet(id) {
    return (playlistTracks[id] ||= fetchAll(`/playlists/${id}/items`)
      .then((entries) => new Set(entries.map((e) => (e?.item || e?.track)?.uri).filter(Boolean)))
      .catch((e) => {
        delete playlistTracks[id];
        throw e;
      }));
  }

  async function eachLimited(list, n, fn) {
    const queue = [...list];
    await Promise.all(Array.from({ length: n }, async () => {
      while (queue.length) await fn(queue.shift());
    }));
  }

  let menuFor = null; // URI of the track the open menu is about

  function closeMenu() {
    menuFor = null;
    $("playlist-menu").hidden = true;
  }

  function openMenu() {
    const uris = trackUris();
    if (!uris.length) return toast("Play something first.");
    const menu = $("playlist-menu");
    const name = lastState.track_window.current_track.name;
    menu.replaceChildren(el("div", { className: "heading", textContent: `Add “${name}” to…` }));
    if (!myPlaylists.length) {
      menu.append(el("div", { className: "empty", textContent: "You have no playlists you can edit." }));
    }

    const rows = new Map();
    const paint = (p, set) => {
      const row = rows.get(p.id);
      row.classList.add("known");
      row.classList.toggle("in", uris.some((u) => set.has(u)));
    };
    for (const p of myPlaylists) {
      const row = el("button", { className: "row" }, el("span", { textContent: p.name }));
      row.addEventListener("click", async () => {
        row.classList.add("busy");
        try {
          const set = await playlistSet(p.id);
          const present = uris.filter((u) => set.has(u));
          if (present.length) {
            await api(`/playlists/${p.id}/items`, { method: "DELETE", body: { items: present.map((uri) => ({ uri })) } });
            present.forEach((u) => set.delete(u));
            toast(`Removed from ${p.name}`, true);
          } else {
            await api(`/playlists/${p.id}/items`, { method: "POST", body: { uris: [uris[0]] } });
            set.add(uris[0]);
            toast(`Added to ${p.name}`, true);
          }
          paint(p, set);
        } catch (e) {
          toast(e.message);
        }
        row.classList.remove("busy");
      });
      rows.set(p.id, row);
      menu.append(row);
    }

    menuFor = uris[uris.length - 1];
    menu.hidden = false;
    const bar = $("controls").getBoundingClientRect();
    const btn = $("add").getBoundingClientRect();
    menu.style.bottom = `${innerHeight - bar.top + 8}px`;
    menu.style.left = `${Math.max(8, Math.min(btn.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;

    const forUri = menuFor;
    eachLimited(myPlaylists, 4, async (p) => {
      if (menuFor !== forUri) return;
      const set = await playlistSet(p.id).catch(() => null);
      if (set && menuFor === forUri) paint(p, set);
    });
  }

  $("add").addEventListener("click", () => ($("playlist-menu").hidden ? openMenu() : closeMenu()));
  document.addEventListener("click", (e) => {
    if (!menuFor || e.target.closest("#playlist-menu, #add")) return;
    closeMenu();
  });

  // ---------- progress ----------

  let progress = { pos: 0, dur: 0, at: 0, paused: true };
  let seeking = false;

  const clock = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  function currentPosition() {
    const { pos, dur, at, paused } = progress;
    return paused ? pos : Math.min(dur, pos + (performance.now() - at));
  }

  function paintSeek(ms) {
    const seek = $("seek");
    seek.style.setProperty("--p", progress.dur ? `${(ms / progress.dur) * 100}%` : "0%");
    $("elapsed").textContent = clock(ms);
  }

  function renderProgress() {
    if (seeking) return;
    const seek = $("seek");
    const ms = currentPosition();
    seek.max = progress.dur || 1;
    seek.value = ms;
    seek.disabled = !progress.dur;
    $("duration").textContent = clock(progress.dur);
    paintSeek(ms);
  }
  setInterval(renderProgress, 500);

  $("seek").addEventListener("input", (e) => {
    seeking = true;
    paintSeek(Number(e.target.value));
  });
  $("seek").addEventListener("change", (e) => {
    const ms = Number(e.target.value);
    progress = { ...progress, pos: ms, at: performance.now() };
    seeking = false;
    player?.seek(ms);
    e.target.blur();
  });

  // While a playlist is playing, clicking the artwork flips between the
  // playlist's cover and the current track's album cover.
  let coverMode = store.get("coverMode") === "playlist" ? "playlist" : "album";
  const playlistCovers = {};

  const playlistContext = () => {
    const uri = lastState?.context?.uri;
    return uri?.startsWith("spotify:playlist:") ? uri : null;
  };

  async function playlistCover(uri) {
    if (playlistCovers[uri]) return playlistCovers[uri];
    let url = library.find((i) => i.uri === uri)?.cover;
    if (!url) {
      const playlist = await api(`/playlists/${uri.split(":").pop()}?fields=images`).catch(() => null);
      url = bestImage(playlist?.images);
    }
    if (url) playlistCovers[uri] = url;
    return url;
  }

  async function updateArt() {
    const track = lastState?.track_window?.current_track;
    if (!track) return;
    const playlist = playlistContext();
    $("art").classList.toggle("toggleable", !!playlist);
    let url = bestImage(track.album?.images);
    if (playlist && coverMode === "playlist") {
      url = (await playlistCover(playlist)) || url;
      // The track or mode may have changed while the cover was being looked up.
      if (playlistContext() !== playlist || coverMode !== "playlist") return;
    }
    const art = $("art");
    if (url && art.getAttribute("src") !== url) {
      art.crossOrigin = "anonymous";
      art.src = url;
    }
  }

  $("art").addEventListener("click", () => {
    if (!playlistContext()) return;
    coverMode = coverMode === "playlist" ? "album" : "playlist";
    store.set("coverMode", coverMode);
    updateArt();
  });

  // Some artwork hosts don't allow cross-origin reads; show it anyway, untinted.
  $("art").addEventListener("error", () => {
    const art = $("art");
    if (art.crossOrigin === null) return;
    const url = art.getAttribute("src");
    art.removeAttribute("crossorigin");
    art.src = url;
  });

  // Tint the cover view with the artwork's average colour.
  $("art").addEventListener("load", () => {
    try {
      const size = 24;
      const ctx = el("canvas", { width: size, height: size }).getContext("2d", { willReadFrequently: true });
      ctx.drawImage($("art"), 0, 0, size, size);
      const px = ctx.getImageData(0, 0, size, size).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
      const n = px.length / 4;
      const shade = (k) => `rgb(${[r, g, b].map((c) => Math.round((c / n) * k)).join(",")})`;
      document.documentElement.style.setProperty("--bg-top", shade(0.7));
      document.documentElement.style.setProperty("--bg-bottom", shade(0.32));
    } catch {
      // Artwork without CORS headers: keep the neutral background.
    }
  });

  // ---------- views ----------

  const VIEWS = ["cover", "library", "search"];
  function show(view) {
    for (const v of [...VIEWS, "setup"]) $(v).hidden = v !== view;
    document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    $("nav").classList.toggle("over-grid", view !== "cover");
    document.body.dataset.view = view;
    if (view === "library" && sort === "played") renderLibrary();
    hideTip();
    if (view === "search") $("search-input").focus();
  }

  const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>';
  const ICON_SHUFFLE =
    '<svg viewBox="0 0 24 24"><path d="M3 7h3.5c5 0 6 10 11 10H21M3 17h3.5c1.6 0 2.8-1 3.9-2.4M21 7h-3.500c-1.6 0-2.8 1-3.9 2.400M18.5 4.500L21 7l-2.5 2.500M18.5 14.500L21 17l-2.5 2.5"/></svg>';

  function renderGrid(grid, items, emptyText) {
    grid.replaceChildren();
    if (!items.length) {
      grid.append(el("div", { className: "empty", textContent: emptyText }));
      return;
    }
    for (const item of items) {
      const tile = el("div", { className: "tile" });
      tile.dataset.uri = item.uri;
      tile.dataset.title = item.title;
      tile.dataset.sub = item.sub;
      if (item.image) tile.append(el("img", { src: item.image, loading: "lazy", alt: "" }));
      else tile.append(el("span", { textContent: item.title }));

      const actions = el("div", { className: "actions" });
      if (item.type !== "track") {
        const shuffleBtn = el("button", { className: "shuffle", title: "Shuffle", innerHTML: ICON_SHUFFLE });
        shuffleBtn.addEventListener("click", (e) => { e.stopPropagation(); play(item, true); });
        actions.append(shuffleBtn);
      }
      const playBtn = el("button", { className: "play", title: "Play", innerHTML: ICON_PLAY });
      playBtn.addEventListener("click", (e) => { e.stopPropagation(); play(item, false); });
      actions.append(playBtn);
      tile.append(actions);

      // Clicking the cover only shows its label; playing takes the buttons.
      tile.addEventListener("click", () => toggleTip(tile));
      tile.addEventListener("mouseleave", hideTip);
      // Tiles in the outer columns grow inward so the enlarged cover isn't cut off.
      tile.addEventListener("mouseenter", () => {
        const r = tile.getBoundingClientRect();
        const overhang = r.width * 0.25;
        const x = r.left < overhang ? "left" : innerWidth - r.right < overhang ? "right" : "center";
        tile.style.transformOrigin = `${x} center`;
      });
      grid.append(tile);
    }
  }

  // Label for a tile, shown when its cover is clicked. Shared by both grids.
  let tipTile = null;

  function hideTip() {
    tipTile = null;
    $("tip").hidden = true;
  }

  function toggleTip(tile) {
    if (tipTile === tile) return hideTip();
    const tip = $("tip");
    $("tip-title").textContent = tile.dataset.title;
    $("tip-sub").textContent = tile.dataset.sub;
    tip.hidden = false;
    tipTile = tile;
    // Sit just below the cover (above it when there's no room) so the buttons stay clear.
    const r = tile.getBoundingClientRect();
    const below = r.bottom + 8;
    const top = below + tip.offsetHeight > innerHeight - 8 ? r.top - tip.offsetHeight - 8 : below;
    tip.style.left = `${Math.max(8, Math.min(r.left, innerWidth - tip.offsetWidth - 8))}px`;
    tip.style.top = `${top}px`;
  }

  $("library").addEventListener("scroll", hideTip);
  $("search").addEventListener("scroll", hideTip);

  // library
  let library = [];
  let myPlaylists = []; // playlists this account can edit
  let filter = ["album", "playlist", "show"].includes(store.get("filter")) ? store.get("filter") : "all";
  const paintFilter = () =>
    document.querySelectorAll("#filters button").forEach((b) => b.classList.toggle("on", b.dataset.filter === filter));
  paintFilter();
  let sort = store.get("sort") || "added";
  $("sort").value = sort;

  // Last-played times per album/playlist: recorded here as things play, and
  // topped up from Spotify's recent history (which only covers the last 50 tracks).
  let played = {};
  try { played = JSON.parse(store.get("played") || "{}"); } catch {}

  function notePlayed(uri, when = Date.now()) {
    if (!uri || when - (played[uri] || 0) < 60000) return;
    played[uri] = when;
    store.set("played", JSON.stringify(played));
  }

  async function loadRecentlyPlayed() {
    // Sessions from before this scope was requested get a 403 here; that's fine.
    const recent = await api("/me/player/recently-played?limit=50").catch(() => null);
    for (const entry of recent?.items || []) {
      const when = Date.parse(entry.played_at);
      if (entry.context?.uri && when > (played[entry.context.uri] || 0)) played[entry.context.uri] = when;
    }
    store.set("played", JSON.stringify(played));
    if (sort === "played") renderLibrary();
  }

  const sortKey = (text) => (text || "").toLowerCase().replace(/^the\s+/, "");
  const byText = (a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { numeric: true });
  const SORTS = {
    added: null, // the order loadLibrary builds: playlists, then newest saved first
    played: (a, b) => (played[b.uri] || 0) - (played[a.uri] || 0),
    artist: (a, b) => byText(a.by, b.by) || byText(a.title, b.title),
    title: (a, b) => byText(a.title, b.title),
  };

  async function loadLibrary() {
    const grid = $("library-grid");
    grid.replaceChildren(el("div", { className: "empty", textContent: "Loading your library…" }));
    const [albums, playlists, shows, me] = await Promise.all([
      fetchAll("/me/albums"),
      fetchAll("/me/playlists"),
      fetchAll("/me/shows").catch(() => []),
      api("/me").catch(() => null),
    ]);
    myPlaylists = playlists.filter((p) => p && (p.collaborative || (me && p.owner?.id === me.id)));
    const dated = [
      ...albums.filter((x) => x?.album).map((x) => ({ ...toItem.album(x.album), added: x.added_at })),
      ...shows.filter((x) => x?.show).map((x) => ({ ...toItem.show(x.show), added: x.added_at })),
    ].sort((a, b) => (b.added || "").localeCompare(a.added || ""));
    library = [...playlists.filter(Boolean).map(toItem.playlist), ...dated];
    renderLibrary();
    loadRecentlyPlayed();
  }

  function renderLibrary() {
    let items = filter === "all" ? library : library.filter((i) => i.type === filter);
    if (SORTS[sort]) items = [...items].sort(SORTS[sort]);
    renderGrid($("library-grid"), items, "Nothing saved here yet.");
  }

  $("filters").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    filter = btn.dataset.filter;
    store.set("filter", filter);
    paintFilter();
    renderLibrary();
  });

  $("sort").addEventListener("change", (e) => {
    sort = e.target.value;
    store.set("sort", sort);
    renderLibrary();
    e.target.blur();
  });

  // search
  let searchTimer = null;
  let searchSeq = 0;
  // Scope switch: on = only what's saved in the library, off = all of Spotify.
  const scopeToggle = $("scope-toggle");
  scopeToggle.checked = store.get("searchScope") !== "all";

  function updateSearch() {
    clearTimeout(searchTimer);
    searchSeq++;
    const libraryOnly = scopeToggle.checked;
    $("scope-label").textContent = libraryOnly ? "My library" : "All of Spotify";
    $("search-input").placeholder = libraryOnly ? "Search your library" : "Search Spotify";
    const q = $("search-input").value.trim();
    if (!q) { $("search-grid").replaceChildren(); return; }
    if (libraryOnly) searchLibrary(q);
    else searchTimer = setTimeout(() => runSearch(q), 300);
  }

  function searchLibrary(q) {
    const words = q.toLowerCase().split(/\s+/);
    const hits = library.filter((item) => {
      const text = `${item.title} ${item.sub}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    renderGrid($("search-grid"), hits, "Nothing in your library matches.");
  }

  $("search-input").addEventListener("input", updateSearch);
  scopeToggle.addEventListener("change", () => {
    store.set("searchScope", scopeToggle.checked ? "library" : "all");
    updateSearch();
    $("search-input").focus();
  });
  updateSearch();

  async function runSearch(q) {
    const seq = ++searchSeq;
    try {
      const params = new URLSearchParams({ q, type: "album,track,playlist", limit: "10" });
      const res = await api(`/search?${params}`);
      if (seq !== searchSeq) return;
      const pick = (key, kind) => (res[key]?.items || []).filter(Boolean).map(toItem[kind]);
      renderGrid(
        $("search-grid"),
        [...pick("albums", "album"), ...pick("tracks", "track"), ...pick("playlists", "playlist")],
        "No results.",
      );
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- controls, keys, toast ----------

  $("toggle").addEventListener("click", togglePlay);
  $("next").addEventListener("click", () => player?.nextTrack());
  $("prev").addEventListener("click", () => player?.previousTrack());
  $("nav").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (btn) show(btn.dataset.view);
  });

  document.addEventListener("keydown", (e) => {
    if ($("nav").hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape" && menuFor) return closeMenu();
    if (e.target === scopeToggle) return;
    if (e.target === $("search-input")) {
      if (e.key === "Escape") show("library");
      return;
    }
    const actions = {
      " ": togglePlay,
      ArrowRight: () => player?.nextTrack(),
      ArrowLeft: () => player?.previousTrack(),
      1: () => show("cover"),
      2: () => show("library"),
      3: () => show("search"),
      "/": () => show("search"),
    };
    if (actions[e.key]) {
      e.preventDefault();
      actions[e.key]();
    }
  });

  let toastTimer = null;
  function toast(text, ok = false) {
    const t = $("toast");
    t.classList.toggle("ok", ok);
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  }

  // ---------- boot ----------

  function showSetup(...children) {
    $("setup").replaceChildren(...children);
    show("setup");
  }

  async function boot() {
    if (!CLIENT_ID) {
      showSetup(
        el("h1", { textContent: "One-time setup" }),
        el("ol", {},
          el("li", {}, "Go to developer.spotify.com/dashboard and create an app."),
          el("li", {}, "Add this Redirect URI: ", el("code", { textContent: REDIRECT_URI })),
          el("li", {}, "Tick “Web API” and “Web Playback SDK”, then save."),
          el("li", {}, "Copy the Client ID into ", el("code", { textContent: "public/config.js" }), " and reload."),
        ),
      );
      return;
    }

    const params = new URLSearchParams(location.search);
    if (params.get("error")) {
      history.replaceState(null, "", "/");
      toast(`Spotify sign-in was cancelled (${params.get("error")}).`);
    } else if (params.get("code")) {
      const code = params.get("code");
      history.replaceState(null, "", "/");
      try {
        await tokenRequest({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: store.get("verifier") || "",
        });
      } catch (e) {
        toast(e.message);
      }
    }

    try {
      await getToken();
    } catch {
      showSetup(
        el("h1", { textContent: "Simplify" }),
        el("p", { textContent: "Sign in with your Spotify Premium account." }),
        el("button", { className: "primary", textContent: "Sign in with Spotify", onclick: login }),
      );
      return;
    }

    // Features added since this session signed in need extra permissions; ask once.
    const granted = (store.get("scope") || "").split(" ");
    if (SCOPES.split(" ").some((s) => !granted.includes(s)) && store.get("scopeAsked") !== SCOPES) {
      store.set("scopeAsked", SCOPES);
      return login();
    }

    $("nav").hidden = false;
    $("controls").hidden = false;
    show("library");
    initPlayer().catch((e) => toast(e.message));
    loadLibrary().catch((e) => {
      if (e.status === 401 || e.status === 403) return logout();
      $("library-grid").replaceChildren(el("div", { className: "empty", textContent: e.message }));
    });
  }

  boot();
})();
