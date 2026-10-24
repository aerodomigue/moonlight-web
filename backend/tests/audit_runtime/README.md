# Runtime audit probes

Run from the repository root after building `build/MoonlightWeb`. These are
reproductions of the original findings. `storage.py` now runs regression
assertions for durable PIN revocation and host identity persistence. `browser.py`
asserts valid audio RED SDP and renewal of a direct local browser's identity;
its unsigned-offer refusal is an expected security check. `revoke.py` and
`peer_policy.py` print observations: their zero exit code alone is not a pass.

```sh
python3 backend/tests/audit_runtime/storage.py
python3 backend/tests/audit_runtime/revoke.py
python3 backend/tests/audit_runtime/peer_policy.py
MW_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  python3 backend/tests/audit_runtime/browser.py
```

The Python scripts reuse the isolated HTTPS OIDC fixture. All service settings,
accounts, cookies and keys are temporary; sockets bind to loopback. The storage
probes require an unprivileged POSIX user, change permissions only in their own
temporary fixture directories, restore those permissions and clean up afterwards.
The revoke probe disables core dumps for its own child processes. No production
VM, browser profile or Apollo machine is accessed. Credentials are not printed.
The peer-policy probe requires a C++ compiler and Qt 6 Core/Network development
packages. It compiles the exact current function into a temporary executable.

Historical observations and the current remediation status are described in
`docs/design/post-identity-renewal-audit.md`.
