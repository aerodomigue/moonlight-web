# Discovery confirmation and SSO account isolation review

## Backend change

Discovery previously called the persistence path as soon as mDNS/serverinfo
answered. It now writes only an owner-scoped, bounded in-memory observation.
Candidate IDs are opaque, different per owner, expire 120 seconds after their
last observation, and confer no host/resource access.

Reviewed: exact route exceptions preserve the global signature/CSRF gates;
owner comes from the authenticated request; confirmation re-fetches serverinfo,
checks physical identity, registration collisions (including disabled records),
account activity and discovery generation after the asynchronous reply. A pending
confirmation cannot duplicate itself or survive disable/re-enable. Persistence
failure removes the new record and restores the settings cache before responding.
Each confirmed addition gets a fresh certificate seat, including when an older
administratively cloned seat survives. Existing registrations and explicit
administrator clone/transfer semantics are unchanged.

Validation: 52 HTTPS integration scenarios pass, including confirmation, concurrent
clicks/cancellation, identity mismatch, forbidden cross-account IDs, CSRF/signature
requirements, disabled collision, restart and write failure. Unit checks cover
TTL boundaries, refresh, owner isolation and bounds; the full unit executable
reports 17094/17099, with only the five existing Linux launcher-path failures.

## Frontend change

Pending review and browser verification before commit.
