"""从 .blend 渲染一张预览图，用于验证贴图与形态是否正确。

用法:
    blender --background --factory-startup --python render_blend_preview.py -- model.blend preview.png [宽 高]
"""
import math
import os
import sys

import bpy
from mathutils import Vector


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    if len(argv) < 2:
        print("用法: blender --background --python render_blend_preview.py -- model.blend preview.png [宽 高]")
        sys.exit(1)
    res_x = int(argv[2]) if len(argv) > 2 else 600
    res_y = int(argv[3]) if len(argv) > 3 else 800
    return os.path.abspath(argv[0]), os.path.abspath(argv[1]), res_x, res_y


def main():
    blend, out, res_x, res_y = parse_args()
    bpy.ops.wm.open_mainfile(filepath=blend)

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit(".blend 中没有网格对象")

    ob = meshes[0]
    corners = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    mn = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    mx = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    center = (mn + mx) / 2
    size = mx - mn
    print("BBOX_SIZE:", tuple(round(v, 4) for v in size))

    cam_data = bpy.data.cameras.new("PreviewCam")
    cam = bpy.data.objects.new("PreviewCam", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = center + Vector((0.0, -max(size) * 2.6, size.z * 0.12))
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_data.lens = 60
    bpy.context.scene.camera = cam

    light_data = bpy.data.lights.new("Sun", type="SUN")
    light_data.energy = 4.0
    light = bpy.data.objects.new("Sun", light_data)
    light.rotation_euler = (math.radians(55), 0, math.radians(35))
    bpy.context.collection.objects.link(light)

    world = bpy.data.worlds.new("PreviewWorld")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.05, 0.05, 0.06, 1)
    bg.inputs[1].default_value = 0.6
    bpy.context.scene.world = world

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = res_x
    scene.render.resolution_y = res_y
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = out
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    bpy.ops.render.render(write_still=True)
    print("RENDERED:", out)


if __name__ == "__main__":
    main()
