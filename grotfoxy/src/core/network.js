/**
 * Address classification for the LAN-only guard.
 *
 * GrotFoxy is meant to sit on a machine in your house. Binding to 0.0.0.0 so a
 * phone can reach it also means anything that can route to the host can reach
 * it — a port forward, a tunnel, a VPS with a public IP. This turns "only my
 * network" into something the server enforces rather than something the
 * operator has to keep remembering.
 */

/** Strip the IPv4-mapped IPv6 prefix and any zone id. */
export function normalizeAddress(address) {
  const value = String(address ?? '').trim().toLowerCase();
  if (!value) return '';
  const withoutZone = value.split('%')[0];
  return withoutZone.startsWith('::ffff:') ? withoutZone.slice(7) : withoutZone;
}

export function isLoopback(address) {
  const ip = normalizeAddress(address);
  return ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.');
}

export function isPrivateAddress(address) {
  const ip = normalizeAddress(address);
  if (!ip) return false;
  if (isLoopback(ip)) return true;

  if (ip.includes(':')) {
    // fc00::/7 unique local, fe80::/10 link local.
    return /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
  }

  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT, used by Tailscale
  return false;
}

/**
 * Who is really calling. A request arriving through a proxy has the proxy's
 * address on the socket, so the forwarded chain decides — and its leftmost
 * entry is the original client. Spoofable in general, but here it can only ever
 * cost the caller access, never grant it: a forged private value still has to
 * pass the socket check below it.
 */
export function clientAddress(req) {
  const socketAddress = normalizeAddress(req.socket?.remoteAddress);
  const forwarded = String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim();
  if (!forwarded) return { address: socketAddress, viaProxy: false };
  return { address: normalizeAddress(forwarded), viaProxy: true };
}

/**
 * A request is on your network when the socket peer is private AND, if it came
 * through a proxy, the original client was private too. Both must hold: a
 * tunnel daemon running on the host itself connects over loopback, so the
 * socket check alone would wave the whole internet through.
 */
export function isLocalRequest(req) {
  const socketAddress = normalizeAddress(req.socket?.remoteAddress);
  if (!isPrivateAddress(socketAddress)) return false;
  const { address, viaProxy } = clientAddress(req);
  return viaProxy ? isPrivateAddress(address) : true;
}
