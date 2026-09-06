import { env } from "../config/env.js";
import { fetchWithTimeout } from "./fetch.js";

export const verifyCaptcha = async (captchaToken) => {
    if (!captchaToken) {
        return { ok: false, error: "Please tick I'm not a robot" };
    }

    const secret = String(env.recaptchaSecret || "").trim();
    if (!secret) {
        return { ok: false, error: "reCAPTCHA secret key is not configured" };
    }

    const body = new URLSearchParams({
        secret,
        response: captchaToken,
    });

    let data;
    try {
        const response = await fetchWithTimeout("https://www.google.com/recaptcha/api/siteverify", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
        });
        data = await response.json();
    } catch {
        return { ok: false, error: "Could not reach Google reCAPTCHA. Check your network." };
    }

    if (data.success === true) {
        return { ok: true };
    }

    const codes = Array.isArray(data["error-codes"]) ? data["error-codes"].join(", ") : "";
    return {
        ok: false,
        error: codes
            ? `CAPTCHA verification failed (${codes})`
            : "CAPTCHA verification failed. Please try again.",
    };
};
