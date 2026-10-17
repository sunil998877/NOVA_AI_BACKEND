"""FastAPI decision service. The ONNX action model chooses email, call, or wait."""

import json
from pathlib import Path

import joblib
import numpy as np
import onnxruntime as ort
from fastapi import FastAPI
from pydantic import BaseModel, Field

from ml_service.train_heads import CONVERSION_PATH, DELAY_PATH, train_and_save

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "src" / "models" / "ml"
ONNX_PATH = MODEL_DIR / "lead_next_action.onnx"
META_PATH = MODEL_DIR / "lead_next_action_meta.json"
ACTIONS = ("EMAIL", "CALL", "WAIT")

session = None
metadata = {}
delay_model = None
conversion_model = None


class DecideRequest(BaseModel):
    email_opens: float = 0
    link_clicks: float = 0
    email_attempts: float = 0
    voice_attempts: float = 0
    hours_since_last_touch: float = 999
    engagement_score: float = 0
    email_consent: float = 0
    voice_consent: float = 0
    priority: float = 50
    recent_click: float = 0
    high_intent: float = 0
    fatigue: float = 0
    candidate_actions: list[str] = Field(default_factory=list)


def load_models():
    global session, metadata, delay_model, conversion_model
    metadata = json.loads(META_PATH.read_text(encoding="utf-8"))
    if not DELAY_PATH.exists() or not CONVERSION_PATH.exists():
        train_and_save()
    session = ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])
    delay_model = joblib.load(DELAY_PATH)
    conversion_model = joblib.load(CONVERSION_PATH)


def feature_vector(body: DecideRequest) -> np.ndarray:
    names = metadata["features"]
    scales = metadata["scales"]
    raw = {
        "email_opens": body.email_opens,
        "link_clicks": body.link_clicks,
        "email_attempts": body.email_attempts,
        "voice_attempts": body.voice_attempts,
        "hours_since_last_touch": min(168.0, max(0.0, body.hours_since_last_touch)),
        "engagement_score": body.engagement_score,
        "email_consent": body.email_consent,
        "voice_consent": body.voice_consent,
        "priority": body.priority,
        "recent_click": body.recent_click,
        "high_intent": body.high_intent,
        "fatigue": body.fatigue,
    }
    values = []
    for name in names:
        scale = float(scales.get(name, 1))
        values.append(min(1.0, max(0.0, float(raw.get(name, 0)) / scale)))
    return np.array(values, dtype=np.float32).reshape(1, -1)


def class_probabilities(vector: np.ndarray) -> dict:
    outputs = session.run(None, {"float_input": vector})
    names = [item.name for item in session.get_outputs()]
    by_name = dict(zip(names, outputs))
    probs = np.array(by_name["output_probability"], dtype=np.float64).reshape(-1)
    total = float(probs.sum()) or 1.0
    return {action: float(probs[index] / total) for index, action in enumerate(ACTIONS)}


app = FastAPI(title="ASE Decision Model", version="2.0.0")


@app.on_event("startup")
def startup():
    load_models()


@app.get("/health")
def health():
    return {
        "ok": session is not None,
        "provider": "fastapi",
        "action_model": "onnxruntime",
        "delay_model": "sklearn.GradientBoostingRegressor",
        "conversion_model": "sklearn.LogisticRegression",
        "version": metadata.get("version", "2.0.0"),
        "features": metadata.get("features", []),
    }


@app.post("/decide")
def decide(body: DecideRequest):
    vector = feature_vector(body)
    probabilities = class_probabilities(vector)
    allowed = {action.upper() for action in body.candidate_actions}
    masked = {
        action: probability if action == "WAIT" or action in allowed else 0.0
        for action, probability in probabilities.items()
    }
    winner = max(masked, key=masked.get)
    confidence = float(masked[winner])
    action = None if winner == "WAIT" or confidence <= 0 else winner
    channel = "EMAIL" if action == "EMAIL" else ("VOICE" if action == "CALL" else None)

    delay = float(delay_model.predict(vector)[0])
    delay_hours = int(np.clip(np.rint(delay), 0, 72))
    if action is None:
        delay_hours = max(delay_hours, 4)

    conversion = float(conversion_model.predict_proba(vector)[0, 1])
    conversion = float(min(0.95, max(0.02, conversion)))

    ranked = [
        {
            "action": name,
            "probability": round(probabilities[name], 4),
            "eligible": name == "WAIT" or name in allowed,
        }
        for name, _score in sorted(masked.items(), key=lambda item: item[1], reverse=True)
    ]
    chosen = action or "WAIT"
    explanation = (
        f"ONNX model selected {chosen} at {probabilities[chosen] * 100:.0f}% probability. "
        f"Email {probabilities['EMAIL'] * 100:.0f}%, call {probabilities['CALL'] * 100:.0f}%, "
        f"wait {probabilities['WAIT'] * 100:.0f}%."
    )

    return {
        "action": action,
        "channel": channel,
        "delay_hours": delay_hours,
        "confidence": round(probabilities[chosen], 4),
        "probabilities": {key: round(value, 4) for key, value in probabilities.items()},
        "conversion_probability": round(conversion, 3),
        "explanation": explanation,
        "reason_code": "ML_MODEL_DECISION",
        "model_version": metadata.get("version", "2.0.0"),
        "provider": "fastapi-onnx-sklearn",
        "ranked_actions": ranked,
    }
