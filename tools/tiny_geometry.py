"""Encode the lossless BSP subset used by the compact game."""

import math
import re
import struct


SIGN = 0x80000000
MAGNITUDE = SIGN - 1
VERTEX_CACHE = 24
NEIGHBOR_CACHE = 6
ENTITY_KEYS = {
    b"classname", b"model", b"origin", b"angle", b"angles", b"rendermode",
    b"renderamt", b"rendercolor", b"spawnflags", b"target", b"style",
    b"skyname", b"texture", b"targetname",
}
SOLID_BRUSH_CLASSES = {
    b"func_breakable", b"func_door", b"func_door_rotating", b"func_button",
    b"func_pushable", b"func_rotating", b"func_train", b"func_wall",
    b"func_wall_toggle", b"momentary_door",
}


def records(fmt, data):
    return list(struct.iter_unpack("<" + fmt, data))


def block(data):
    return struct.pack("<I", len(data)) + data


def columns(fmt, values):
    width = struct.calcsize(fmt)
    packed = struct.pack(f"<{len(values)}{fmt}", *values)
    return b"".join(packed[i::width] for i in range(width))


def varints(values):
    data = bytearray()
    for value in values:
        if value < 0:
            raise ValueError("Geometry varints must be unsigned")
        while value >= 128:
            data.append((value & 127) | 128)
            value >>= 7
        data.append(value)
    return data


def entity_records(source):
    return [
        dict(re.findall(rb'"([^"]*)"\s*"([^"]*)"', source_entity))
        for source_entity in re.findall(rb"\{([^{}]*)\}", source)
    ]


def entities(records):
    result = bytearray()
    for fields in records:
        kind = fields[b"classname"]
        if not (
            kind in (b"worldspawn", b"info_player_start", b"info_player_deathmatch", b"infodecal")
            or re.fullmatch(rb"\*\d+", fields.get(b"model", b""))
            or (kind.startswith(b"light") and int(fields.get(b"style", b"0")) >= 32)
        ):
            continue
        result += b"{\n"
        for name, value in fields.items():
            if name in ENTITY_KEYS:
                result += b'"' + name + b'" "' + value + b'"\n'
        result += b"}\n"
    return block(result)


def descriptors(source):
    count = struct.unpack_from("<i", source)[0]
    result = bytearray(struct.pack("<H", count))
    for (offset,) in records("i", source[4:4 + count * 4]):
        if offset < 4 + count * 4:
            result.append(0)
            continue
        name, width, height = struct.unpack_from("<16sII", source, offset)
        name = name.split(b"\0", 1)[0]
        result.append(len(name))
        result += name + struct.pack("<HH", width, height)
    return result


def planes(original):
    pairs = original[::2]
    if len(original) != 2 * len(pairs):
        raise ValueError("Expected mirrored BSP plane pairs")
    normals = {}
    ids = []
    distances = []
    types = []
    for head, tail in zip(pairs, original[1::2]):
        normal = head[:3]
        distance, kind = head[3:]
        if not 0 <= kind < 8 or tail[3:] != (distance ^ SIGN, kind):
            raise ValueError("Expected each odd BSP plane to mirror its predecessor")
        flags = kind
        for axis, (left, right) in enumerate(zip(normal, tail[:3])):
            if left & MAGNITUDE:
                if right != left ^ SIGN:
                    raise ValueError("BSP plane normals must be mirrored")
            elif right & MAGNITUDE:
                raise ValueError("BSP plane normals must be mirrored")
            elif left ^ right:
                flags |= 1 << (axis + 3)
        ids.append(normals.setdefault(normal, len(normals)))
        distances.append(distance)
        types.append(flags)
    return b"".join((
        struct.pack("<HH", len(pairs), len(normals)),
        columns("I", [value for normal in normals for value in normal]),
        columns("H", ids),
        columns("I", distances),
        bytes(types),
    ))


def vertex_positions(vertices):
    result = bytearray(struct.pack("<H", len(vertices)))
    for axis in zip(*vertices):
        previous = 0
        deltas = []
        residuals = []
        for bits in axis:
            value = struct.unpack("<f", struct.pack("<I", bits))[0]
            if -32768 < value < 32768 and value.is_integer() and bits != SIGN:
                delta = int(value) - previous
                deltas.append((delta * 2 if delta >= 0 else -delta * 2 - 1) + 1)
                previous = int(value)
            else:
                deltas.append(0)
                residuals.append(bits)
        result += varints(deltas)
        result += columns("I", residuals)
    return result


def remember(cache, value, limit):
    if value in cache:
        cache.remove(value)
    cache.insert(0, value)
    del cache[limit:]


def polygon_vertices(faces, edges, surfedges, vertices):
    vertex_ids = {}
    reordered = []
    codes = []
    recent = []
    neighbors = {}
    next_edge = 0
    for _, _, start, count, *_ in faces:
        if start != next_edge:
            raise ValueError("Expected contiguous BSP face surfedges")
        polygon = []
        for index in range(start, start + count):
            (edge,) = surfedges[index]
            source_id = edges[abs(edge)][edge < 0]
            new_id = vertex_ids.get(source_id)
            adjacent = neighbors.get(polygon[-1], []) if polygon else []
            if new_id is None:
                codes.append(0)
                new_id = len(reordered)
                vertex_ids[source_id] = new_id
                reordered.append(vertices[source_id])
            elif new_id in adjacent:
                codes.append(adjacent.index(new_id) + 1)
            elif new_id in recent:
                codes.append(NEIGHBOR_CACHE + recent.index(new_id) + 1)
            else:
                codes.append(NEIGHBOR_CACHE + VERTEX_CACHE + len(reordered) - new_id)
            remember(recent, new_id, VERTEX_CACHE)
            polygon.append(new_id)
        # Update adjacency after the face so both sides use only prior faces.
        for a, b in zip(polygon, polygon[1:] + polygon[:1]):
            remember(neighbors.setdefault(a, []), b, NEIGHBOR_CACHE)
            remember(neighbors.setdefault(b, []), a, NEIGHBOR_CACHE)
        next_edge += count
    if next_edge != len(surfedges):
        raise ValueError("Expected all BSP surfedges to belong to a face")
    return reordered, varints(codes)


def face_columns(faces, planes, texinfo, vertices, edges, surfedges, lighting):
    plane_ids = []
    flags = []
    texture_axes = []
    light_offset = 0
    normals = [struct.unpack("<3f", struct.pack("<3I", *plane[:3])) for plane in planes]

    def projected_span(points, axes):
        sx, sy, sz, bias = axes
        scalar = [(x * sx + y * sy + z * sz) + bias for x, y, z in points]
        lo = struct.unpack("<f", struct.pack("<f", min(scalar)))[0]
        hi = struct.unpack("<f", struct.pack("<f", max(scalar)))[0]
        return math.ceil(hi / 16) - math.floor(lo / 16) + 1

    for plane, side, start, count, axis, s0, s1, s2, s3, offset in faces:
        lit = offset >= 0
        if side not in (0, 1) or not 3 <= count < 64:
            raise ValueError("BSP face flags exceed the compact format")
        if (s0, s1, s2, s3) != (0 if lit else 255, 255, 255, 255):
            raise ValueError("Expected one light style on each lit BSP face")
        points = [
            vertices[edges[abs(edge)][edge < 0]]
            for (edge,) in surfedges[start:start + count]
        ]
        nx, ny, nz = normals[plane]
        area_x = area_y = area_z = 0.0
        for (ax, ay, az), (bx, by, bz) in zip(points, points[1:] + points[:1]):
            area_x += ay * bz - az * by
            area_y += az * bx - ax * bz
            area_z += ax * by - ay * bx
        signed_area = area_x * nx + area_y * ny + area_z * nz
        if not signed_area or (signed_area > 0) != bool(side):
            raise ValueError("Cannot derive the BSP face side from its winding")
        if lit:
            if offset != light_offset:
                raise ValueError("Cannot derive the next BSP light offset exactly")
            axes = texinfo[axis]
            light_offset += 3 * projected_span(points, axes[:4]) * projected_span(points, axes[4:8])
        elif offset != -1:
            raise ValueError("Expected a BSP unlit face offset of -1")
        plane_ids.append(plane)
        flags.append(count | (lit << 7))
        texture_axes.append(axis)
    if light_offset != len(lighting):
        raise ValueError("Derived BSP light charts must account for the whole lighting lump")
    return b"".join((
        struct.pack("<H", len(faces)),
        varints(plane_ids),
        columns("H", texture_axes),
        bytes(flags),
    ))


def clipnodes(clip):
    plane_ids, first_children, second_children = [], [], []
    for index, (plane, first, second) in enumerate(clip):
        if first not in (-2, -1, index + 1) or second < -2 or (second >= 0 and second <= index):
            raise ValueError("Unexpected BSP clip node traversal order")
        plane_ids.append(plane)
        first_children.append(first + 2 if first < 0 else 2)
        second_children.append(second + 2 if second < 0 else second - index + 1)
    return b"".join((
        struct.pack("<H", len(clip)), varints(plane_ids), bytes(first_children),
        varints(second_children),
    ))


def compact_collision(clip, models, entities):
    # Match movement.js: use the standing and crouched hulls for world and
    # solid brushes. The archive omits the draw and large-actor hulls.
    brush_ids = {0}
    for fields in entities:
        kind = fields[b"classname"]
        model = fields.get(b"model", b"")
        if kind not in SOLID_BRUSH_CLASSES or not re.fullmatch(rb"\*\d+", model):
            continue
        flags = int(fields.get(b"spawnflags", b"0"))
        if kind == b"func_wall_toggle" and flags & 1:
            continue
        if kind in (b"func_door", b"func_door_rotating") and flags & 8:
            continue
        model_id = int(model[1:])
        if model_id < len(models):
            brush_ids.add(model_id)

    stack = [models[model][hull] for model in brush_ids for hull in (10, 12)]
    reachable = set()
    while stack:
        index = stack.pop()
        if index >= 0 and index not in reachable:
            reachable.add(index)
            stack.extend(clip[index][1:])

    # Retain original traversal order and keep the signed leaf codes unchanged.
    ordered = sorted(reachable)
    remap = {old: new for new, old in enumerate(ordered)}

    def node_id(value):
        return value if value < 0 else remap[value]

    retained_clip = []
    for index in ordered:
        plane, first, second = clip[index]
        retained_clip.append((plane, node_id(first), node_id(second)))
    retained_models = []
    for index, model in enumerate(models):
        standing = node_id(model[10]) if index in brush_ids else -1
        crouched = node_id(model[12]) if index in brush_ids else -1
        retained_models.append((*model[:9], -1, standing, -1, crouched, *model[13:]))
    return retained_clip, retained_models


def compact_planes(original, faces, clip):
    # Collision requires every original plane coefficient and type. Rendering
    # only reads the normal vector, so faces can share an exact normal.
    pairs = {plane // 2 for plane, _, _ in clip}
    normals = {}
    for pair in sorted(pairs):
        for index in (pair * 2, pair * 2 + 1):
            normals.setdefault(original[index][:3], index)
    for plane, *_ in faces:
        if original[plane][:3] not in normals:
            pair = plane // 2
            pairs.add(pair)
            for index in (pair * 2, pair * 2 + 1):
                normals.setdefault(original[index][:3], index)

    ordered = [index for pair in sorted(pairs) for index in (pair * 2, pair * 2 + 1)]
    remap = {old: new for new, old in enumerate(ordered)}
    face_plane_ids = [remap[normals[plane[:3]]] if plane[:3] in normals else None for plane in original]
    return [original[index] for index in ordered], face_plane_ids, [
        (remap[plane], first, second) for plane, first, second in clip
    ]


def encode_geometry(bsp: bytes) -> bytes:
    """Store the data consumed by readBsp and createMovement, excluding RGB lighting."""
    if struct.unpack_from("<i", bsp)[0] != 30:
        raise ValueError("Expected a BSP30 map")
    lumps = [bsp[offset:offset + size] for offset, size in records("ii", bsp[4:124])]
    source_entities = entity_records(lumps[0])
    clip, models = compact_collision(records("ihh", lumps[9]), records("9I7i", lumps[14]), source_entities)
    faces = records("HHihH4Bi", lumps[7])
    retained_planes, face_plane_ids, clip = compact_planes(records("5I", lumps[1]), faces, clip)
    used_axes = sorted({face[4] for face in faces})
    axis_ids = {old: new for new, old in enumerate(used_axes)}
    faces = [
        (face_plane_ids[plane], side, start, count, axis_ids[axes], *light)
        for plane, side, start, count, axes, *light in faces
    ]
    original_texinfo = records("8fii", lumps[6])
    original_texinfo_bits = records("10I", lumps[6])
    texinfo = [original_texinfo[i] for i in used_axes]
    texinfo_bits = [original_texinfo_bits[i] for i in used_axes]

    vertices = records("3f", lumps[3])
    vertex_bits = records("3I", lumps[3])
    edges = records("HH", lumps[12])
    surfedges = records("i", lumps[13])
    reordered, polygons = polygon_vertices(faces, edges, surfedges, vertex_bits)
    return b"".join((
        b"TG2",
        entities(source_entities),
        descriptors(lumps[2]),
        planes(retained_planes),
        vertex_positions(reordered),
        struct.pack("<H", len(texinfo_bits)),
        *(columns("I", list(axis)) for axis in zip(*texinfo_bits)),
        face_columns(faces, retained_planes, texinfo, vertices, edges, surfedges, lumps[8]),
        polygons,
        clipnodes(clip),
        block(b"".join(struct.pack("<9I7i", *model) for model in models)),
    ))
