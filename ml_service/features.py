import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "src" / "models" / "ml" / "feature_schema.json"
HIGH_INTENT = {"ENGAGED", "INTERESTED", "CALLBACK_SCHEDULED", "QUALIFIED"}
ACTIONS = ("EMAIL", "CALL", "WAIT")


def load_schema():
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


SCHEMA = load_schema()
FEATURE_NAMES = list(SCHEMA["features"])
FEATURE_SCALES = dict(SCHEMA["scales"])
FEATURE_SCHEMA_VERSION = SCHEMA["feature_schema_version"]
ARCHITECTURE = SCHEMA["architecture"]


def clip_scale(value, scale):
    number = float(value or 0)
    divisor = float(scale) if float(scale) > 0 else 1.0
    return min(1.0, max(0.0, number / divisor))


def derive_signals(raw):
    email_attempts = float(raw.get("email_attempts", 0) or 0)
    voice_attempts = float(raw.get("voice_attempts", 0) or 0)
    link_clicks = float(raw.get("link_clicks", 0) or 0)
    hours = float(raw.get("hours_since_last_touch", 0) or 0)
    status = str(raw.get("status") or "").upper()
    if raw.get("high_intent") is None:
        high_intent = 1.0 if status in HIGH_INTENT or link_clicks >= 2 else 0.0
    else:
        high_intent = float(raw.get("high_intent") or 0)
    return {
        "recent_click": 1.0 if link_clicks > 0 and hours <= 48 else 0.0,
        "high_intent": high_intent,
        "fatigue": min(1.0, (email_attempts / 3.0) * 0.6 + (voice_attempts / 2.0) * 0.4),
    }


def normalize_raw(body):
    if hasattr(body, "model_dump"):
        data = body.model_dump()
    else:
        data = dict(body or {})
    hours = min(168.0, max(0.0, float(data.get("hours_since_last_touch", 999) or 0)))
    raw = {
        "email_opens": float(data.get("email_opens", 0) or 0),
        "link_clicks": float(data.get("link_clicks", 0) or 0),
        "email_attempts": float(data.get("email_attempts", 0) or 0),
        "voice_attempts": float(data.get("voice_attempts", 0) or 0),
        "hours_since_last_touch": hours,
        "engagement_score": float(data.get("engagement_score", 0) or 0),
        "email_consent": float(data.get("email_consent", 0) or 0),
        "voice_consent": float(data.get("voice_consent", 0) or 0),
        "priority": float(data.get("priority", 50) or 50),
        "status": data.get("status"),
        "high_intent": data.get("high_intent"),
    }
    signals = derive_signals(raw)
    raw["recent_click"] = float(data["recent_click"]) if data.get("recent_click") is not None else signals["recent_click"]
    raw["high_intent"] = signals["high_intent"]
    raw["fatigue"] = float(data["fatigue"]) if data.get("fatigue") is not None else signals["fatigue"]
    return raw


def scale_vector(body):
    raw = normalize_raw(body)
    values = [clip_scale(raw[name], FEATURE_SCALES[name]) for name in FEATURE_NAMES]
    return np.array(values, dtype=np.float32).reshape(1, -1)


def scale_row(raw):
    return scale_vector(raw).reshape(-1)
