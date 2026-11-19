const stickRadius = 45;
const stickDeadZone = 5;

export function createTouchControls({overlay, stick, jump, crouch, look, pause}) {
  const coarsePointer = window.matchMedia('(pointer: coarse)');
  let movement = null;
  let view = null;
  let crouchPointer = null;
  let jumpQueued = false;
  let forward = 0;
  let side = 0;

  function setTouchMode(enabled) {
    document.documentElement.classList.toggle('touch-mode', enabled);
  }

  function updateStick(x, y) {
    const dx = x - movement.x;
    const dy = y - movement.y;
    const distance = Math.hypot(dx, dy);
    const visualScale = Math.min(1, stickRadius / Math.max(distance, 1));
    const strength = Math.max(0, Math.min(1, (distance - stickDeadZone) / (stickRadius - stickDeadZone)));
    side = strength * dx / Math.max(distance, 1);
    forward = -strength * dy / Math.max(distance, 1);
    stick.style.setProperty('--stick-dx', `${dx * visualScale}px`);
    stick.style.setProperty('--stick-dy', `${dy * visualScale}px`);
  }

  function release(pointer) {
    if (pointer === movement?.id) {
      movement = null;
      forward = 0;
      side = 0;
      stick.removeAttribute('style');
    }
    if (pointer === view?.id) view = null;
    if (pointer === crouchPointer) {
      crouchPointer = null;
      crouch.classList.remove('held');
    }
  }

  function setActive(active) {
    overlay.hidden = !active;
    if (active) return;
    for (const id of [movement?.id, view?.id, crouchPointer]) {
      if (id == null) continue;
      if (overlay.hasPointerCapture(id)) overlay.releasePointerCapture(id);
      release(id);
    }
    jumpQueued = false;
  }

  overlay.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    const {pointerId: id, clientX: x, clientY: y} = event;
    const button = event.target.closest('button');
    if (button === jump) {
      event.preventDefault();
      jumpQueued = true;
      return;
    }
    if (button && button !== crouch) return;
    if (button === crouch) {
      if (crouchPointer != null) return;
      crouchPointer = id;
      crouch.classList.add('held');
    } else if (x < overlay.clientWidth / 2) {
      if (movement) return;
      movement = {id, x, y};
      stick.style.setProperty('--stick-x', `${x}px`);
      stick.style.setProperty('--stick-y', `${y}px`);
      updateStick(x, y);
    } else {
      if (view) return;
      view = {id, x, y};
    }
    event.preventDefault();
    overlay.setPointerCapture(id);
  });

  overlay.addEventListener('pointermove', event => {
    const {pointerId: id, clientX: x, clientY: y} = event;
    if (id === movement?.id) updateStick(x, y);
    if (id === view?.id) {
      const sensitivity = Math.PI / (2 * Math.max(240, Math.min(overlay.clientWidth, overlay.clientHeight)));
      look((x - view.x) * sensitivity, (y - view.y) * sensitivity);
      view = {id, x, y};
    }
  });

  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    overlay.addEventListener(type, event => release(event.pointerId));
  }
  overlay.addEventListener('contextmenu', event => event.preventDefault());
  jump.addEventListener('click', event => {
    if (event.detail === 0) jumpQueued = true;
  });
  const pauseButton = overlay.querySelector('#touch-pause');
  pauseButton.addEventListener('pointerup', event => {
    if (event.pointerType === 'touch' && pauseButton.contains(document.elementFromPoint(event.clientX, event.clientY))) {
      pause();
    }
  });
  pauseButton.addEventListener('click', () => {
    if (!overlay.hidden) pause();
  });
  setTouchMode(coarsePointer.matches);

  return {
    preferTouch: () => coarsePointer.matches,
    setTouchMode,
    setActive,
    read() {
      const jump = jumpQueued;
      jumpQueued = false;
      return {forward, side, jump, crouch: crouchPointer != null};
    },
  };
}
