import unittest

from ml_service.features import FEATURE_NAMES, FEATURE_SCHEMA_VERSION, scale_vector
from ml_service.train_heads import conversion_target, teacher_action


class FeatureContractTests(unittest.TestCase):
    def test_schema_is_twelve_features(self):
        self.assertEqual(FEATURE_SCHEMA_VERSION, "v2.0")
        self.assertEqual(len(FEATURE_NAMES), 12)
        self.assertEqual(FEATURE_NAMES[0], "email_opens")
        self.assertEqual(FEATURE_NAMES[-1], "fatigue")

    def test_scale_vector_shape(self):
        vector = scale_vector({
            "email_opens": 3,
            "link_clicks": 1,
            "email_attempts": 1,
            "voice_attempts": 0,
            "hours_since_last_touch": 30,
            "engagement_score": 55,
            "email_consent": 1,
            "voice_consent": 1,
            "priority": 70,
            "status": "ENGAGED",
        })
        self.assertEqual(vector.shape, (1, 12))
        self.assertTrue(((vector >= 0) & (vector <= 1)).all())

    def test_teacher_does_not_recommend_call_without_voice_consent(self):
        action = teacher_action({
            "link_clicks": 3,
            "email_attempts": 1,
            "voice_attempts": 0,
            "hours_since_last_touch": 30,
            "email_consent": 1,
            "voice_consent": 0,
            "high_intent": 1,
        })
        self.assertNotEqual(action, 1)

    def test_conversion_label_requires_verified_engagement(self):
        self.assertEqual(conversion_target({
            "link_clicks": 0,
            "email_opens": 1,
            "engagement_score": 10,
        }), 0)
        self.assertEqual(conversion_target({
            "link_clicks": 1,
            "email_opens": 0,
            "engagement_score": 10,
        }), 1)


if __name__ == "__main__":
    unittest.main()
