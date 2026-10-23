import { HttpError } from './service.mjs';

export function validateLogin(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(k => !['email', 'password'].includes(k)) ||
      typeof body.email !== 'string' || body.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
      typeof body.password !== 'string' || !body.password || body.password.length > 256) {
    throw new HttpError(400, 'Escribe el correo y la contraseña de Hostinger.');
  }
  return { email: body.email.trim().toLowerCase(), password: body.password };
}

// Called only over the exporter's existing TLS listener. The GoTrue address is
// fixed server configuration on the private Docker network, never client input.
export function ownerLogin(config, authorize, fetcher = fetch) {
  return async raw => {
    const credentials = validateLogin(raw);
    const response = await fetcher(config.authUrl + '/token?grant_type=password', {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      if (response.status === 429) throw new HttpError(429, 'Demasiados intentos. Espera un momento.');
      if (response.status >= 500) throw new HttpError(503, 'Hostinger no está disponible en este momento.');
      throw new HttpError(401, 'No fue posible conectar esa cuenta de Hostinger. Revisa el correo y la contraseña.');
    }
    const result = await response.json();
    const token = result.access_token;
    if (typeof token !== 'string' || token.length > 16000 || !/^[A-Za-z0-9_.-]+$/.test(token)) {
      throw new HttpError(503, 'Hostinger devolvió una sesión inválida.');
    }
    // Reuse the live owner/session check; editable metadata never grants access.
    await authorize({ headers: { authorization: 'Bearer ' + token } });
    let expiresAt;
    try { expiresAt = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp * 1000; }
    catch { throw new HttpError(503, 'Hostinger devolvió una sesión inválida.'); }
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new HttpError(401, 'La sesión de Hostinger expiró.');
    // Do not return refresh tokens, the user record, or the password.
    return { accessToken: token, expiresAt: Math.min(expiresAt, Date.now() + 3600000) };
  };
}
