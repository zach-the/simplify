(() => {
  "use strict";

  const DEVELOPER_TOKEN = (window.APPLE_DEVELOPER_TOKEN || "").trim();

  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  const store = {
    get: (k) => localStorage.getItem(`simplify-am.${k}`),
    set: (k, v) => localStorage.setItem(`simplify-am.${k}`, v),
  };

  // ---------- MusicKit setup ----------

  let music = null;

  function loadMusicKit() {
    return new Promise((resolve, reject) => {
      if (window.MusicKit) return resolve();
      document.addEventListener("musickitloaded", resolve, { once: true });
      const script = el("script", { src: "https://js-cdn.music.apple.com/musickit/v3/musickit.js" });
      script.addEventListener("error", () => reject(new Error("Couldn't load MusicKit JS.")));
      document.head.append(script);
    });
  }

  async function initPlayer() {
    await loadMusicKit();
    await MusicKit.configure({ developerToken: DEVELOPER_TOKEN, app: { name: "Simplify", build: "1.0.0" } });
    music = MusicKit.getInstance();
    music.addEventListener("nowPlayingItemDidChange", onState);
    music.addEventListener("playbackStateDidChange", onState);
    music.addEventListener("mediaPlaybackError", (e) => toast(e?.message || "Playback error."));
  }

  // configure() must only run once per page load; authorize() re-enters boot()
  // without re-touching MusicKit itself.
  let musicReady = null;
  const ensureMusic = () => (musicReady ||= initPlayer());

  // ---------- Apple Music API ----------

  // music.api.music() is MusicKit's authenticated fetch (adds the developer
  // token + music user token itself). Its error shape on a failed request isn't
  // documented precisely; this normalises whatever it throws into Error+status.
  async function api(path, { method = "GET", body, waited = false } = {}) {
    try {
      const res = await music.api.music(path, undefined, {
        fetchOptions: { method, ...(body ? { body: JSON.stringify(body) } : {}) },
      });
      return res.data;
    } catch (e) {
      const status = e?.response?.status || e?.status;
      if (status === 429 && !waited) {
        await new Promise((r) => setTimeout(r, 2000));
        return api(path, { method, body, waited: true });
      }
      const err = new Error(e?.message || "Apple Music error");
      err.status = status;
      throw err;
    }
  }

  async function fetchAll(path) {
    const items = [];
    let url = `${path}?limit=100`;
    while (url) {
      const page = await api(url);
      items.push(...(page?.data || []));
      url = page?.next || null;
    }
    return items;
  }

  // ---------- normalising Apple Music resources into tiles ----------

  const artworkOf = (artwork, size = 300) =>
    artwork?.url ? artwork.url.replace("{w}", size).replace("{h}", size) : null;

  const toItem = {
    album: (a) => ({
      type: "album",
      id: a.id,
      playId: a.attributes?.playParams?.id || a.id,
      title: a.attributes?.name,
      sub: `Album • ${a.attributes?.artistName || ""}`,
      by: a.attributes?.artistName || "",
      image: artworkOf(a.attributes?.artwork, 300),
      cover: artworkOf(a.attributes?.artwork, 640),
      added: a.attributes?.dateAdded,
    }),
    playlist: (p) => ({
      type: "playlist",
      id: p.id,
      playId: p.attributes?.playParams?.id || p.id,
      title: p.attributes?.name,
      sub: p.attributes?.curatorName ? `Playlist • ${p.attributes.curatorName}` : "Playlist",
      by: p.attributes?.curatorName || "",
      image: artworkOf(p.attributes?.artwork, 300),
      cover: artworkOf(p.attributes?.artwork, 640),
      added: p.attributes?.dateAdded,
    }),
    song: (s) => ({
      type: "song",
      id: s.id,
      playId: s.attributes?.playParams?.id || s.id,
      title: s.attributes?.name,
      sub: `Song • ${s.attributes?.artistName || ""}`,
      by: s.attributes?.artistName || "",
      image: artworkOf(s.attributes?.artwork, 300),
    }),
  };

  // ---------- player ----------

  // Last tile explicitly played from a tile (not from skip/auto-advance), so
  // the cover view knows whether a playlist cover is available to flip to.
  let currentContext = null; // { type: "album" | "playlist", id, cover }

  async function play(item, shuffle = false) {
    try {
      music.player.shuffleMode = shuffle ? MusicKit.PlayerShuffleMode.songs : MusicKit.PlayerShuffleMode.off;
      await music.setQueue({ [item.type]: item.playId });
      currentContext = item.type === "song" ? null : { type: item.type, id: item.id, cover: item.cover };
      await music.player.play();
    } catch (e) {
      toast(e.message);
    }
  }

  async function togglePlay() {
    try {
      if (music.player.playbackState === MusicKit.PlaybackStates.playing) await music.player.pause();
      else await music.player.play();
    } catch {
      toast("Pick something from your library first.");
    }
  }

  function currentSongId() {
    const item = music?.player?.nowPlayingItem;
    return item ? item.playParams?.id || item.id : null;
  }

  function onState() {
    const item = music.player.nowPlayingItem;
    const playing = music.player.playbackState === MusicKit.PlaybackStates.playing;
    $("icon-play").toggleAttribute("hidden", playing);
    $("icon-pause").toggleAttribute("hidden", !playing);

    shuffleOn = music.player.shuffleMode === MusicKit.PlayerShuffleMode.songs;
    repeatMode = music.player.repeatMode;
    paintModes();

    if (!item) return;

    $("track").textContent = item.title || "";
    $("artist").textContent = item.artistName || item.albumName || "";
    $("now-track").textContent = $("track").textContent;
    $("now-sub").textContent = [item.artistName, item.albumName].filter(Boolean).join(" · ");
    document.title = `${item.title} · ${item.artistName}`;

    if (playing) notePlayed(currentContext?.id);

    updateArt();
    updateMediaSession(item, playing);
    refreshLike();
    if (menuFor && menuFor !== currentSongId()) closeMenu();
  }

  // ---------- shuffle / repeat ----------

  let shuffleOn = false;
  let repeatMode = 0; // matches MusicKit.PlayerRepeatMode.none; reassigned for real once MusicKit loads
  const REPEAT_ORDER = () => [MusicKit.PlayerRepeatMode.none, MusicKit.PlayerRepeatMode.one, MusicKit.PlayerRepeatMode.all];
  const REPEAT_TITLE = ["Repeat: off", "Repeat: this track", "Repeat: all"];

  function paintModes() {
    $("shuffle").classList.toggle("on", shuffleOn);
    $("shuffle").title = shuffleOn ? "Shuffle: on" : "Shuffle: off";
    $("repeat").classList.toggle("on", repeatMode > 0);
    $("repeat").classList.toggle("one", repeatMode === MusicKit.PlayerRepeatMode.one);
    $("repeat").title = REPEAT_TITLE[REPEAT_ORDER().indexOf(repeatMode)] || REPEAT_TITLE[0];
  }

  $("shuffle").addEventListener("click", () => {
    music.player.shuffleMode = shuffleOn ? MusicKit.PlayerShuffleMode.off : MusicKit.PlayerShuffleMode.songs;
    shuffleOn = !shuffleOn;
    paintModes();
  });
  $("repeat").addEventListener("click", () => {
    const order = REPEAT_ORDER();
    repeatMode = order[(order.indexOf(repeatMode) + 1) % order.length];
    music.player.repeatMode = repeatMode;
    paintModes();
  });

  // ---------- keyboard media keys / system Now Playing ----------

  const media = navigator.mediaSession;
  let mediaTrack = null;

  if (media) {
    const handlers = {
      play: () => music?.player?.play(),
      pause: () => music?.player?.pause(),
      previoustrack: () => music?.player?.skipToPreviousItem(),
      nexttrack: () => music?.player?.skipToNextItem(),
      seekto: (d) => music?.player?.seekToTime(d.seekTime),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { media.setActionHandler(action, handler); } catch {}
    }
  }

  function updateMediaSession(item, playing) {
    if (!media) return;
    if (item.id !== mediaTrack) {
      mediaTrack = item.id;
      const art = item.artworkURL ? item.artworkURL(512) : artworkOf(item.artwork, 512);
      media.metadata = new MediaMetadata({
        title: item.title || "",
        artist: item.artistName || "",
        album: item.albumName || "",
        artwork: art ? [{ src: art }] : [],
      });
    }
    media.playbackState = playing ? "playing" : "paused";
    try {
      media.setPositionState({
        duration: music.player.currentPlaybackDuration || 0,
        position: Math.min(music.player.currentPlaybackTime || 0, music.player.currentPlaybackDuration || 0),
        playbackRate: 1,
      });
    } catch {}
  }

  // ---------- love / add to playlist ----------

  // Apple's ratings endpoint wants a catalog song id; playParams.id is that id
  // even for songs reached through your library.
  let likedFor = null;
  let liked = false;
  const paintLike = () => {
    $("like").classList.toggle("on", liked);
    $("like").title = liked ? "Loved. Click to remove" : "Love";
  };

  async function refreshLike() {
    const id = currentSongId();
    if (!id || id === likedFor) return;
    likedFor = id;
    liked = false;
    paintLike();
    const res = await api(`/v1/me/ratings/songs/${id}`).catch(() => null);
    if (likedFor !== id) return;
    liked = (res?.data || [])[0]?.attributes?.value === 1;
    paintLike();
  }

  $("like").addEventListener("click", async () => {
    const id = currentSongId();
    if (!id) return toast("Play something first.");
    const next = !liked;
    try {
      if (next) await api(`/v1/me/ratings/songs/${id}`, { method: "PUT", body: { type: "rating", attributes: { value: 1 } } });
      else await api(`/v1/me/ratings/songs/${id}`, { method: "DELETE" });
      if (likedFor !== id) return;
      liked = next;
      paintLike();
    } catch (e) {
      toast(e.message);
    }
  });

  // Apple's library-playlist API only supports adding tracks, not removing
  // them, so unlike the Spotify version this menu can't toggle a track back out.
  const playlistTracks = {};
  function playlistSet(id) {
    return (playlistTracks[id] ||= fetchAll(`/v1/me/library/playlists/${id}/tracks`)
      .then((entries) => new Set(entries.map((e) => e.attributes?.playParams?.id || e.id).filter(Boolean)))
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

  let menuFor = null; // song id the open menu is about

  function closeMenu() {
    menuFor = null;
    $("playlist-menu").hidden = true;
  }

  function openMenu() {
    const id = currentSongId();
    if (!id) return toast("Play something first.");
    const menu = $("playlist-menu");
    const name = music.player.nowPlayingItem?.title || "this song";
    menu.replaceChildren(el("div", { className: "heading", textContent: `Add “${name}” to…` }));
    if (!myPlaylists.length) {
      menu.append(el("div", { className: "empty", textContent: "You have no playlists yet." }));
    }

    const rows = new Map();
    const paint = (p, set) => {
      const row = rows.get(p.id);
      row.classList.add("known");
      row.classList.toggle("in", set.has(id));
    };
    for (const p of myPlaylists) {
      const row = el("button", { className: "row" }, el("span", { textContent: p.title }));
      row.addEventListener("click", async () => {
        if (row.classList.contains("in")) return;
        row.classList.add("busy");
        try {
          const set = await playlistSet(p.id);
          await api(`/v1/me/library/playlists/${p.id}/tracks`, { method: "POST", body: { data: [{ id, type: "songs" }] } });
          set.add(id);
          paint(p, set);
          toast(`Added to ${p.title}`, true);
        } catch (e) {
          toast(e.message);
        }
        row.classList.remove("busy");
      });
      rows.set(p.id, row);
      menu.append(row);
    }

    menuFor = id;
    menu.hidden = false;
    const bar = $("controls").getBoundingClientRect();
    const btn = $("add").getBoundingClientRect();
    menu.style.bottom = `${innerHeight - bar.top + 8}px`;
    menu.style.left = `${Math.max(8, Math.min(btn.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;

    const forId = menuFor;
    eachLimited(myPlaylists, 4, async (p) => {
      if (menuFor !== forId) return;
      const set = await playlistSet(p.id).catch(() => null);
      if (set && menuFor === forId) paint(p, set);
    });
  }

  $("add").addEventListener("click", () => ($("playlist-menu").hidden ? openMenu() : closeMenu()));
  document.addEventListener("click", (e) => {
    if (!menuFor || e.target.closest("#playlist-menu, #add")) return;
    closeMenu();
  });

  // ---------- progress ----------

  let seeking = false;

  const clock = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  function paintSeek(ms, dur) {
    const seek = $("seek");
    seek.style.setProperty("--p", dur ? `${(ms / dur) * 100}%` : "0%");
    $("elapsed").textContent = clock(ms);
  }

  function renderProgress() {
    if (seeking || !music?.player) return;
    const dur = (music.player.currentPlaybackDuration || 0) * 1000;
    const pos = (music.player.currentPlaybackTime || 0) * 1000;
    const seek = $("seek");
    seek.max = dur || 1;
    seek.value = pos;
    seek.disabled = !dur;
    $("duration").textContent = clock(dur);
    paintSeek(pos, dur);
  }
  setInterval(renderProgress, 500);

  $("seek").addEventListener("input", (e) => {
    seeking = true;
    paintSeek(Number(e.target.value), Number(e.target.max));
  });
  $("seek").addEventListener("change", (e) => {
    const ms = Number(e.target.value);
    seeking = false;
    music?.player?.seekToTime(ms / 1000).catch(() => {});
    e.target.blur();
  });

  // While a playlist is playing, clicking the artwork flips between the
  // playlist's cover and the current song's album cover.
  let coverMode = store.get("coverMode") === "playlist" ? "playlist" : "album";

  function updateArt() {
    const item = music.player.nowPlayingItem;
    if (!item) return;
    const playlist = currentContext?.type === "playlist" ? currentContext : null;
    $("art").classList.toggle("toggleable", !!playlist);
    let url = item.artworkURL ? item.artworkURL(640) : artworkOf(item.artwork, 640);
    if (playlist && coverMode === "playlist" && playlist.cover) url = playlist.cover;
    const art = $("art");
    if (url && art.getAttribute("src") !== url) {
      art.crossOrigin = "anonymous";
      art.src = url;
    }
  }

  $("art").addEventListener("click", () => {
    if (currentContext?.type !== "playlist") return;
    coverMode = coverMode === "playlist" ? "album" : "playlist";
    store.set("coverMode", coverMode);
    updateArt();
  });

  $("art").addEventListener("error", () => {
    const art = $("art");
    if (art.crossOrigin === null) return;
    const url = art.getAttribute("src");
    art.removeAttribute("crossorigin");
    art.src = url;
  });

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
    '<svg viewBox="0 0 24 24"><path d="M3 7h3.5c5 0 6 10 11 10H21M3 17h3.5c1.6 0 2.8-1 3.9-2.4M21 7h-3.5c-1.6 0-2.8 1-3.9 2.4M18.5 4.5L21 7l-2.5 2.5M18.5 14.5L21 17l-2.5 2.5"/></svg>';

  function renderGrid(grid, items, emptyText) {
    grid.replaceChildren();
    if (!items.length) {
      grid.append(el("div", { className: "empty", textContent: emptyText }));
      return;
    }
    for (const item of items) {
      const tile = el("div", { className: "tile" });
      tile.dataset.title = item.title;
      tile.dataset.sub = item.sub;
      if (item.image) tile.append(el("img", { src: item.image, loading: "lazy", alt: "" }));
      else tile.append(el("span", { textContent: item.title }));

      const actions = el("div", { className: "actions" });
      if (item.type !== "song") {
        const shuffleBtn = el("button", { className: "shuffle", title: "Shuffle", innerHTML: ICON_SHUFFLE });
        shuffleBtn.addEventListener("click", (e) => { e.stopPropagation(); play(item, true); });
        actions.append(shuffleBtn);
      }
      const playBtn = el("button", { className: "play", title: "Play", innerHTML: ICON_PLAY });
      playBtn.addEventListener("click", (e) => { e.stopPropagation(); play(item, false); });
      actions.append(playBtn);
      tile.append(actions);

      tile.addEventListener("click", () => toggleTip(tile));
      tile.addEventListener("mouseleave", hideTip);
      tile.addEventListener("mouseenter", () => {
        const r = tile.getBoundingClientRect();
        const overhang = r.width * 0.25;
        const x = r.left < overhang ? "left" : innerWidth - r.right < overhang ? "right" : "center";
        tile.style.transformOrigin = `${x} center`;
      });
      grid.append(tile);
    }
  }

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
  let myPlaylists = [];
  let filter = ["album", "playlist"].includes(store.get("filter")) ? store.get("filter") : "all";
  const paintFilter = () =>
    document.querySelectorAll("#filters button").forEach((b) => b.classList.toggle("on", b.dataset.filter === filter));
  paintFilter();
  let sort = store.get("sort") || "added";
  $("sort").value = sort;

  // Last-played times per album/playlist, recorded only as things actually
  // play in this app — Apple's recently-played endpoints don't expose
  // timestamps, so (unlike the Spotify version) there's no history to backfill
  // from on first run.
  let played = {};
  try { played = JSON.parse(store.get("played") || "{}"); } catch {}

  function notePlayed(id, when = Date.now()) {
    if (!id || when - (played[id] || 0) < 60000) return;
    played[id] = when;
    store.set("played", JSON.stringify(played));
  }

  const sortKey = (text) => (text || "").toLowerCase().replace(/^the\s+/, "");
  const byText = (a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { numeric: true });
  const SORTS = {
    added: null,
    played: (a, b) => (played[b.id] || 0) - (played[a.id] || 0),
    artist: (a, b) => byText(a.by, b.by) || byText(a.title, b.title),
    title: (a, b) => byText(a.title, b.title),
  };

  async function loadLibrary() {
    const grid = $("library-grid");
    grid.replaceChildren(el("div", { className: "empty", textContent: "Loading your library…" }));
    const [albums, playlists] = await Promise.all([
      fetchAll("/v1/me/library/albums"),
      fetchAll("/v1/me/library/playlists"),
    ]);
    myPlaylists = playlists.filter(Boolean).map(toItem.playlist);
    const dated = albums
      .filter(Boolean)
      .map(toItem.album)
      .sort((a, b) => (b.added || "").localeCompare(a.added || ""));
    library = [...myPlaylists, ...dated];
    renderLibrary();
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
  const scopeToggle = $("scope-toggle");
  scopeToggle.checked = store.get("searchScope") !== "all";

  function updateSearch() {
    clearTimeout(searchTimer);
    searchSeq++;
    const libraryOnly = scopeToggle.checked;
    $("scope-label").textContent = libraryOnly ? "My library" : "All of Apple Music";
    $("search-input").placeholder = libraryOnly ? "Search your library" : "Search Apple Music";
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
      const storefront = music.storefrontId || "us";
      const params = new URLSearchParams({ term: q, types: "albums,songs,playlists", limit: "10" });
      const res = await api(`/v1/catalog/${storefront}/search?${params}`);
      if (seq !== searchSeq) return;
      const pick = (key, kind) => (res?.results?.[key]?.data || []).filter(Boolean).map(toItem[kind]);
      renderGrid(
        $("search-grid"),
        [...pick("albums", "album"), ...pick("songs", "song"), ...pick("playlists", "playlist")],
        "No results.",
      );
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- controls, keys, toast ----------

  $("toggle").addEventListener("click", togglePlay);
  $("next").addEventListener("click", () => music?.player?.skipToNextItem().catch((e) => toast(e.message)));
  $("prev").addEventListener("click", () => music?.player?.skipToPreviousItem().catch((e) => toast(e.message)));
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
      ArrowRight: () => music?.player?.skipToNextItem(),
      ArrowLeft: () => music?.player?.skipToPreviousItem(),
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
    if (!DEVELOPER_TOKEN) {
      showSetup(
        el("h1", { textContent: "One-time setup" }),
        el("ol", {},
          el("li", {}, "Enroll in the Apple Developer Program (developer.apple.com, $99/yr) if you haven't."),
          el("li", {}, "Certificates, Identifiers & Profiles → Keys → create a key with MusicKit enabled, and download the ", el("code", { textContent: ".p8" }), " file (Apple only lets you download it once)."),
          el("li", {}, "Note your Team ID (on the Membership page) and the key's Key ID."),
          el("li", {}, "From the repo root, run ", el("code", { textContent: "node tools/apple-dev-token.js --team <TEAM_ID> --key <KEY_ID> --p8 <path to .p8>" }), "."),
          el("li", {}, "Reload. Re-run that command before the token expires — Apple caps it at 6 months."),
        ),
      );
      return;
    }

    try {
      await ensureMusic();
    } catch (e) {
      showSetup(el("h1", { textContent: "Simplify" }), el("p", { textContent: e.message }));
      return;
    }

    if (!music.isAuthorized) {
      showSetup(
        el("h1", { textContent: "Simplify" }),
        el("p", { textContent: "Sign in with your Apple Music subscription." }),
        el("button", {
          className: "primary",
          textContent: "Sign in with Apple Music",
          onclick: () => music.authorize().then(boot).catch((e) => toast(e.message)),
        }),
      );
      return;
    }

    $("nav").hidden = false;
    $("controls").hidden = false;
    show("library");
    loadLibrary().catch((e) => {
      $("library-grid").replaceChildren(el("div", { className: "empty", textContent: e.message }));
    });
  }

  boot();
})();
