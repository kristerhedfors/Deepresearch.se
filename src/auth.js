// HTTP Basic Auth for the whole site (UI + API).
//
// Credentials are read only from the BASIC_AUTH_USER / BASIC_AUTH_PASS
// secrets. Fails closed: if either secret is unset, every request is denied.

export function requireBasicAuth(request, env, log) {
  const denial = check(request, env);
  if (!denial) return null;

  // `reason` is safe to log: it never contains submitted values.
  log.warn("auth.denied", { reason: denial });
  return new Response("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Deepresearch.se", charset="UTF-8"',
    },
  });
}

// Returns null when authorized, otherwise a short machine-readable reason.
function check(request, env) {
  const expectedUser = env.BASIC_AUTH_USER;
  const expectedPass = env.BASIC_AUTH_PASS;
  if (!expectedUser || !expectedPass) return "missing_credential_secrets";

  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return "no_basic_header";

  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return "malformed_base64";
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return "malformed_credentials";

  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  if (!safeEqual(user, expectedUser) || !safeEqual(pass, expectedPass)) {
    return "bad_credentials";
  }
  return null;
}

// Constant-time-ish comparison to avoid trivial timing leaks.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
