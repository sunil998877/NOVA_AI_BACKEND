import json
from pathlib import Path

import joblib
import numpy as np
import onnxruntime as ort
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ml_service.features import ACTIONS, FEATURE_NAMES, FEATURE_SCHEMA_VERSION, ROOT, scale_vector
from ml_service.train_heads import CONVERSION_PATH, DELAY_PATH, EVAL_PATH, train_and_save

MODEL_DIR = ROOT / "src" / "models" / "ml"
ONNX_PATH = MODEL_DIR / "lead_next_action.onnx"
META_PATH = MODEL_DIR / "lead_next_action_meta.json"

session = None
metadata = {}
evaluation = {}
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
    status: Optional[str] = None
    candidate_actions: list[str] = Field(default_factory=list)


def load_models():
    global session, metadata, evaluation, delay_model, conversion_model
    if not META_PATH.exists() or not ONNX_PATH.exists():
        train_and_save()
    metadata = json.loads(META_PATH.read_text(encoding="utf-8"))
    if metadata.get("feature_schema_version") != FEATURE_SCHEMA_VERSION:
        raise RuntimeError("ONNX metadata feature schema does not match ml_service.features")
    if list(metadata.get("features") or []) != FEATURE_NAMES:
        raise RuntimeError("ONNX feature order does not match shared schema")
    if not DELAY_PATH.exists() or not CONVERSION_PATH.exists():
        train_and_save()
        metadata = json.loads(META_PATH.read_text(encoding="utf-8"))
    session = ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])
    delay_model = joblib.load(DELAY_PATH)
    conversion_model = joblib.load(CONVERSION_PATH)
    evaluation = json.loads(EVAL_PATH.read_text(encoding="utf-8")) if EVAL_PATH.exists() else {}


def class_probabilities(vector: np.ndarray) -> dict:
    outputs = session.run(None, {"float_input": vector})
    names = [item.name for item in session.get_outputs()]
    by_name = dict(zip(names, outputs))
    probs = np.array(by_name["output_probability"], dtype=np.float64).reshape(-1)
    if probs.size != len(ACTIONS):
        raise RuntimeError("ONNX probability output does not match EMAIL/CALL/WAIT")
    total = float(probs.sum()) or 1.0
    return {action: float(probs[index] / total) for index, action in enumerate(ACTIONS)}


app = FastAPI(title="ASE Decision Model", version="2.1.0")


@app.on_event("startup")
def startup():
    load_models()


@app.get("/health")
def health():
    return {
        "ok": session is not None and delay_model is not None and conversion_model is not None,
        "provider": "fastapi",
        "action_model": "onnxruntime",
        "delay_model": "sklearn.GradientBoostingRegressor",
        "conversion_model": "sklearn.LogisticRegression",
        "version": metadata.get("version", "2.1.0"),
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "features": FEATURE_NAMES,
        "data_source": metadata.get("data_source", evaluation.get("data_source")),
    }


@app.get("/")
def root():
    return health()


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


@app.get("/schema")
def schema():
    return {
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "features": FEATURE_NAMES,
        "architecture": metadata.get("architecture"),
        "classes": metadata.get("classes"),
    }


@app.get("/metrics")
def metrics():
    if not evaluation:
        raise HTTPException(status_code=404, detail="No evaluation report. Train with python -m ml_service.train_heads")
    return evaluation


@app.post("/decide")
def decide(body: DecideRequest):
    if session is None:
        raise HTTPException(status_code=503, detail="Action model is not loaded")
    vector = scale_vector(body)
    if vector.shape[1] != 12:
        raise HTTPException(status_code=500, detail="Feature vector is not 12 dimensions")
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
    delay_hours = float(np.clip(delay, 0, 72))
    if action is None:
        delay_hours = max(delay_hours, 4.0)
    delay_hours = round(delay_hours, 2)

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
        "model_version": metadata.get("version", "2.1.0"),
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "data_source": metadata.get("data_source", "unknown"),
        "provider": "fastapi-onnx-sklearn",
        "ranked_actions": ranked,
    }
