(function subscribePrintBell() {
  var NOTIFICATION_SOUND = 'bell_ring';
  var ION_SOUND_PATH = 'https://cdn.jsdelivr.net/gh/IonDen/ion.sound@3.0.7/sounds/';
  var ionInited = false;

  function ensureIonSound() {
    if (ionInited) return;
    if (!window.ion || typeof window.ion.sound !== 'function') return;
    try {
      window.ion.sound({
        sounds: [{ name: NOTIFICATION_SOUND, volume: 0.6, loop: false }],
        path: ION_SOUND_PATH,
        preload: true,
        volume: 0.6,
        multiplay: true,
      });
      ionInited = true;
    } catch (_) {}
  }

  function playLocalFallback(vol) {
    try {
      var url = new URL('../assets/sounds/print-bell.wav', window.location.href);
      var a = new Audio(url.href);
      a.volume = vol;
      a.play().catch(function () {});
    } catch (_) {}
  }

  ensureIonSound();

  window.mira.onPrintBell(function (opts) {
    var v =
      typeof opts.volume === 'number' && Number.isFinite(opts.volume)
        ? Math.min(1, Math.max(0, opts.volume))
        : 0.88;
    if (v <= 0) return;

    ensureIonSound();
    if (ionInited && window.ion && window.ion.sound && typeof window.ion.sound.play === 'function') {
      try {
        window.ion.sound.play(NOTIFICATION_SOUND, { volume: v });
        return;
      } catch (_) {}
    }
    playLocalFallback(v);
  });
})();
