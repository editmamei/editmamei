/**
 * The rule for an endpoint this machine sends data to: `https`, or plain `http` only to this
 * machine's own loopback address, for local development against a server on the same machine.
 */

/** Whether `host` (a URL's `hostname`, where IPv6 is always bracketed) names this machine's loopback interface. */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Whether `url` parses and may receive data from this machine (see the module comment). */
export function isSecureEndpoint(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && isLoopbackHost(u.hostname);
}
