import { createRayRenderer } from "./ray-renderer.js";
import { createRenderer } from "./renderer.js";
import { createMovement } from "./movement.js";
import { createChallenge } from "./challenge.js";
import { createTouchControls } from "./touch.js";

const el = (id) => document.getElementById(id);
const canvas = el("world");
const keys = new Set();
const status = el("status");
const fov = 90;
let renderer,
  player,
  yaw = 0,
  pitch = 0,
  playing = false;
let session = null,
  challenge;
let previous = 0,
  accumulator = 0,
  debug = 0;
let dragLook = false,
  dragging = false,
  touchMode = false;
let entryPointer = "";
let jumpQueued = false;
let hits = 0;
let lastShot = -Infinity;
function fire() {
  const now = performance.now();
  if (playing && now-lastShot>=165) {
    lastShot=now;
    if(renderer.shoot?.(player.eye,yaw,pitch)) hits++;
  }
}
el("touch-fire").addEventListener("pointerdown", fire);
let lastDragX = 0, lastDragY = 0;
const touch = createTouchControls({
  overlay: el("touch-controls"),
  stick: el("touch-stick"),
  jump: el("touch-jump"),
  crouch: el("touch-crouch"),
  look: rotateView,
  pause: () => state(false),
});
const tick = 1 / 120;
const preview = { eye: [1568, 3040, 304], target: [1144, 2456, 136] };
const viewYaw = Math.atan2(
  preview.target[1] - preview.eye[1],
  preview.target[0] - preview.eye[0],
);
const viewPitch = Math.atan2(
  preview.target[2] - preview.eye[2],
  Math.hypot(
    preview.target[0] - preview.eye[0],
    preview.target[1] - preview.eye[1],
  ),
);

async function resource(url, image = false) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not load " + url);
  return image
    ? createImageBitmap(await response.blob())
    : response.arrayBuffer();
}
function fit() {
  const w = Math.min(1280, window.innerWidth);
  canvas.width = w;
  canvas.height = Math.max(
    1,
    Math.round((w * window.innerHeight) / window.innerWidth),
  );
}
function chosen() {
  return {
    team: document.querySelector("[name=team]:checked").value,
    mode: el("mode").value,
  };
}
function matches(a, b) {
  return a && a.team === b.team && a.mode === b.mode;
}
function updateButton() {
  el("play").innerHTML =
    (matches(session, chosen()) ? "Resume session" : "Enter map") +
    " <span>→</span>";
}
function restart() {
  yaw = player.reset(session.team);
  pitch = 0;
  jumpQueued = false;
  challenge.reset();
  hits=0;
  renderer.resetTargets?.();
  accumulator = 0;
}
function rotateView(horizontal, vertical) {
  yaw -= horizontal;
  pitch = Math.max(-1.55, Math.min(1.55, pitch - vertical));
}
function state(active) {
  if (playing === active) return;
  playing = active;
  lastShot = -Infinity;
  el("menu").hidden = active;
  el("hud").hidden = !active;
  touch.setActive(active && touchMode);
  keys.clear();
  jumpQueued = false;
  accumulator = 0;
  if (!active) {
    updateButton();
    el("play").focus({ preventScroll: true });
  }
}
function animate(now) {
  const dt = Math.min(0.1, Math.max(0, (now - previous) / 1000));
  previous = now;
  if (playing) {
    accumulator += dt;
    if (keys.has("ArrowLeft")) yaw += 2 * dt;
    if (keys.has("ArrowRight")) yaw -= 2 * dt;
    const keyboard = {
      forward: Number(keys.has("KeyW")) - Number(keys.has("KeyS")),
      side: Number(keys.has("KeyD")) - Number(keys.has("KeyA")),
      jump: keys.has("Space"),
      crouch:
        keys.has("KeyC") || keys.has("ControlLeft") || keys.has("ControlRight"),
    };
    while (accumulator >= tick) {
      keyboard.jump = keys.has("Space") || jumpQueued;
      jumpQueued = false;
      let input = keyboard;
      if (touchMode) {
        const mobile = touch.read();
        input = {
          forward: keyboard.forward + mobile.forward,
          side: keyboard.side + mobile.side,
          jump: keyboard.jump || mobile.jump,
          crouch: keyboard.crouch || mobile.crouch,
        };
      }
      player.step(tick, input, yaw);
      if (session.mode !== "free") challenge.step(player.origin, tick);
      accumulator -= tick;
    }
    el("objective").textContent =
      session.mode === "free"
        ? (renderer.shoot ? "Target hits · "+hits : "Free exploration")
        : ["Reach A site", "Reach B site", "Run complete"][challenge.stage] +
          " · " +
          challenge.seconds.toFixed(1) +
          " s";
  }
  if (session) renderer.draw(player.eye, yaw, pitch, fov, debug, playing ? Math.min(1, Math.max(0, (now-lastShot)/1000)) : -1);
  else renderer.draw(preview.eye, viewYaw, viewPitch, fov, 0);
  requestAnimationFrame(animate);
}
el("entry").addEventListener("change", updateButton);
el("play").addEventListener("pointerdown", (e) => {
  entryPointer = e.pointerType;
});
el("entry").addEventListener("submit", async (e) => {
  e.preventDefault();
  const choice = chosen();
  if (!matches(session, choice)) {
    session = choice;
    restart();
  }
  touchMode = entryPointer === "touch" || touch.preferTouch();
  entryPointer = "";
  touch.setTouchMode(touchMode);
  if (touchMode) {
    state(true);
    canvas.focus({ preventScroll: true });
    status.textContent = "";
    return;
  }
  try {
    await canvas.requestPointerLock();
    if (document.pointerLockElement === canvas) {
      dragLook = false;
      state(true);
    }
    status.textContent = "";
  } catch {
    dragLook = true;
    state(true);
    canvas.focus();
    status.textContent = "Drag to look · Esc opens the menu";
  }
});
document.addEventListener("pointerlockchange", () => {
  if (touchMode) return;
  dragLook = false;
  dragging = false;
  status.textContent = "";
  state(document.pointerLockElement === canvas);
});
canvas.addEventListener("click", () => {
  if (playing && dragLook && !touchMode) {
    canvas.requestPointerLock?.()?.catch(() => {});
  }
});
canvas.addEventListener("pointerdown", (e) => {
  if (e.button === 0 && !touchMode) fire();
  if (playing && dragLook) {
    dragging = true;
    lastDragX = e.clientX;
    lastDragY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  }
});
canvas.addEventListener("pointerup", () => {
  dragging = false;
});
canvas.addEventListener("pointercancel", () => {
  dragging = false;
});
window.addEventListener("blur", () => {
  keys.clear();
  if (document.pointerLockElement) document.exitPointerLock();
  else if (playing) {
    state(false);
    status.textContent = "";
  }
});
window.addEventListener("mousemove", (e) => {
  if (!playing || touchMode || (dragLook && !dragging)) return;
  const dx = dragLook ? e.clientX - lastDragX : e.movementX;
  const dy = dragLook ? e.clientY - lastDragY : e.movementY;
  lastDragX = e.clientX;
  lastDragY = e.clientY;
  rotateView(dx * 0.0022, dy * 0.0022);
});
window.addEventListener("keydown", (e) => {
  if (!playing) return;
  if (e.code === "Escape" && (touchMode || dragLook)) {
    dragging = false;
    status.textContent = "";
    state(false);
    return;
  }
  if (
    [
      "Space",
      "ControlLeft",
      "ControlRight",
      "KeyW",
      "KeyS",
      "KeyA",
      "KeyD",
      "KeyC",
    ].includes(e.code)
  )
    e.preventDefault();
  if (e.code === "KeyF" && !e.repeat) fire();
  if (e.code === "Space" && !e.repeat) jumpQueued = true;
  keys.add(e.code);
  if (e.code === "KeyR" && !e.repeat) restart();
  if (e.code === "F3") {
    e.preventDefault();
    debug = (debug + 1) % 5;
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("resize", fit);
try {
  fit();
  const suffixes = ["ft", "bk", "rt", "lf", "up", "dn"];
  const [map, wads, faces] = await Promise.all([
    resource("assets/de_dust2.bsp"),
    Promise.all(
      ["cs_dust", "base-textures"].map((name) =>
        resource("assets/" + name + ".wad"),
      ),
    ),
    Promise.all(
      suffixes.map((face) => resource("assets/" + face + ".png", true)),
    ),
  ]);
  const factory =
    new URLSearchParams(location.search).get("renderer") === "raster"
      ? createRenderer
      : createRayRenderer;
  renderer = await factory(
    canvas,
    map,
    wads,
    Object.fromEntries(suffixes.map((key, i) => [key, faces[i]])),
  );
  player = createMovement(map);
  challenge = createChallenge(renderer.entities, renderer.models);
  if (new URLSearchParams(location.search).has("inspect")) {
    window.inspector = {
      renderer,
      player,
      canvas,
      get camera() {
        return { eye: player.eye, yaw, pitch, fov };
      },
      get playing() {
        return playing;
      },
      get dragLook() {
        return dragLook;
      },
    };
  }
  if (factory === createRenderer) {
    el("pipeline-name").textContent = "RASTER REFERENCE / WEBGL 2";
    el("shader-link").href = "shaders/bsp.frag.glsl";
  }
  el("play").disabled = false;
  if (el("menu").hidden) {
    session = chosen();
    restart();
    touchMode = touch.preferTouch();
    touch.setTouchMode(touchMode);
    dragLook = !touchMode;
    state(true);
    canvas.focus({ preventScroll: true });
    status.textContent = "";
  } else {
    updateButton();
  }
  requestAnimationFrame(animate);
} catch (error) {
  el("menu").hidden = false;
  console.error(error);
  status.textContent = error.message;
  el("play").textContent = "Map unavailable";
}
