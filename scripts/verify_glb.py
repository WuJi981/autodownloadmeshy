#!/usr/bin/env python3
"""校验 GLB 结构并导出内嵌贴图。

用法:
    python verify_glb.py model.glb [--out-dir ./textures] [--json]

检查项: 魔数/版本/声明长度、chunk 布局、mesh/material/image 数量、三角面数、
贴图 MIME 与分辨率(尽力解析)、节点变换、extensionsUsed。
"""
import argparse
import json
import os
import struct
import sys

MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942

EXT_BY_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/ktx2": ".ktx2",
}


def webp_size(b):
    if len(b) < 30 or b[0:4] != b"RIFF" or b[8:12] != b"WEBP":
        return None
    fmt = b[12:16]
    if fmt == b"VP8X":
        return int.from_bytes(b[24:27], "little") + 1, int.from_bytes(b[27:30], "little") + 1
    if fmt == b"VP8 ":
        w = int.from_bytes(b[26:28], "little") & 0x3FFF
        h = int.from_bytes(b[28:30], "little") & 0x3FFF
        return w, h
    if fmt == b"VP8L":
        bits = int.from_bytes(b[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    return None


def png_size(b):
    if len(b) < 24 or b[1:4] != b"PNG":
        return None
    return int.from_bytes(b[16:20], "big"), int.from_bytes(b[20:24], "big")


def jpeg_size(b):
    if len(b) < 4 or b[0:2] != b"\xff\xd8":
        return None
    i = 2
    while i < len(b) - 9:
        if b[i] != 0xFF:
            i += 1
            continue
        marker = b[i + 1]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3):
            h = int.from_bytes(b[i + 5:i + 7], "big")
            w = int.from_bytes(b[i + 7:i + 9], "big")
            return w, h
        seg_len = int.from_bytes(b[i + 2:i + 4], "big")
        i += 2 + seg_len
    return None


def inspect(path, out_dir=None):
    data = open(path, "rb").read()
    report = {"file": os.path.abspath(path), "bytes": len(data)}

    if len(data) < 12:
        raise SystemExit("文件过短，不是 GLB")
    magic, version, length = struct.unpack_from("<III", data, 0)
    report["magic"] = hex(magic)
    report["version"] = version
    report["declaredLength"] = length
    report["lengthMatches"] = (length == len(data))
    if magic != MAGIC:
        raise SystemExit("魔数不是 glTF：%s" % hex(magic))

    chunks = []
    off = 12
    while off + 8 <= len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        label = ctype.to_bytes(4, "little").decode("latin1").replace("\x00", "")
        chunks.append({"type": label, "length": clen, "offset": off})
        off += 8 + clen
        if off > len(data):
            break
    report["chunks"] = chunks

    json_chunk = next((c for c in chunks if c["type"] == "JSON"), None)
    if not json_chunk:
        raise SystemExit("缺少 JSON chunk")
    gltf = json.loads(data[json_chunk["offset"] + 8:json_chunk["offset"] + 8 + json_chunk["length"]].decode("utf-8"))
    bin_chunk = next((c for c in chunks if c["type"].startswith("BIN")), None)
    binary = data[bin_chunk["offset"] + 8:bin_chunk["offset"] + 8 + bin_chunk["length"]] if bin_chunk else b""

    report["generator"] = gltf.get("asset", {}).get("generator")
    report["meshes"] = len(gltf.get("meshes", []))
    report["nodes"] = len(gltf.get("nodes", []))
    report["materials"] = len(gltf.get("materials", []))
    report["textures"] = len(gltf.get("textures", []))
    report["extensionsUsed"] = gltf.get("extensionsUsed", [])
    report["extensionsRequired"] = gltf.get("extensionsRequired", [])

    triangles = 0
    accessors = gltf.get("accessors", [])
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            idx = prim.get("indices")
            if idx is not None and idx < len(accessors):
                triangles += accessors[idx].get("count", 0) // 3
    report["triangles"] = triangles
    report["vertices"] = max([accessors[prim["attributes"]["POSITION"]].get("count", 0)
                              for mesh in gltf.get("meshes", [])
                              for prim in mesh.get("primitives", [])
                              if "POSITION" in prim.get("attributes", {})] or [0])

    images = []
    names = ["basecolor", "metallicRoughness", "normal"]
    for i, img in enumerate(gltf.get("images", [])):
        mime = img.get("mimeType", "")
        entry = {"index": i, "mimeType": mime, "name": img.get("name")}
        bv_idx = img.get("bufferView")
        if bv_idx is not None and bv_idx < len(gltf.get("bufferViews", [])):
            bv = gltf["bufferViews"][bv_idx]
            start = bv.get("byteOffset", 0)
            payload = binary[start:start + bv["byteLength"]]
            entry["bytes"] = len(payload)
            size = None
            if mime == "image/webp":
                size = webp_size(payload)
            elif mime == "image/png":
                size = png_size(payload)
            elif mime == "image/jpeg":
                size = jpeg_size(payload)
            if size:
                entry["width"], entry["height"] = size
            if out_dir:
                os.makedirs(out_dir, exist_ok=True)
                base = names[i] if i < len(names) else "texture_%d" % i
                out_path = os.path.join(out_dir, base + EXT_BY_MIME.get(mime, ".bin"))
                with open(out_path, "wb") as fh:
                    fh.write(payload)
                entry["savedTo"] = os.path.abspath(out_path)
        images.append(entry)
    report["images"] = images
    report["nodesDetail"] = gltf.get("nodes", [])
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("glb")
    ap.add_argument("--out-dir", default=None, help="导出内嵌贴图的目录")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出报告")
    args = ap.parse_args()

    report = inspect(args.glb, args.out_dir)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    print("文件:", report["file"])
    print("字节:", report["bytes"], "| 声明长度一致:", report["lengthMatches"])
    print("chunks:", ", ".join("%s(%d)" % (c["type"], c["length"]) for c in report["chunks"]))
    print("生成器:", report["generator"])
    print("网格 %d / 节点 %d / 材质 %d / 贴图 %d" % (
        report["meshes"], report["nodes"], report["materials"], report["textures"]))
    print("顶点 %d / 三角面 %d" % (report["vertices"], report["triangles"]))
    print("扩展:", ", ".join(report["extensionsUsed"]) or "无")
    for img in report["images"]:
        print("贴图[%d] %s %sx%s %s%s" % (
            img["index"], img["mimeType"], img.get("width", "?"), img.get("height", "?"),
            ("%.1f KB" % (img.get("bytes", 0) / 1024)),
            (" -> " + img["savedTo"]) if img.get("savedTo") else ""))
    ok = report["lengthMatches"] and report["triangles"] > 0 and report["meshes"] > 0
    print("结论:", "GLB 结构完整" if ok else "存在异常，请检查")
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
