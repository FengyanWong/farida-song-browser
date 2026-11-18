/** Connect the system transport controls to the same video and queue as the page. */
export function connectMediaControls(player) {
  const session = navigator.mediaSession;
  if (!session || typeof session.setActionHandler !== 'function') return;

  const panel = document.getElementById('music-player');
  const video = player.video;
  const registered = new Set();
  let track = null;
  let pageActive = true;

  const current = () => pageActive && !panel.hidden && player.queue[player.index];
  const ready = () => current() && !player.loading && !player.failed &&
    player.handlingFailure !== player.generation && !video.error && video.hasAttribute('src');
  const actions = {
    play() { if (ready() && video.paused) player.resume(player.generation); },
    pause() { if (current() && !video.paused) video.pause(); },
    nexttrack() { if (ready()) player.next(false); },
    previoustrack() { if (ready()) player.previous(); }
  };

  function update() {
    const item = current();
    if (!item) {
      if (!track) return;
      track = null;
      for (const name of registered) session.setActionHandler(name, null);
      registered.clear();
      session.metadata = null;
      session.playbackState = 'none';
      return;
    }
    if (!track) {
      for (const [name, handle] of Object.entries(actions)) {
        try {
          session.setActionHandler(name, handle);
          registered.add(name);
        } catch { /* Some browsers implement only a subset of media actions. */ }
      }
    }
    if (item !== track && typeof window.MediaMetadata === 'function') {
      session.metadata = new MediaMetadata({title: item.display_song_title, artist: item.uploader_name});
    }
    track = item;
    const state = ready() && !video.paused && !video.ended ? 'playing' : 'paused';
    if (session.playbackState !== state) session.playbackState = state;
  }

  // Hidden tabs still receive media controls. Page navigation releases them.
  const observer = new MutationObserver(update);
  observer.observe(panel, {attributes: true, attributeFilter: ['hidden']});
  observer.observe(document.getElementById('player-title'), {childList: true});
  for (const name of ['playing', 'pause', 'ended', 'emptied', 'error']) video.addEventListener(name, update);
  window.addEventListener('pagehide', () => { pageActive = false; update(); });
  window.addEventListener('pageshow', () => { pageActive = true; update(); });
  update();
}
