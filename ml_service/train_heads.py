"""Train the delay and conversion heads that sit beside the ONNX action model."""

import json
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import LogisticRegression

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "src" / "models" / "ml"
META_PATH = MODEL_DIR / "lead_next_action_meta.json"
DELAY_PATH = MODEL_DIR / "delay_regressor.joblib"
CONVERSION_PATH = MODEL_DIR / "conversion_model.joblib"


def load_schema():
    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    return meta["features"], meta["scales"]


def teacher_action(raw):
    clicks, email_att, voice_att, hours, email_ok, voice_ok, high_intent = (
        raw[1], raw[2], raw[3], raw[4], raw[6], raw[7], raw[10],
    )
    touched = email_att + voice_att > 0
    if touched and hours < 18 and clicks == 0:
        return 2
    if email_att >= 3 and (voice_ok < 0.5 or voice_att >= 2):
        return 2
    if email_ok < 0.5 and voice_ok < 0.5:
        return 2
    if clicks >= 1 and voice_ok >= 0.5 and voice_att < 2 and hours >= 12:
        return 1
    if high_intent >= 0.5 and voice_ok >= 0.5 and voice_att < 2 and email_att >= 1 and hours >= 20:
        return 1
    if email_att >= 2 and voice_ok >= 0.5 and voice_att < 2 and hours >= 24:
        return 1
    if email_ok >= 0.5 and email_att == 0:
        return 0
    if email_ok >= 0.5 and email_att < 3 and hours >= 36:
        return 0
    if voice_ok >= 0.5 and voice_att < 2 and hours >= 24:
        return 1
    if email_ok >= 0.5:
        return 0
    return 2


def delay_target(raw, action):
    clicks, email_att, hours = raw[1], raw[2], raw[4]
    if action == 2:
        return float(np.clip(24 - min(hours, 24), 4, 48))
    if action == 1:
        return 0.0 if clicks >= 1 else (2.0 if hours >= 48 else 8.0)
    if email_att == 0:
        return 0.0
    if hours >= 48:
        return 0.0
    if clicks >= 1:
        return 1.0
    return 24.0


def conversion_target(raw):
    opens, clicks, eng = raw[0], raw[1], raw[5]
    if clicks >= 1 or (opens >= 2 and eng >= 45):
        return 1
    return 0


def scale_row(raw, names, scales):
    return np.array(
        [min(1.0, max(0.0, float(raw[i]) / float(scales[names[i]]))) for i in range(len(names))],
        dtype=np.float32,
    )


def build_dataset(samples=4800, seed=42):
    names, scales = load_schema()
    rng = np.random.default_rng(seed)
    rows = []
    delays = []
    conversions = []
    for _ in range(samples):
        opens = float(rng.integers(0, 9))
        clicks = float(rng.integers(0, 6))
        email_att = float(rng.integers(0, 4))
        voice_att = float(rng.integers(0, 3))
        hours = float(min(168.0, rng.uniform(0, 220)))
        eng = min(100.0, opens * 12.0 + clicks * 28.0)
        email_ok = 1.0 if rng.random() > 0.08 else 0.0
        voice_ok = 1.0 if rng.random() > 0.38 else 0.0
        priority = float(rng.integers(20, 101))
        recent_click = 1.0 if clicks > 0 and hours <= 48 else 0.0
        high_intent = 1.0 if (rng.random() > 0.72 or clicks >= 2) else 0.0
        fatigue = min(1.0, (email_att / 3.0) * 0.6 + (voice_att / 2.0) * 0.4)
        raw = np.array(
            [opens, clicks, email_att, voice_att, hours, eng, email_ok, voice_ok, priority, recent_click, high_intent, fatigue],
            dtype=np.float32,
        )
        action = teacher_action(raw)
        rows.append(scale_row(raw, names, scales))
        delays.append(delay_target(raw, action))
        conversions.append(conversion_target(raw))
    return np.vstack(rows), np.array(delays, dtype=np.float32), np.array(conversions, dtype=np.int64)


def train_and_save():
    features, delays, conversions = build_dataset()
    delay_model = GradientBoostingRegressor(random_state=7, max_depth=4, n_estimators=120, learning_rate=0.08)
    delay_model.fit(features, delays)
    conversion_model = LogisticRegression(max_iter=400)
    conversion_model.fit(features, conversions)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(delay_model, DELAY_PATH)
    joblib.dump(conversion_model, CONVERSION_PATH)
    delay_mae = float(np.mean(np.abs(delay_model.predict(features) - delays)))
    conversion_acc = float(conversion_model.score(features, conversions))
    print(json.dumps({
        "status": "SUCCESS",
        "delay_mae_hours": round(delay_mae, 3),
        "conversion_accuracy": round(conversion_acc, 4),
        "delay_path": str(DELAY_PATH),
        "conversion_path": str(CONVERSION_PATH),
    }))


if __name__ == "__main__":
    train_and_save()
