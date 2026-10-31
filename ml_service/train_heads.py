import json
import os
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    brier_score_loss,
    f1_score,
    log_loss,
    mean_absolute_error,
    precision_recall_fscore_support,
)

from ml_service.features import (
    ARCHITECTURE,
    FEATURE_NAMES,
    FEATURE_SCALES,
    FEATURE_SCHEMA_VERSION,
    ROOT,
    scale_row,
)

MODEL_DIR = ROOT / "src" / "models" / "ml"
META_PATH = MODEL_DIR / "lead_next_action_meta.json"
ONNX_PATH = MODEL_DIR / "lead_next_action.onnx"
DELAY_PATH = MODEL_DIR / "delay_regressor.joblib"
CONVERSION_PATH = MODEL_DIR / "conversion_model.joblib"
EVAL_PATH = MODEL_DIR / "evaluation.json"
LABELED_PATH = Path(os.environ.get("ASE_ML_TRAINING_PATH") or MODEL_DIR / "training_rows.jsonl")


def teacher_action(raw):
    clicks = raw["link_clicks"]
    email_att = raw["email_attempts"]
    voice_att = raw["voice_attempts"]
    hours = raw["hours_since_last_touch"]
    email_ok = raw["email_consent"]
    voice_ok = raw["voice_consent"]
    high_intent = raw["high_intent"]
    touched = email_att + voice_att > 0
    if touched and hours < 18 and clicks == 0:
        return 2
    if email_att >= 3 and (voice_ok < 0.5 or voice_att >= 2):
        return 2
    if email_ok < 0.5 and voice_ok < 0.5:
        return 2
    if voice_ok >= 0.5 and voice_att == 0 and email_att == 0:
        return 1
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
    clicks = raw["link_clicks"]
    email_att = raw["email_attempts"]
    hours = raw["hours_since_last_touch"]
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
    if raw["link_clicks"] >= 1 or (raw["email_opens"] >= 2 and raw["engagement_score"] >= 45):
        return 1
    return 0


def make_raw_row(rng):
    opens = float(rng.integers(0, 9))
    clicks = float(rng.integers(0, 6))
    email_att = float(rng.integers(0, 4))
    voice_att = float(rng.integers(0, 3))
    hours = float(min(168.0, rng.uniform(0, 220)))
    eng = min(100.0, opens * 12.0 + clicks * 28.0)
    email_ok = 1.0 if rng.random() > 0.08 else 0.0
    voice_ok = 1.0 if rng.random() > 0.38 else 0.0
    priority = float(rng.integers(20, 101))
    raw = {
        "email_opens": opens,
        "link_clicks": clicks,
        "email_attempts": email_att,
        "voice_attempts": voice_att,
        "hours_since_last_touch": hours,
        "engagement_score": eng,
        "email_consent": email_ok,
        "voice_consent": voice_ok,
        "priority": priority,
        "high_intent": 1.0 if (rng.random() > 0.72 or clicks >= 2) else 0.0,
    }
    raw["recent_click"] = 1.0 if clicks > 0 and hours <= 48 else 0.0
    raw["fatigue"] = min(1.0, (email_att / 3.0) * 0.6 + (voice_att / 2.0) * 0.4)
    return raw


def load_labeled_rows():
    if not LABELED_PATH.exists():
        return None
    rows = []
    text = LABELED_PATH.read_text(encoding="utf-8").strip()
    if not text:
        return None
    if LABELED_PATH.suffix == ".json":
        parsed = json.loads(text)
        records = parsed if isinstance(parsed, list) else parsed.get("rows") or []
    else:
        records = [json.loads(line) for line in text.splitlines() if line.strip()]
    for record in records:
        if not isinstance(record, dict):
            continue
        raw = {
            "email_opens": float(record.get("email_opens", 0) or 0),
            "link_clicks": float(record.get("link_clicks", 0) or 0),
            "email_attempts": float(record.get("email_attempts", 0) or 0),
            "voice_attempts": float(record.get("voice_attempts", 0) or 0),
            "hours_since_last_touch": float(record.get("hours_since_last_touch", 0) or 0),
            "engagement_score": float(record.get("engagement_score", 0) or 0),
            "email_consent": float(record.get("email_consent", 0) or 0),
            "voice_consent": float(record.get("voice_consent", 0) or 0),
            "priority": float(record.get("priority", 50) or 50),
            "high_intent": record.get("high_intent"),
            "status": record.get("status"),
        }
        action = record.get("action")
        if isinstance(action, str):
            action = {"EMAIL": 0, "CALL": 1, "WAIT": 2}.get(action.upper())
        if action is None:
            action = teacher_action({**raw, **{"high_intent": float(raw.get("high_intent") or 0), "recent_click": 0, "fatigue": 0}})
        converted = record.get("converted", record.get("label", conversion_target(raw)))
        delay = record.get("delay_hours", delay_target(raw, int(action)))
        rows.append((raw, int(action), float(delay), int(converted)))
    return rows or None


def build_dataset(samples=4800, seed=42):
    labeled = load_labeled_rows()
    if labeled:
        features = [scale_row(raw) for raw, _, _, _ in labeled]
        actions = [action for _, action, _, _ in labeled]
        delays = [delay for _, _, delay, _ in labeled]
        conversions = [converted for _, _, _, converted in labeled]
        source = "labeled_file"
        # Fewer than 800 real rows overfit; keep every live lead and fill with teacher examples.
        if len(labeled) < 800:
            rng = np.random.default_rng(seed)
            extra = max(samples - len(labeled), 0)
            for _ in range(extra):
                raw = make_raw_row(rng)
                action = teacher_action(raw)
                features.append(scale_row(raw))
                actions.append(action)
                delays.append(delay_target(raw, action))
                conversions.append(conversion_target(raw))
            source = "real_leads_mixed"
        return (
            np.vstack(features),
            np.array(actions, dtype=np.int64),
            np.array(delays, dtype=np.float32),
            np.array(conversions, dtype=np.int64),
            source,
        )
    rng = np.random.default_rng(seed)
    features = []
    actions = []
    delays = []
    conversions = []
    for _ in range(samples):
        raw = make_raw_row(rng)
        action = teacher_action(raw)
        features.append(scale_row(raw))
        actions.append(action)
        delays.append(delay_target(raw, action))
        conversions.append(conversion_target(raw))
    return (
        np.vstack(features),
        np.array(actions, dtype=np.int64),
        np.array(delays, dtype=np.float32),
        np.array(conversions, dtype=np.int64),
        "synthetic_teacher",
    )


def split_time_aware(features, actions, delays, conversions, seed=42):
    n = len(features)
    hours_idx = FEATURE_NAMES.index("hours_since_last_touch")
    order = np.argsort(-features[:, hours_idx])
    cut = int(n * 0.8)
    train_idx, test_idx = order[:cut], order[cut:]
    if len(np.unique(actions[test_idx])) < 2 or len(test_idx) < 20:
        rng = np.random.default_rng(seed)
        order = rng.permutation(n)
        train_idx, test_idx = order[:cut], order[cut:]
    return (
        features[train_idx],
        actions[train_idx],
        delays[train_idx],
        conversions[train_idx],
        features[test_idx],
        actions[test_idx],
        delays[test_idx],
        conversions[test_idx],
    )


def relu(x):
    return np.maximum(0, x)


def softmax(x):
    shifted = x - np.max(x, axis=-1, keepdims=True)
    exp = np.exp(shifted)
    return exp / np.sum(exp, axis=-1, keepdims=True)


def train_action_mlp(x_train, y_train, x_test, y_test, epochs=220, lr=0.03):
    n_classes = 3
    w1 = np.random.randn(12, 32).astype(np.float32) * np.sqrt(2.0 / 12)
    b1 = np.zeros(32, dtype=np.float32)
    w2 = np.random.randn(32, 16).astype(np.float32) * np.sqrt(2.0 / 32)
    b2 = np.zeros(16, dtype=np.float32)
    w3 = np.random.randn(16, n_classes).astype(np.float32) * np.sqrt(2.0 / 16)
    b3 = np.zeros(n_classes, dtype=np.float32)
    y_one = np.zeros((len(y_train), n_classes), dtype=np.float32)
    y_one[np.arange(len(y_train)), y_train] = 1.0
    m = max(len(x_train), 1)
    for _ in range(epochs):
        h1 = relu(x_train @ w1 + b1)
        h2 = relu(h1 @ w2 + b2)
        probs = softmax(h2 @ w3 + b3)
        d_logits = (probs - y_one) / m
        dw3 = h2.T @ d_logits
        db3 = np.sum(d_logits, axis=0)
        dh2 = d_logits @ w3.T
        dh2[h2 <= 0] = 0
        dw2 = h1.T @ dh2
        db2 = np.sum(dh2, axis=0)
        dh1 = dh2 @ w2.T
        dh1[h1 <= 0] = 0
        dw1 = x_train.T @ dh1
        db1 = np.sum(dh1, axis=0)
        w1 -= lr * dw1
        b1 -= lr * db1
        w2 -= lr * dw2
        b2 -= lr * db2
        w3 -= lr * dw3
        b3 -= lr * db3
    test_h1 = relu(x_test @ w1 + b1)
    test_h2 = relu(test_h1 @ w2 + b2)
    test_probs = softmax(test_h2 @ w3 + b3)
    test_pred = np.argmax(test_probs, axis=-1)
    return (w1, b1, w2, b2, w3, b3), test_pred, test_probs


def export_onnx(weights):
    from onnx import TensorProto, helper, save
    from onnx import checker

    w1, b1, w2, b2, w3, b3 = weights
    tensors = [
        helper.make_tensor("W1", TensorProto.FLOAT, list(w1.shape), w1.flatten().tolist()),
        helper.make_tensor("B1", TensorProto.FLOAT, list(b1.shape), b1.flatten().tolist()),
        helper.make_tensor("W2", TensorProto.FLOAT, list(w2.shape), w2.flatten().tolist()),
        helper.make_tensor("B2", TensorProto.FLOAT, list(b2.shape), b2.flatten().tolist()),
        helper.make_tensor("W3", TensorProto.FLOAT, list(w3.shape), w3.flatten().tolist()),
        helper.make_tensor("B3", TensorProto.FLOAT, list(b3.shape), b3.flatten().tolist()),
    ]
    nodes = [
        helper.make_node("Gemm", ["float_input", "W1", "B1"], ["h1"]),
        helper.make_node("Relu", ["h1"], ["r1"]),
        helper.make_node("Gemm", ["r1", "W2", "B2"], ["h2"]),
        helper.make_node("Relu", ["h2"], ["r2"]),
        helper.make_node("Gemm", ["r2", "W3", "B3"], ["logits"]),
        helper.make_node("Softmax", ["logits"], ["output_probability"], axis=1),
        helper.make_node("ArgMax", ["output_probability"], ["output_label"], axis=1, keepdims=0),
    ]
    graph = helper.make_graph(
        nodes,
        "nova_brain_mlp_v21",
        [helper.make_tensor_value_info("float_input", TensorProto.FLOAT, [None, 12])],
        [
            helper.make_tensor_value_info("output_label", TensorProto.INT64, [None]),
            helper.make_tensor_value_info("output_probability", TensorProto.FLOAT, [None, 3]),
        ],
        tensors,
    )
    model = helper.make_model(
        graph,
        ir_version=9,
        opset_imports=[helper.make_opsetid("", 13)],
        producer_name="NOVA_ASE_ML",
    )
    checker.check_model(model)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    save(model, ONNX_PATH)


def class_metrics(y_true, y_pred):
    precision, recall, f1, support = precision_recall_fscore_support(
        y_true, y_pred, labels=[0, 1, 2], zero_division=0
    )
    return {
        name.lower(): {
            "precision": round(float(precision[i]), 4),
            "recall": round(float(recall[i]), 4),
            "f1": round(float(f1[i]), 4),
            "support": int(support[i]),
        }
        for i, name in enumerate(("EMAIL", "CALL", "WAIT"))
    }


def train_and_save(samples=4800, seed=42):
    features, actions, delays, conversions, source = build_dataset(samples=samples, seed=seed)
    x_train, y_train, d_train, c_train, x_test, y_test, d_test, c_test = split_time_aware(
        features, actions, delays, conversions, seed=seed
    )
    np.random.seed(seed)
    weights, action_pred, action_probs = train_action_mlp(x_train, y_train, x_test, y_test)
    export_onnx(weights)

    delay_model = GradientBoostingRegressor(random_state=7, max_depth=4, n_estimators=120, learning_rate=0.08)
    delay_model.fit(x_train, d_train)
    conversion_model = LogisticRegression(max_iter=400, class_weight="balanced")
    conversion_model.fit(x_train, c_train)
    joblib.dump(delay_model, DELAY_PATH)
    joblib.dump(conversion_model, CONVERSION_PATH)

    conversion_prob = conversion_model.predict_proba(x_test)[:, 1]
    conversion_pred = (conversion_prob >= 0.5).astype(int)
    delay_pred = delay_model.predict(x_test)
    action_acc = float(accuracy_score(y_test, action_pred))
    action_macro = float(f1_score(y_test, action_pred, average="macro", zero_division=0))
    action_weighted = float(f1_score(y_test, action_pred, average="weighted", zero_division=0))
    evaluation = {
        "data_source": source,
        "label_definition": {
            "action": "teacher_policy_or_labeled_action",
            "conversion": "qualified_engagement_clicks_or_repeat_opens",
            "horizon_days": 14,
        },
        "dataset": {
            "total_samples": int(len(features)),
            "train_samples": int(len(x_train)),
            "test_samples": int(len(x_test)),
            "split": "hours_since_last_touch_desc",
        },
        "action_model": {
            "accuracy": round(action_acc, 4),
            "macro_f1": round(action_macro, 4),
            "weighted_f1": round(action_weighted, 4),
            "per_class": class_metrics(y_test, action_pred),
        },
        "delay_model": {
            "mae_hours": round(float(mean_absolute_error(d_test, delay_pred)), 3),
        },
        "conversion_model": {
            "accuracy": round(float(accuracy_score(c_test, conversion_pred)), 4),
            "brier": round(float(brier_score_loss(c_test, conversion_prob)), 4),
            "log_loss": round(float(log_loss(c_test, np.clip(conversion_prob, 1e-6, 1 - 1e-6))), 4),
            "positive_rate": round(float(np.mean(c_test)), 4),
        },
        "limitations": [
            "Holdout metrics only. Not live production performance.",
            "Synthetic teacher labels are used unless training_rows.jsonl or ASE_ML_TRAINING_PATH is provided.",
            "If fewer than 800 real rows exist they are mixed with synthetic examples so the model does not overfit.",
            "Email opens are a weak label and are not used as the conversion target alone.",
        ],
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
    }
    metadata = {
        "model_name": "nova_brain_lead_next_action",
        "version": "2.2.0",
        "framework": "onnx-neural-network",
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "normalization": "clip_divide_by_scale",
        "accuracy": evaluation["action_model"]["accuracy"],
        "total_samples": evaluation["dataset"]["total_samples"],
        "test_samples": evaluation["dataset"]["test_samples"],
        "features": FEATURE_NAMES,
        "scales": FEATURE_SCALES,
        "classes": {"0": "EMAIL", "1": "CALL", "2": "WAIT"},
        "architecture": ARCHITECTURE,
        "metrics": {
            "accuracy": evaluation["action_model"]["accuracy"],
            "macro_f1": evaluation["action_model"]["macro_f1"],
            "weighted_f1": evaluation["action_model"]["weighted_f1"],
        },
        "data_source": source,
        "decision_policy": "expected_utility_with_compliance_gate",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    META_PATH.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    EVAL_PATH.write_text(json.dumps(evaluation, indent=2), encoding="utf-8")
    print(json.dumps({
        "status": "SUCCESS",
        "data_source": source,
        "action_holdout_accuracy": evaluation["action_model"]["accuracy"],
        "action_macro_f1": evaluation["action_model"]["macro_f1"],
        "delay_mae_hours": evaluation["delay_model"]["mae_hours"],
        "conversion_brier": evaluation["conversion_model"]["brier"],
        "onnx_path": str(ONNX_PATH),
        "evaluation_path": str(EVAL_PATH),
    }))
    return evaluation


if __name__ == "__main__":
    train_and_save()
