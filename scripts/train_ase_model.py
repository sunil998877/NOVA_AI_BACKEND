import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ml_service.train_heads import train_and_save

if __name__ == "__main__":
    train_and_save()
