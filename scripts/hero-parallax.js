(() => {
  const landscape = document.querySelector('#hero > .hero-landscape');
  if (!landscape || !window.matchMedia || !('IntersectionObserver' in window)) return;

  const hero = landscape.parentElement;
  const motion = matchMedia('(prefers-reduced-motion: no-preference)');
  let visible = false;
  let frame = null;
  let lastFrame = null;
  let pointer = null;
  let pointerX = 0;
  let pointerY = 0;

  function requestFrame() {
    if (visible && motion.matches && frame === null) frame = requestAnimationFrame(render);
  }

  function render(time) {
    frame = null;
    if (!visible || !motion.matches) return;

    const { top, right, bottom, left, width, height } = hero.getBoundingClientRect();
    const scrollY = Math.min(Math.max(0, -top) * .14, height * .08);
    const inside = pointer && pointer.x >= left && pointer.x <= right && pointer.y >= top && pointer.y <= bottom;
    const targetX = inside ? ((pointer.x - left) / width * 2 - 1) * 8 : 0;
    const targetY = inside ? ((pointer.y - top) / height * 2 - 1) * 6 : 0;

    const elapsed = lastFrame === null ? 16 : time - lastFrame;
    const ease = 1 - Math.exp(-elapsed / 85);
    pointerX += (targetX - pointerX) * ease;
    pointerY += (targetY - pointerY) * ease;
    const moving = Math.abs(targetX - pointerX) > .05 || Math.abs(targetY - pointerY) > .05;
    if (!moving) {
      pointerX = targetX;
      pointerY = targetY;
    }

    landscape.style.setProperty('--scroll-y', `${scrollY}px`);
    landscape.style.setProperty('--pointer-x', `${pointerX}px`);
    landscape.style.setProperty('--pointer-y', `${pointerY}px`);
    lastFrame = moving ? time : null;
    if (moving) requestFrame();
  }

  function clearPointer() {
    pointer = null;
    requestFrame();
  }

  function resetPointer() {
    pointer = null;
    pointerX = 0;
    pointerY = 0;
    lastFrame = null;
  }

  function updateMotion() {
    if (!motion.matches) resetPointer();
    requestFrame();
  }

  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) requestFrame();
    else resetPointer();
  });
  observer.observe(hero);

  window.addEventListener('scroll', requestFrame, { passive: true });
  window.addEventListener('resize', requestFrame);
  window.addEventListener('blur', clearPointer);
  hero.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || !motion.matches) return;
    pointer = { x: event.clientX, y: event.clientY };
    requestFrame();
  });
  hero.addEventListener('pointerleave', clearPointer);
  hero.addEventListener('pointercancel', clearPointer);
  if (motion.addEventListener) motion.addEventListener('change', updateMotion);
  else motion.addListener(updateMotion);
})();
