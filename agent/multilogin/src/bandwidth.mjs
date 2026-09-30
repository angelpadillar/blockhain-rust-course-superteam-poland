// Browser bandwidth accounting and media discipline. Residential proxy traffic
// is the expensive resource, so a job measures every response byte it receives
// and refuses known video/audio endpoints that verification never needs. Google
// security/auth requests are never touched.
export const mediaUrlPatterns = ['**/*videoplayback*', '**/*.mp4', '**/*.webm', '**/*.m3u8',
  '**/googlevideo.com/**'];
// The same selection expressed for CDP `Network.setBlockedURLs`, which blocks at
// the network layer on a connected browser without intercepting every request.
// Streaming segments (.m4s/.mpd/.ism) cover MSN/Outlook-adjacent autoplay.
export const mediaCdpPatterns = ['*videoplayback*', '*.mp4', '*.webm', '*.m3u8', '*googlevideo.com*',
  '*.m4s', '*.mpd', '*.ism/manifest*', '*.isml*'];

export function shouldBlockMedia({ url = '', resourceType = '' } = {}) {
  if (resourceType === 'media') return true;
  const value = String(url).toLowerCase();
  return /videoplayback|\.mp4(?:$|\?)|\.webm(?:$|\?)|\.m3u8(?:$|\?)|googlevideo\.com/.test(value);
}

export function createBandwidthMeter({ blockMedia = false, now = Date.now } = {}) {
  const diagnostics = { totalBytes: 0, byType: {}, blockedMedia: 0, available: false,
    attachFailures: 0, sessions: 0 };
  const counters = () => diagnostics;

  const attach = async ({ page = null, context = null } = {}) => {
    if (!page) { diagnostics.attachFailures++; return false; }
    const cdpContext = context || (typeof page.context === 'function' ? page.context() : null);
    if (!cdpContext || typeof cdpContext.newCDPSession !== 'function') {
      diagnostics.attachFailures++; return false;
    }
    try {
      const session = await cdpContext.newCDPSession(page);
      await session.send('Network.enable');
      if (blockMedia) {
        // Native network-layer blocking: no route interception, so page
        // screenshots and navigation are untouched on a CDP-connected browser.
        await session.send('Network.setBlockedURLs', { urls: mediaCdpPatterns }).catch(() => {});
        diagnostics.nativeBlocking = true;
      }
      const pendingTypes = new Map();
      session.on('Network.requestWillBeSent', event => pendingTypes.set(event.requestId, event.type || 'Other'));
      session.on('Network.loadingFinished', event => {
        const type = pendingTypes.get(event.requestId) || 'Other';
        pendingTypes.delete(event.requestId);
        const bytes = Number(event.encodedDataLength) || 0;
        diagnostics.totalBytes += bytes;
        diagnostics.byType[type] = (diagnostics.byType[type] || 0) + bytes;
      });
      session.on('Network.loadingFailed', event => {
        pendingTypes.delete(event.requestId);
        if (/inspector|blocked/i.test(String(event.blockedReason || event.errorText || ''))) {
          diagnostics.blockedMedia++;
        }
      });
      diagnostics.available = true;
      diagnostics.sessions++;
      return true;
    } catch { diagnostics.attachFailures++; return false; }
  };

  const blockMediaRoutes = async ({ context = null } = {}) => {
    if (!blockMedia || !context || typeof context.route !== 'function') return { blocked: 0 };
    for (const pattern of mediaUrlPatterns) {
      await context.route(pattern, route => {
        const request = route.request();
        if (shouldBlockMedia({ url: request.url(), resourceType: request.resourceType() })) {
          diagnostics.blockedMedia++;
          return route.abort().catch(() => {});
        }
        return route.continue().catch(() => {});
      }).catch(() => {});
    }
    return { blocked: diagnostics.blockedMedia };
  };

  return {
    diagnostics,
    blockMediaRoutes,
    attach,
    counters,
    summary() {
      return { totalBytes: diagnostics.totalBytes, mb: Number((diagnostics.totalBytes / 1048576).toFixed(3)),
        byType: { ...diagnostics.byType }, blockedMedia: diagnostics.blockedMedia,
        available: diagnostics.available, sessions: diagnostics.sessions,
        nativeBlocking: diagnostics.nativeBlocking === true };
    },
  };
}
