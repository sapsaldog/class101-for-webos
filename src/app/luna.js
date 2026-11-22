// Minimal Luna bus client (what LG's webOSTV.js does): PalmServiceBridge exists
// only inside webOS apps.
export function hasLuna() {
  return typeof window.PalmServiceBridge === 'function';
}

export function lunaCall(uri, params, { timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const bridge = new window.PalmServiceBridge();
    const timer = setTimeout(() => {
      try {
        bridge.cancel();
      } catch (e) {
        /* ignore */
      }
      reject(new Error('luna timeout'));
    }, timeout);
    bridge.onservicecallback = (msg) => {
      clearTimeout(timer);
      let res;
      try {
        res = JSON.parse(msg);
      } catch (e) {
        return reject(new Error('bad luna response'));
      }
      if (res.returnValue === false) reject(new Error(res.errorText || 'luna call failed'));
      else resolve(res);
    };
    bridge.call(uri, JSON.stringify(params || {}));
  });
}

// Long-lived subscription; keep the returned bridge referenced or it is collected.
const subs = [];
export function lunaSubscribe(uri, params) {
  if (!hasLuna()) return;
  const bridge = new window.PalmServiceBridge();
  bridge.onservicecallback = () => {};
  bridge.call(uri, JSON.stringify({ ...(params || {}), subscribe: true }));
  subs.push(bridge);
}
