"""Settings come only from backend/.env. OS environment variables are deliberately ignored."""
from pathlib import Path

from dotenv import dotenv_values

ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


def setting(name, default=None):
    """Read one value from backend/.env. The file is re-read on each call, so edits apply without a restart."""
    value = dotenv_values(ENV_FILE).get(name) if ENV_FILE.exists() else None
    return value or default
