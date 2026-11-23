// webOS JS service bundled with the app. The TV's web engine overwrites every
// request's Accept-Language with the TV menu language (en-CA here), and Class101's
// gateway picks the language of titles from that header only. Node requests are
// not touched, so GraphQL goes through here with "ko".
// Class101's REST API (watch time) comes through here too: its CORS filter rejects
// the "Origin: null" that requests from a file:// app carry.
// Runs on the TV's Node (v8 on webOS 5): keep to ES2017 and core modules.
'use strict';

var Service = require('webos-service');
var https = require('https');

var service = new Service('com.sapsaldog.class101.service');
var keepAlive = null;

// The only REST call the app makes.
var REST_PATH = /^\/v1\/playtime-tracking\/lessons\/[A-Za-z0-9_-]{1,64}\/play$/;

service.register('ping', function (message) {
  message.respond({ returnValue: true, node: process.version });
});

service.register('gql', function (message) {
  var p = message.payload || {};
  relay(message, 'cdn-production-gateway.class101.net', '/graphql', { 'accept-language': p.language || 'ko' });
});

service.register('rest', function (message) {
  var p = message.payload || {};
  var path = String(p.path || '');
  if (!REST_PATH.test(path)) {
    message.respond({ returnValue: false, errorText: 'path not allowed' });
    return;
  }
  relay(message, 'api.class101.net', '/api' + path, p.requestId ? { 'x-request-id': String(p.requestId).slice(0, 64) } : {});
});

// POST payload.body (JSON) to host+path with the app's token; answer with status and body.
function relay(message, host, path, extra) {
  var p = message.payload || {};
  var body = String(p.body || '');
  var headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    // The gateway's WAF answers requests without a User-Agent with a
    // "Human Verification" page (HTTP 405); send the TV's own UA.
    'user-agent': p.userAgent || 'Mozilla/5.0 (Web0S; Linux/SmartTV) WebAppManager class101-for-webos',
    'content-length': Buffer.byteLength(body),
  };
  Object.keys(extra).forEach(function (k) {
    headers[k] = extra[k];
  });
  if (p.token) headers.authorization = 'Bearer ' + p.token;
  var req = https.request(
    { method: 'POST', host: host, path: path, headers: headers },
    function (res) {
      var chunks = [];
      res.on('data', function (c) {
        chunks.push(c);
      });
      res.on('end', function () {
        message.respond({ returnValue: true, status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    }
  );
  req.setTimeout(20000, function () {
    req.abort();
  });
  req.on('error', function (e) {
    message.respond({ returnValue: false, errorText: String((e && e.message) || e) });
  });
  req.end(body);
}

// While the app holds this subscription the service stays up, so screens don't
// pay a Node cold start on every request.
service.register(
  'keepAlive',
  function (message) {
    if (!keepAlive) {
      service.activityManager.create('class101-keepalive', function (activity) {
        keepAlive = activity;
      });
    }
    message.respond({ returnValue: true, subscribed: !!message.isSubscription });
  },
  function () {
    if (keepAlive) {
      service.activityManager.complete(keepAlive, function () {});
      keepAlive = null;
    }
  }
);
