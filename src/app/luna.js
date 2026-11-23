// Minimal Luna bus client (what LG's webOSTV.js does): PalmServiceBridge exists
// only inside webOS apps.
export function hasLuna() {
  return typeof window.PalmServiceBridge === 'function';
}

// Rejections carry `uncertain` when the call may still have reached the service (a
// timeout or an unreadable reply), and `response` when Luna answered with an error.
function uncertain(message) {
  const err = new Error(message);
  err.uncertain = true;
  return err;
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
      reject(uncertain('luna timeout'));
    }, timeout);
    bridge.onservicecallback = (msg) => {
      clearTimeout(timer);
      let res;
      try {
        res = JSON.parse(msg);
      } catch (e) {
        return reject(uncertain('bad luna response'));
      }
      if (res.returnValue === false) {
        const err = new Error(res.errorText || 'luna call failed');
        err.response = res; // e.g. our service's { relayError: true } for network errors
        reject(err);
      } else resolve(res);
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
