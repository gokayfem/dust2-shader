const SOLID = -2;
const CLIP_EPSILON = 1 / 32;
const STANDING = { headnode: 1, halfHeight: 36, viewHeight: 28, speed: 250 };
const CROUCHED = { headnode: 3, halfHeight: 18, viewHeight: 12, speed: 100 };
const GRAVITY = 800;
const JUMP_SPEED = Math.sqrt(2 * GRAVITY * 45);
const CROUCH_TIME = 0.4;
const CROUCH_DROP = STANDING.halfHeight - CROUCHED.halfHeight;
const STEP_HEIGHT = 18;
const WALKABLE_NORMAL = 0.7;
const FRAME_STEP = 1 / 120;
const SOLID_BRUSH_CLASSES = new Set([
  'func_breakable', 'func_door', 'func_door_rotating', 'func_button',
  'func_pushable', 'func_rotating', 'func_train', 'func_wall',
  'func_wall_toggle', 'momentary_door',
]);

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (v, k) => [v[0] * k, v[1] * k, v[2] * k];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mix = (a, b, fraction) => add(a, scale(subtract(b, a), fraction));
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const vertical = (p, amount) => [p[0], p[1], p[2] + amount];
const horizontalDistanceSquared = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

function parseEntities(text) {
  const entities = [];
  for (const block of text.matchAll(/\{([\s\S]*?)\}/g)) {
    const entity = {};
    for (const [, key, value] of block[1].matchAll(/"([^"]*)"\s*"([^"]*)"/g)) {
      entity[key] = value;
    }
    entities.push(entity);
  }
  return entities;
}

function parseVector(value) {
  return (value ?? '0 0 0').trim().split(/\s+/).map(Number);
}

function parseCollision(bspBuffer) {
  const view = ArrayBuffer.isView(bspBuffer)
    ? new DataView(bspBuffer.buffer, bspBuffer.byteOffset, bspBuffer.byteLength)
    : new DataView(bspBuffer);
  const int = (offset) => view.getInt32(offset, true);
  const short = (offset) => view.getInt16(offset, true);
  const float = (offset) => view.getFloat32(offset, true);
  const vector = (offset) => [float(offset), float(offset + 4), float(offset + 8)];
  if (int(0) !== 30) throw new Error('Player collision requires a GoldSrc BSP version 30 map.');

  function lump(index) {
    const offset = int(4 + index * 8);
    const length = int(8 + index * 8);
    if (offset < 0 || length < 0 || offset + length > view.byteLength) {
      throw new Error(`Invalid BSP lump ${index}.`);
    }
    return { offset, length };
  }

  function records(index, stride, read) {
    const { offset, length } = lump(index);
    if (length % stride) throw new Error(`Invalid BSP record size for lump ${index}.`);
    return Array.from({ length: length / stride }, (_, i) => read(offset + i * stride));
  }

  const entityLump = lump(0);
  const entityBytes = new Uint8Array(view.buffer, view.byteOffset + entityLump.offset, entityLump.length);
  const entities = parseEntities(new TextDecoder().decode(entityBytes));
  const planes = records(1, 20, (offset) => ({
    normal: vector(offset),
    distance: float(offset + 12),
    type: int(offset + 16),
  }));
  const clipNodes = records(9, 8, (offset) => ({
    plane: planes[int(offset)],
    children: [short(offset + 4), short(offset + 6)],
  }));
  const models = records(14, 64, (offset) => ({
    mins: vector(offset),
    maxs: vector(offset + 12),
    origin: vector(offset + 24),
    headnodes: [int(offset + 36), int(offset + 40), int(offset + 44), int(offset + 48)],
  }));

  if (!models.length) throw new Error('BSP is missing the world collision model.');
  const brushes = [{ model: models[0], origin: [0, 0, 0] }];
  for (const entity of entities) {
    if (!SOLID_BRUSH_CLASSES.has(entity.classname) || !/^\*\d+$/.test(entity.model ?? '')) continue;
    if (entity.classname === 'func_wall_toggle' && (Number(entity.spawnflags) & 1)) continue;
    if ((entity.classname === 'func_door' || entity.classname === 'func_door_rotating')
        && (Number(entity.spawnflags) & 8)) continue;

    const model = models[Number(entity.model.slice(1))];
    if (model) {
      const origin = entity.origin ? parseVector(entity.origin) : model.origin;
      const margin = [40, 40, 40];
      brushes.push({
        model,
        origin,
        mins: subtract(add(model.mins, origin), margin),
        maxs: add(add(model.maxs, origin), margin),
      });
    }
  }
  return { entities, clipNodes, brushes };
}

export function createCollision(bspBuffer) {
  const { entities, clipNodes, brushes } = parseCollision(bspBuffer);

  function planeDistance(plane, point) {
    return (plane.type < 3 ? point[plane.type] : dot(plane.normal, point)) - plane.distance;
  }

  function contents(nodeId, point) {
    while (nodeId >= 0) {
      const node = clipNodes[nodeId];
      nodeId = node.children[planeDistance(node.plane, point) < 0 ? 1 : 0];
    }
    return nodeId;
  }

  function traceModel(headnode, start, end) {
    const result = { fraction: 1, normal: null, allSolid: true, startSolid: false };

    function check(nodeId, startFraction, endFraction, a, b) {
      if (nodeId < 0) {
        if (nodeId === SOLID) result.startSolid = true;
        else result.allSolid = false;
        return true;
      }

      const { plane, children } = clipNodes[nodeId];
      const da = planeDistance(plane, a);
      const db = planeDistance(plane, b);
      if (da >= 0 && db >= 0) return check(children[0], startFraction, endFraction, a, b);
      if (da < 0 && db < 0) return check(children[1], startFraction, endFraction, a, b);

      const near = da < 0 ? 1 : 0;
      const offset = near === 0 ? CLIP_EPSILON : -CLIP_EPSILON;
      const split = clamp((da - offset) / (da - db), 0, 1);
      const middleFraction = startFraction + (endFraction - startFraction) * split;
      const middle = mix(a, b, split);
      if (!check(children[near], startFraction, middleFraction, a, middle)) return false;

      if (contents(children[1 - near], middle) !== SOLID) {
        return check(children[1 - near], middleFraction, endFraction, middle, b);
      }
      if (result.allSolid) return false;

      result.normal = near === 0 ? plane.normal : scale(plane.normal, -1);
      // A hull can contain overlapping axial and bevel planes. Move the contact
      // back to the free side before starting a second sweep at the same point.
      let freeFraction = middleFraction;
      if (contents(headnode, middle) === SOLID) {
        let solidFraction = middleFraction;
        freeFraction = startFraction;
        for (let i = 0; i < 12; i++) {
          const candidate = (freeFraction + solidFraction) * 0.5;
          if (contents(headnode, mix(start, end, candidate)) === SOLID) solidFraction = candidate;
          else freeFraction = candidate;
        }
      }
      result.fraction = freeFraction;
      return false;
    }

    check(headnode, 0, 1, start, end);
    if (result.allSolid) result.fraction = 0;
    return result;
  }

  function trace(start, end, crouched = false) {
    const hull = crouched ? CROUCHED : STANDING;
    let result = { fraction: 1, normal: null, allSolid: false, startSolid: false };
    for (const { model, origin, mins, maxs } of brushes) {
      if (mins && mins.some((minimum, axis) => (
        Math.max(start[axis], end[axis]) < minimum || Math.min(start[axis], end[axis]) > maxs[axis]
      ))) continue;
      const local = traceModel(model.headnodes[hull.headnode], subtract(start, origin), subtract(end, origin));
      const startSolid = result.startSolid || local.startSolid;
      if (local.fraction < result.fraction) result = local;
      result.startSolid = startSolid;
      if (result.allSolid) break;
    }
    return { ...result, end: mix(start, end, result.fraction) };
  }

  function isSolid(point, crouched = false) {
    const hull = crouched ? CROUCHED : STANDING;
    return brushes.some(({ model, origin, mins, maxs }) => (
      (!mins || mins.every((minimum, axis) => point[axis] >= minimum && point[axis] <= maxs[axis]))
      && contents(model.headnodes[hull.headnode], subtract(point, origin)) === SOLID
    ));
  }

  return { entities, isSolid, trace };
}

function clipVelocity(velocity, normal) {
  const intoPlane = dot(velocity, normal);
  return subtract(velocity, scale(normal, Math.min(0, intoPlane)));
}

function slide(collision, origin, initialVelocity, dt, crouched) {
  let position = origin;
  let velocity = initialVelocity;
  let remaining = dt;
  const planes = [];

  for (let i = 0; i < 4 && remaining > 0; i++) {
    if (dot(velocity, velocity) < 0.00001) break;
    const hit = collision.trace(position, add(position, scale(velocity, remaining)), crouched);
    position = hit.end;
    if (hit.allSolid) return { position, velocity: [0, 0, 0], blocked: true };
    if (!hit.normal) break;
    remaining *= 1 - hit.fraction;
    planes.push(hit.normal);

    let candidate = null;
    for (const plane of planes) {
      const clipped = clipVelocity(velocity, plane);
      if (planes.every((other) => dot(clipped, other) >= -0.0001)) {
        candidate = clipped;
        break;
      }
    }
    if (!candidate && planes.length === 2) {
      const crease = cross(planes[0], planes[1]);
      const lengthSquared = dot(crease, crease);
      if (lengthSquared > 0.0001) candidate = scale(crease, dot(velocity, crease) / lengthSquared);
    }
    if (!candidate || dot(candidate, initialVelocity) <= 0) {
      return { position, velocity: [0, 0, 0], blocked: true };
    }
    velocity = candidate;
  }
  return { position, velocity, blocked: planes.length > 0 };
}

function stepAndSlide(collision, origin, velocity, dt, crouched, grounded) {
  const direct = slide(collision, origin, velocity, dt, crouched);
  if (!grounded || !direct.blocked) return direct;

  const up = collision.trace(origin, vertical(origin, STEP_HEIGHT), crouched);
  if (up.allSolid || up.fraction === 0) return direct;
  const elevated = slide(collision, up.end, velocity, dt, crouched);
  const down = collision.trace(elevated.position, vertical(elevated.position, -STEP_HEIGHT - 2), crouched);
  if (!down.normal || down.normal[2] < WALKABLE_NORMAL) return direct;
  if (horizontalDistanceSquared(origin, down.end) <= horizontalDistanceSquared(origin, direct.position)) {
    return direct;
  }
  return { position: down.end, velocity: [elevated.velocity[0], elevated.velocity[1], direct.velocity[2]] };
}

export function createMovement(bspBuffer) {
  const collision = createCollision(bspBuffer);
  let position = [0, 0, 0];
  let velocity = [0, 0, 0];
  let crouched = false;
  let crouchElapsed = 0;
  let grounded = false;
  let jumpWasDown = false;
  let spawnYaw = 0;
  let viewOffset = STANDING.viewHeight;
  const spawns = {
    T: collision.entities.filter((entity) => entity.classname === 'info_player_deathmatch'),
    CT: collision.entities.filter((entity) => entity.classname === 'info_player_start'),
  };

  function floorAt(point, distance = 2) {
    const floor = collision.trace(point, vertical(point, -distance), crouched);
    return floor.normal?.[2] >= WALKABLE_NORMAL ? floor.end : null;
  }

  function reset(team = 'T') {
    const candidates = [...(spawns[team] ?? spawns.T), ...spawns.T, ...spawns.CT];
    crouched = false;
    crouchElapsed = 0;
    let spawn = null;
    let origin = null;
    findSpawn: for (const candidate of candidates) {
      const base = parseVector(candidate.origin);
      for (const lift of [0, 1, 8, 18, 36]) {
        const point = vertical(base, lift);
        if (collision.isSolid(point)) continue;
        const candidateOrigin = floorAt(point, 192) ?? point;
        const degrees = candidate.angles ? parseVector(candidate.angles)[1] : Number(candidate.angle ?? 0);
        const angle = degrees * Math.PI / 180;
        const lookAhead = add(candidateOrigin, [Math.cos(angle) * 192, Math.sin(angle) * 192, 0]);
        const hasRoom = collision.trace(candidateOrigin, lookAhead).fraction === 1;
        if (!origin || hasRoom) {
          origin = candidateOrigin;
          spawn = candidate;
        }
        if (hasRoom) break findSpawn;
        break;
      }
    }
    if (!origin) throw new Error('BSP has no usable player spawn.');
    position = origin;
    velocity = [0, 0, 0];
    grounded = Boolean(floorAt(position));
    jumpWasDown = false;
    viewOffset = STANDING.viewHeight;
    const degrees = spawn.angles ? parseVector(spawn.angles)[1] : Number(spawn.angle ?? 0);
    spawnYaw = degrees * Math.PI / 180;
    return spawnYaw;
  }

  function updateCrouch(dt, wantCrouch) {
    if (!wantCrouch) crouchElapsed = 0;
    if (wantCrouch === crouched) {
      viewOffset = crouched ? CROUCHED.viewHeight : STANDING.viewHeight;
      return;
    }

    if (wantCrouch && grounded) {
      crouchElapsed = Math.min(crouchElapsed + dt, CROUCH_TIME);
      if (crouchElapsed < CROUCH_TIME) {
        const fraction = crouchElapsed / CROUCH_TIME;
        const blend = fraction * fraction * (3 - 2 * fraction);
        viewOffset = STANDING.viewHeight + blend * (CROUCHED.viewHeight - CROUCH_DROP - STANDING.viewHeight);
        return;
      }
    }

    // Grounded changes keep the feet planted. Airborne changes keep the hull center fixed.
    let adjusted = grounded ? vertical(position, wantCrouch ? -CROUCH_DROP : CROUCH_DROP) : position;
    if (collision.isSolid(adjusted, wantCrouch)) {
      if (!grounded || !wantCrouch) return;
      // The compiled crouch hull can meet a slope slightly above the standing hull's foot level.
      const above = vertical(adjusted, 2);
      if (collision.isSolid(above, true)) return;
      const floor = collision.trace(above, adjusted, true);
      if (!(floor.normal?.[2] >= WALKABLE_NORMAL) || collision.isSolid(floor.end, true)) return;
      adjusted = floor.end;
    }
    position = adjusted;
    crouched = wantCrouch;
    viewOffset = crouched ? CROUCHED.viewHeight : STANDING.viewHeight;
  }

  function simulate(dt, input, yaw, jump) {
    updateCrouch(dt, Boolean(input.crouch));
    const hull = crouched ? CROUCHED : STANDING;

    const floor = velocity[2] <= 0 ? floorAt(position) : null;
    grounded = Boolean(floor);
    if (grounded) {
      position = floor;
      velocity[2] = 0;
      const speed = Math.hypot(velocity[0], velocity[1]);
      if (speed > 0) {
        const remaining = Math.max(speed - Math.max(75, speed) * 4 * dt, 0);
        velocity = scale(velocity, remaining / speed);
      }
    }

    const forward = clamp(Number(input.forward) || 0, -1, 1);
    const side = clamp(Number(input.side) || 0, -1, 1);
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const wish = [forward * cos + side * sin, forward * sin - side * cos, 0];
    const magnitude = Math.hypot(wish[0], wish[1]);
    if (magnitude > 0) {
      const direction = scale(wish, 1 / magnitude);
      const speed = Math.min(1, magnitude) * hull.speed;
      const available = (grounded ? speed : Math.min(speed, 30)) - dot(velocity, direction);
      if (available > 0) velocity = add(velocity, scale(direction, Math.min(available, 10 * speed * dt)));
    }

    if (jump && grounded) {
      velocity[2] = JUMP_SPEED;
      grounded = false;
    }
    if (!grounded) velocity[2] -= GRAVITY * dt / 2;
    ({ position, velocity } = stepAndSlide(collision, position, velocity, dt, crouched, grounded));
    if (!grounded) velocity[2] -= GRAVITY * dt / 2;
    if (grounded || velocity[2] <= 0) {
      const landed = floorAt(position);
      grounded = Boolean(landed);
      if (landed) {
        position = landed;
        velocity[2] = 0;
      }
    }
  }

  function step(dt, input = {}, yaw = spawnYaw) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    let remaining = Math.min(dt, 0.1);
    let jump = Boolean(input.jump) && !jumpWasDown;
    jumpWasDown = Boolean(input.jump);
    while (remaining > 0.000001) {
      const slice = Math.min(remaining, FRAME_STEP);
      simulate(slice, input, yaw, jump);
      remaining -= slice;
      jump = false;
    }
  }

  reset();
  return {
    step,
    reset,
    get eye() { return vertical(position, viewOffset); },
    get origin() { return [...position]; },
    get grounded() { return grounded; },
    get crouched() { return crouched; },
    get spawnYaw() { return spawnYaw; },
  };
}
