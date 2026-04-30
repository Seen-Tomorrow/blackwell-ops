import shutil
import zipfile
import os
from datetime import datetime

PROJECT_ROOT = r"C:\Users\GHOST-TOWER\INFRA\blackwell-ops"
BACKUP_DIR = r"C:\Users\GHOST-TOWER\INFRA"

SKIP_DIRS = {
    "node_modules",
    ".cargo",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
}

def backup():
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    archive_name = os.path.join(BACKUP_DIR, f"blackwell-ops_{timestamp}.zip")

    with zipfile.ZipFile(archive_name, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(PROJECT_ROOT):
            # prune dependency dirs in-place
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]

            for f in files:
                filepath = os.path.join(root, f)
                arcname = os.path.relpath(filepath, PROJECT_ROOT)
                zf.write(filepath, arcname)

    size_mb = os.path.getsize(archive_name) / (1024 * 1024)
    print(f"Backup created: {archive_name}")
    print(f"Size: {size_mb:.1f} MB")

if __name__ == "__main__":
    backup()
