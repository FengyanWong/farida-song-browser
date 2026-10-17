"""Explicit live acquisition probe. Never runs as part of the test suite."""
import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from farida.adapter import BilibiliAdapter, UpstreamError
from farida.config import Settings


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=".local/live-diagnostics.json")
    parser.add_argument("--uid", default="210887872")
    parser.add_argument("--bvid", default="BV1br4y1R7BP")
    args = parser.parse_args()
    adapter = BilibiliAdapter(Settings.from_env())
    source = {"source_type": "uploader", "uid": args.uid, "display_name": "CLANNADOR"}
    report = {"checked_at": datetime.now(timezone.utc).isoformat(), "source_uid": args.uid, "video_bvid": args.bvid, "checks": {}}
    for label, fn in (("profile", lambda: adapter.resolve_source(source)), ("uploader_page", lambda: adapter.list_entries(source, 1)), ("multipart_video", lambda: adapter.get_video_details(args.bvid)), ("tags", lambda: adapter.get_video_tags(args.bvid))):
        try:
            result = await fn()
            report["checks"][label] = {"ok": True, "data": result.__dict__ if hasattr(result, "__dict__") else result}
        except UpstreamError as exc:
            report["checks"][label] = {"ok": False, **exc.as_dict()}
            if exc.category in {"restricted", "retry_later"}:
                report["stopped"] = "Explicit access restriction; no further live requests in this diagnostic run"
                break
    await adapter.close()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(output), "checks": {k: {p: v for p, v in r.items() if p != "data"} for k, r in report["checks"].items()}}, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
