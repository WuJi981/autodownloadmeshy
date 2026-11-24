#!/usr/bin/env python3
"""把浏览器下载目录里捕获的 GLB 一步加工成最终 .blend（自动化管线最后一段）。

用法:
    python finalize_download.py <glb路径> <输出目录> [--name 名称] [--blender blender.exe]
                                [--keep-glb] [--no-preview]

流程: 校验 GLB -> Blender 无界面导入并打包贴图 -> 渲染预览 -> 默认删除中间 GLB。
若任一步失败，保留 GLB 并以非零退出码结束，便于排查。
"""
import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def detect_blender():
    env = os.environ.get("BLENDER_EXE", "").strip()
    if env:
        if not os.path.exists(env):
            raise SystemExit("BLENDER_EXE 指向的文件不存在：%s" % env)
        return env
    candidates = [
        shutil.which("blender"),
        r"C:\Program Files\Blender Foundation\Blender 4.5\blender.exe",
        r"D:\blender\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.4\blender.exe",
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    for base in (r"C:\Program Files\Blender Foundation", r"D:\blender"):
        if os.path.isdir(base):
            for d in sorted(os.listdir(base), reverse=True):
                p = os.path.join(base, d, "blender.exe")
                if os.path.exists(p):
                    return p
    return None


def run(cmd, label):
    print("\n==> %s" % label, flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    for line in (r.stdout or "").splitlines():
        if any(k in line for k in ("OBJ:", "IMG:", "SAVED:", "PACK", "BBOX_SIZE", "RENDERED", "结论", "chunks", "网格", "顶点", "贴图[", "GLB")):
            print("   " + line, flush=True)
    if r.returncode != 0:
        print("!! %s 失败 (exit=%d)" % (label, r.returncode), flush=True)
        print((r.stderr or "")[-1500:], flush=True)
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("glb")
    ap.add_argument("outdir")
    ap.add_argument("--name", default=None)
    ap.add_argument("--blender", default=None)
    ap.add_argument("--keep-glb", action="store_true")
    ap.add_argument("--no-preview", action="store_true")
    a = ap.parse_args()

    glb = os.path.abspath(a.glb)
    if not os.path.exists(glb):
        print("错误：找不到 GLB：%s" % glb)
        return 2
    os.makedirs(a.outdir, exist_ok=True)
    name = a.name or os.path.splitext(os.path.basename(glb))[0]
    blend = os.path.join(a.outdir, name + ".blend")
    preview = os.path.join(a.outdir, name + "_preview.png")
    blender = a.blender or detect_blender()
    if not blender:
        print("错误：找不到 Blender，请用 --blender 指定 blender.exe 路径")
        return 2
    print("Blender:", blender)

    if not run([sys.executable, os.path.join(HERE, "verify_glb.py"), glb], "校验 GLB"):
        return 3
    if not run([blender, "--background", "--factory-startup", "--python",
                os.path.join(HERE, "glb_to_blend.py"), "--", glb, blend], "转换为 .blend"):
        return 4
    if not a.no_preview:
        if not run([blender, "--background", "--factory-startup", "--python",
                    os.path.join(HERE, "render_blend_preview.py"), "--", blend, preview], "渲染预览"):
            print("警告：预览渲染失败，.blend 本身已生成")
    if not a.keep_glb:
        try:
            os.remove(glb)
            print("已清理中间 GLB：%s" % glb)
        except OSError as e:
            print("警告：清理 GLB 失败：%s" % e)

    print("\n完成：")
    print("  .blend : %s (%d bytes)" % (blend, os.path.getsize(blend)))
    if os.path.exists(preview):
        print("  预览   : %s" % preview)
    return 0


if __name__ == "__main__":
    sys.exit(main())
