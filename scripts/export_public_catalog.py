"""Export public clip metadata for a release, without any login or personal state."""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from farida.catalog_snapshot import write_public_catalog
from farida.config import Settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=Settings.from_env().db_path)
    parser.add_argument("--output", type=Path, default=ROOT / "data")
    args = parser.parse_args()
    print(json.dumps(write_public_catalog(args.database, args.output), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
