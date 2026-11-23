// fetch with a deadline that covers the response body too. A stalled request must not
// hold up the screens that wait for writes (api.settled()). Chrome 53 has no
// AbortController, so a timed-out request is abandoned, not aborted, and its outcome
// is unknown (`uncertain`).
export function request(url, options, ms = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('request timeout');
      err.uncertain = true;
      reject(err);
    }, ms);
    fetch(url, options)
      .then((res) => res.text().then((text) => ({ status: res.status, ok: res.ok, text })))
      .then(
        (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
  });
}
