# Wake-on-LAN metadata and configuration review

## Defects and correction

Apollo returns a zero MAC on HTTP serverinfo and exposes its actual MAC only to a
paired HTTPS client. The previous registration/poll paths never persisted the HTTPS
value. ARP cannot recover the target MAC across a router. The old configuration
form also offered empty inputs without reading saved overrides, and its POST ignored
storage errors. The missing GET was reproduced against the previous binary (404).

Manual and explicitly confirmed discovery additions now retain available metadata,
with ARP restricted to directly connected targets. Manual address registration is
saved in the same transaction as the registration. Failed writes restore the old
in-memory values and Qt settings cache rather than claiming success.

The two pairing completion paths schedule bounded HTTPS enrichment. Existing online
paired registrations with unverified metadata are also enriched. The client identity
belongs to the registration; the server certificate is pinned before accepting the
response, HTTP redirects are disabled, and the physical UUID must match. No apps,
pair state, certificates or privileges are imported from this metadata reply.
Authenticated MAC provenance is persisted and cannot be downgraded by HTTP/ARP.
Operator overrides stay separate.

Requests are serialized against polling/pair checks for the same physical PC;
failed attempts wait five minutes. Streaming and inactive accounts block collection.
Deletion, transfer, disabling and pairing invalidate outstanding callbacks. A forced
refresh after pairing remains pending if another operation temporarily blocks it.
The new GET inherits the existing per-owner, enabled-host, signed-SSO and guest gates.
Network data appears only on that endpoint, never credentials or client keys.

## UI review

The form loads detected/manual/effective values before enabling Save. Automatic
values are read-only and submitting that mode clears overrides rather than freezing
the displayed IP/MAC. Manual mode restores existing overrides, or starts from the
detected values. Failed reads offer Retry and cannot erase configuration; failed
writes preserve the draft. Closed forms and account revisions reject late results;
view stop/destroy and account-change notifications remove the dialog/listener.

French desktop/mobile Chromium verification covers signed SSO requests, prefilled
values, manual save/reopen, automatic reset, Escape, and the routed-network warning.
No wake request is issued. Visual inspection caught the global button display rule
overriding `hidden`; a scoped rule now hides Retry correctly after successful reads.

## Validation and limits

- Seven HTTPS WOL tests include mutual client TLS, restart persistence, foreign-owner
  denial, wrong certificate/UUID, zero MAC, timeout, retry throttling, disabled-host
  late replies, registration and override persistence failures.
- Unit tests cover MAC validation, same-LAN ARP, actual interface masks, public/routed
  destination refusal, serialization/provenance and authenticated MAC precedence.
- Eleven WOL UI tests cover existing controls, automatic/manual configuration,
  failed loads/saves, late responses and account changes.
- Full frontend: 1,772 tests; formatting, ESLint and all three locales pass.
  TypeScript has no new diagnostics relative to the existing baseline.
- Backend unit run: 17,103/17,108 assertions pass; the five launcher-path failures
  remain Linux baseline failures. A loaded concurrent run also hit the existing
  feed-IPC timing assertions; an isolated repeat has only those five baseline failures.
- Integration discovery must run in a loopback-only network namespace: on the VM's
  real LAN it legitimately sees real Apollo PCs, invalidating fixture counts.

Knowing an IP/MAC does not establish WOL reachability. The implementation continues
to require a directly connected broadcast-capable private IPv4 LAN. No routed WOL,
router changes or public-address forwarding is introduced. Real recovery of the
missing metadata will be checked after deployment without waking or unpairing a PC.
