export async function getPublicApiUrl(req = null) {
  const clean = (value) => String(value || "").trim().replace(/\/$/, "");
  const isLocal = (url) => /localhost|127\.0\.0\.1/i.test(url || "");
  const isPublicHttps = (url) =>
    Boolean(url) &&
    /^https:\/\//i.test(url) &&
    !isLocal(url) &&
    !url.includes("placeholder");

  const configuredPublicUrl = clean(process.env.PUBLIC_API_URL);
  if (isPublicHttps(configuredPublicUrl)) return configuredPublicUrl;

  const configuredBackendUrl = clean(process.env.VITE_BACKEND_URL);
  if (isPublicHttps(configuredBackendUrl)) return configuredBackendUrl;

  if (req) {
    const proto = req.get("x-forwarded-proto") || req.protocol || "http";
    const host = req.get("x-forwarded-host") || req.get("host");
    if (host && !isLocal(host)) {
      const fromReq = clean(`${proto}://${host}`);
      if (isPublicHttps(fromReq) || (fromReq && !isLocal(fromReq))) return fromReq;
    }
  }

  if (configuredPublicUrl && !configuredPublicUrl.includes("placeholder")) {
    return configuredPublicUrl;
  }
  return clean(configuredBackendUrl || "http://localhost:3001");
}
