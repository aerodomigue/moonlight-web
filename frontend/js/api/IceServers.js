/* Copyright (C) 2026 Bruno Martin. GPLv3 — see repository LICENSE. */

/** Public ICE discovery for direct streaming; no MoonlightWeb rendezvous/STUN. */
export function defaultIceServers() {
    return [{ urls: 'stun:stun.cloudflare.com:3478' }];
}

/** Retained for callers of the legacy Internet Access UI. */
export function ourStunHost() {
    return '';
}
