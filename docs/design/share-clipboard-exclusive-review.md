# Sharing, Apollo clipboard and exclusive input review

## Sharing capability and request lifetime

Reproduction: `frontend/test/ShareMenu.test.js` fails six checks on the previous
implementation (unconditional requests, permanent refusal polling, late mount,
overlapping requests). Seven checks now pass; the existing 27 board checks pass.
The HTTPS OIDC integration exercises anonymous, ordinary SSO, SSO administrator,
ordinary PIN and local-owner PIN accounts. Administration does not grant sharing.
The REST authorizer remains authoritative, including checks on the selected host
and the primary stream. A contextual refusal removes the menu.

Review: capability is denied before SSO page activation; no authorization path or
request signature changed. Abort propagates through authenticatedFetch; completion
checks destruction before touching the DOM. A chained timer prevents overlapping
polls, backs off transient errors to 60 seconds, and stops on 401/403/404. Board
close callbacks cannot restart a destroyed menu. Both host-list and stream entry
points require the capability. Backend compilation and frontend check pass.

Performance: the old implementation makes one request every five seconds even
when denied. The new UI makes zero for an unauthorized account. This eliminates
unnecessary signing, network traffic and console errors; it does not yet prove
that those requests caused the reported micro-freezes. Frame timing measurements
and actual Apollo validation are tracked separately from unit-test results.
