# Client tests

`npm test` — Node's built-in runner, no test framework installed.

That constraint decides what is covered here. Everything under test is a module
that runs in bare Node: the wire format, the CRDT provider and its transport
rules, the export bundle, the ICE resolver, the widget catalogue. All of it is
logic that is either invisible in the UI (a frame byte, a state vector) or
expensive to check by hand (does the zip actually open, does a second peer
converge).

Components and hooks are *not* covered, because rendering React outside a browser
needs jsdom or happy-dom and the project deliberately carries no test
dependencies. That is a real gap, not an oversight — the room UI is verified by
running it.

`"type": "module"` in `client/package.json` exists for these tests. Without it
Node loads `src/**/*.js` as CommonJS and every `import` inside them is a syntax
error. All the config files were already `.mjs`, so nothing else changed.
