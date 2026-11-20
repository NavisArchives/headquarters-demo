// What the service worker does with each request (design approved 14 Nov):
//   'shell'  a page of the app: network first, so a sign-out redirect always
//            wins; a plain 200 is answered with the active version's index.html
//   'asset'  /assets/*: from the active version's cache (one release, one cache)
//   'data'   Home's reads: network first, a copy kept for offline (7 days)
//   'pass'   everything else is left alone: writes, login, logout, the pixel,
//            the calendar, client pages, intake, the Gmail bridge, other origins
// Plain functions, no imports: /sw.js inlines this file (export removed).
export const SW_SHELL_PATHS = ['/', '/projects', '/missions', '/pipeline', '/leads', '/finance', '/admin', '/reports', '/outreach'];
export const SW_SHELL_PREFIXES = [/^\/finance\/\d+$/, /^\/pipeline\/\d+$/, /^\/onboarding\/\d+$/, /^\/p\/[a-z0-9-]+$/];
export const SW_DATA_PATHS = ['/api/overview', '/api/todos', '/api/missions', '/api/prospects', '/api/finance/overview', '/api/finance/invoices', '/api/status', '/api/projects'];

export function routeFor(request, origin) {
  const url = new URL(request.url);
  if (url.origin !== origin) return 'pass';
  if ((request.method || 'GET') !== 'GET') return 'pass';
  const path = url.pathname;
  if (request.mode === 'navigate') {
    if (SW_SHELL_PATHS.includes(path) || SW_SHELL_PREFIXES.some((re) => re.test(path))) return 'shell';
    return 'pass';
  }
  if (path.startsWith('/assets/') && !path.startsWith('/assets/shots/')) return 'asset';
  if (SW_DATA_PATHS.includes(path)) return 'data';
  return 'pass';
}
