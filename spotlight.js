/* Page-wide cursor spotlight — a warm lantern-gold pool of light that follows the
   pointer. Self-registering: any page that loads this script gets it, with no
   markup of its own. Skipped for reduced-motion and for coarse pointers
   (touch), where there is no cursor to follow. */
(function () {
  if (window.__hsSpotlight) return;
  window.__hsSpotlight = true;

  function init() {
    if (document.getElementById('hs-spotlight')) return;
    var mq = window.matchMedia;
    if (mq && mq('(prefers-reduced-motion: reduce)').matches) return;
    if (mq && mq('(hover: none)').matches) return;

    var el = document.createElement('div');
    el.id = 'hs-spotlight';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed; inset:0; z-index:90; pointer-events:none; opacity:0;' +
      'transition:opacity 900ms ease; will-change:background, opacity; mix-blend-mode:screen; filter:blur(28px);';
    document.body.appendChild(el);

    var x = -400, y = -400, queued = false;
    function paint() {
      queued = false;
      el.style.background = 'radial-gradient(320px circle at ' + x.toFixed(1) + 'px ' + y.toFixed(1) +
        'px, rgba(214,176,110,0.30) 0%, rgba(206,168,104,0.18) 30%, rgba(190,150,88,0.09) 54%, rgba(186,146,84,0.03) 74%, rgba(186,146,84,0) 92%)';
    }
    window.addEventListener('pointermove', function (e) {
      x = e.clientX; y = e.clientY;
      /* The pool of light stays off media — washing a photograph or a playing
         clip reads as a defect, not as lighting. */
      var t = e.target;
      var overMedia = t && t.closest &&
        t.closest('video, img, image-slot, [data-hs-clip], [data-no-spot]');
      el.style.opacity = overMedia ? '0' : '1';
      if (!queued) { queued = true; requestAnimationFrame(paint); }
    }, { passive: true });
    document.addEventListener('pointerleave', function () { el.style.opacity = '0'; });
    window.addEventListener('blur', function () { el.style.opacity = '0'; });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
