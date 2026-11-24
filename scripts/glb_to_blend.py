"""在 Blender 无界面模式下把 GLB 转成自包含的 .blend。

用法:
    blender --background --factory-startup --python glb_to_blend.py -- input.glb output.blend [--no-compress]

流程: 清空场景 -> 导入 GLB -> 打包全部外部资源 -> 压缩保存。
"""
import os
import sys

import bpy


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    if len(argv) < 2:
        print("用法: blender --background --python glb_to_blend.py -- input.glb output.blend [--no-compress]")
        sys.exit(1)
    compress = "--no-compress" not in argv
    args = [a for a in argv if not a.startswith("--")]
    return os.path.abspath(args[0]), os.path.abspath(args[1]), compress


def main():
    src, dst, compress = parse_args()
    if not os.path.exists(src):
        raise SystemExit("找不到输入文件: %s" % src)
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("导入后没有任何网格对象")
    for o in meshes:
        print("OBJ: %s  verts=%d  polys=%d" % (o.name, len(o.data.vertices), len(o.data.polygons)))

    for img in bpy.data.images:
        if img.source == "FILE" or img.packed_file:
            try:
                img.pack()
            except Exception as exc:  # noqa: BLE001
                print("PACK_IMAGE_FAIL:", img.name, exc)
    try:
        bpy.ops.file.pack_all()
    except Exception as exc:  # noqa: BLE001
        print("PACK_ALL_FAIL:", exc)

    packed = [(i.name, bool(i.packed_file), tuple(i.size)) for i in bpy.data.images]
    for name, is_packed, size in packed:
        print("IMG: %s  %sx%s  packed=%s" % (name, size[0], size[1], is_packed))

    bpy.ops.wm.save_as_mainfile(filepath=dst, compress=compress)
    print("SAVED:", dst, os.path.getsize(dst), "bytes")


if __name__ == "__main__":
    main()
