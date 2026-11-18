"""Short-lived work directories for building and checking a Windows release."""
import shutil
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def staging_directory(parent, prefix):
    root = parent.resolve(strict=True)
    directory = Path(tempfile.mkdtemp(prefix=prefix, dir=root))
    try:
        yield directory
    except BaseException:
        print(f"Retained staging for diagnosis: {directory}", file=sys.stderr)
        raise
    try:
        resolved = directory.resolve(strict=True)
        if resolved != directory or resolved.parent != root or not resolved.name.startswith(prefix):
            raise ValueError("staging path changed")
        shutil.rmtree(resolved)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Could not clean staging at {directory}: {error}", file=sys.stderr)
