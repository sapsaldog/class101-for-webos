// webOS JS service bundled with the app. The TV's web engine overwrites every
// request's Accept-Language with the TV menu language (en-CA here), and Class101's
// gateway picks the language of titles from that header only. Node requests are
// not touched, so GraphQL goes through here with "ko".
// Runs on the TV's Node (v8 on webOS 5): keep to ES2017 and core modules.
'use strict';

var Service = require('webos-service');
var https = require('https');

var service = new Service('com.sapsaldog.class101.service');
var keepAlive = null;

service.register('ping', function (message) {
  message.respond({ returnValue: true, node: process.version });
});

service.register('gql', function (message) {
  var p = message.payload || {};
  var body = String(p.body || '');
  var headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'accept-language': p.language || 'ko',
    // The gateway's WAF answers requests without a User-Agent with a
    // "Human Verification" page (HTTP 405); send the TV's own UA.
    'user-agent': p.userAgent || 'Mozilla/5.0 (Web0S; Linux/SmartTV) WebAppManager class101-for-webos',
    'content-length': Buffer.byteLength(body),
  };
  if (p.token) headers.authorization = 'Bearer ' + p.token;
  var req = https.request(
    { method: 'POST', host: 'cdn-production-gateway.class101.net', path: '/graphql', headers: headers },
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
});

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
