// Built-ins missing on older webOS engines (webOS 4 = Chromium 53, webOS 5 = 68)
// that the app or the spatial-navigation polyfill call. Syntax is lowered by esbuild.
import 'core-js/actual/global-this';
import 'core-js/actual/array/flat';
import 'core-js/actual/array/flat-map';
import 'core-js/actual/array/find-last';
import 'core-js/actual/object/entries';
import 'core-js/actual/object/values';
import 'core-js/actual/object/from-entries';
import 'core-js/actual/string/pad-start';
import 'core-js/actual/string/pad-end';
import 'core-js/actual/promise/finally';
import 'core-js/actual/promise/all-settled';
import 'core-js/actual/queue-microtask';
