# Granola CDP Patching Strategy

Granola is an Electron app. Electron supports `--remote-debugging-port=<port>`, but Granola refuses to turn it on unless you also pass a "valid" CDP token.

The app already knows what a valid token's SHA-256 hash looks like, because that hash is baked into the app itself. For example, it may look like this 64-character hex string (the exact value is build-specific):

```
76a3b3ddc7d9fbd79a40ad868de9532e91fab98d008ac7d726f1f1108e560ebf
```

The token check at startup is:

1. You pass `--granola-cdp-token=<something>`.
2. Granola hashes `<something>` with SHA-256.
3. It compares that hash to the hardcoded hash inside the app.
4. If they match, remote debugging opens; if not, Granola restarts without `--remote-debugging-port`.

We cannot guess the right token. But we can patch the app so that, for the first minute after launch, every SHA-256 calculation returns the *same hardcoded hash Granola expects*. That way, no matter what token we pass, when Granola hashes it the result is the expected digest, the comparison succeeds, and the remote-debugging port turns on.

After that one-minute window, the patch turns itself off so Granola's normal SHA-256 hashing works again for telemetry, signing, and everything else.

Because the actual hardcoded hash is different for every Granola build, the steps are always: extract the bundle, find that build's hardcoded hash, make `sha256` return it for the first 60 seconds, then repack, fix the bundle integrity, and re-sign.
