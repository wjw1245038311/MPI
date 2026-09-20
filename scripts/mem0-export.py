# -*- coding: utf-8 -*-
"""mem0 库导出（P5-1）——只读副本，绝不碰线上库

为什么要复制一份：嵌入式 Qdrant 是**单写者**，服务在跑时目录被锁，
直接打开会 AlreadyLocked。复制后读副本，原件全程不动（回滚点天然存在）。

为什么不用 HTTP API：`GET /v1/memories/all` 走的是 mem0 的 `get_all()`，
默认 `top_k=20`（这就是此前误以为"库里只有 20 条"的原因），且端点不暴露该参数。

用法（在 Code/MPI 下）：
    python scripts/mem0-export.py                       # 默认输出到工作区 tempfile/
    python scripts/mem0-export.py --out D:/x.jsonl

输出：JSONL，每行一条原始 payload（一字不改，映射在 Node 侧做）。
"""
import argparse
import json
import os
import shutil
import sys
import tempfile

SRC = r"E:\MyWorkspace\Work\mem0-data\qdrant"
DEFAULT_OUT = r"E:\MyWorkspace\tempfile\mem0-export.jsonl"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=SRC, help="线上 qdrant 目录（只复制）")
    ap.add_argument("--out", default=DEFAULT_OUT, help="输出 JSONL 路径")
    ap.add_argument("--keep-copy", action="store_true", help="保留副本（默认用完就删）")
    args = ap.parse_args()

    try:
        from qdrant_client import QdrantClient
    except ImportError:
        print("需要 qdrant_client（本机 Python 已装 mem0ai，应自带）", file=sys.stderr)
        return 2

    work = tempfile.mkdtemp(prefix="mem0-export-")
    copy = os.path.join(work, "qdrant")
    try:
        # 只复制 meta.json 与 collection/ —— .lock 是运行中服务的锁，副本不需要
        os.makedirs(copy, exist_ok=True)
        shutil.copy2(os.path.join(args.src, "meta.json"), copy)
        shutil.copytree(os.path.join(args.src, "collection"), os.path.join(copy, "collection"))

        c = QdrantClient(path=copy)
        info = c.get_collection("mem0")
        rows, offset = [], None
        while True:
            batch, offset = c.scroll("mem0", limit=512, offset=offset, with_payload=True, with_vectors=False)
            rows.extend(batch)
            if offset is None:
                break

        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            for r in rows:
                # payload 原样导出；id 也带上（幂等键要用）
                rec = dict(r.payload or {})
                rec["_point_id"] = str(r.id)
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")

        print(f"points_count={info.points_count} 导出={len(rows)} → {args.out}")
        return 0
    finally:
        if args.keep_copy:
            print(f"副本保留在：{copy}")
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
