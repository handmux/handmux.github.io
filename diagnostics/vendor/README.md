# Local xterm.js resources

Unmodified `@xterm/xterm` **5.5.0**, mechanically copied from this repository's
`web/node_modules/@xterm/xterm` (npm package, https://github.com/xtermjs/xterm.js).
No CDN, addon, product fallback or backend is used. `xterm-LICENSE` preserves the
upstream MIT license. The source map is not included; normal page use needs only
the JavaScript and stylesheet.

SHA-256:

- `xterm-5.5.0.js`: `1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495`
- `xterm-5.5.0.css`: `ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6`

The optional diagnostic probe requires the version marker and the exact 5.5.0
UMD `_handleAnyTextareaChanges` implementation to match. If validation fails,
the page still records public `onData` and DOM events with upstream xterm.
Private fields are diagnostic observations, not supported product dependencies.
The probe wraps the one original callback, never cancels or adds input sends,
and restores the global timer synchronously and the instance method when disabled.
Already queued original callbacks still execute after recording stops, without
new log entries. Both DOM phases are observations taken in listener order,
not a promise that every other listener has already run.

Run isolated tests with existing web dev dependencies:

```sh
node --test site/diagnostics/ime.test.cjs
```

jsdom tests cover logging, bounds, cleanup and upstream send behavior. They do
not reproduce Firefox/IME OS event timing; collect that evidence in the original
browser and input method.
