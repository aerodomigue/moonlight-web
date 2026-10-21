/* Copyright (C) 2026 Bruno Martin. GPLv3 — see repository LICENSE. */

/** No third-party ICE discovery. Explicit backend ICE configuration may replace this list. */
export function defaultIceServers() {
    return [];
}

/** Retained for callers of the legacy Internet Access UI. */
export function ourStunHost() {
    return '';
}
