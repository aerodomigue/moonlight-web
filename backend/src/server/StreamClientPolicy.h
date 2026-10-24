#pragma once
#include "common/Types.h"
#include "NetClassify.h"

namespace StreamClientPolicy {
inline NetClassify::Kind classify(const HttpRequest& req)
{
    const auto kind = NetClassify::classify(req.clientAddress);
    if (kind != NetClassify::Kind::Loopback && kind != NetClassify::Kind::Private) return kind;
    // ProxyHeaders resolved this address from an explicitly trusted socket peer.
    // This affects candidate selection only, never authentication or privileges.
    if (req.viaProxy && !req.viaTunnel) return kind;
    const bool localProxy = kind == NetClassify::Kind::Loopback && !req.hostTrusted;
    const bool forwarded = req.headers.contains("x-forwarded-for") ||
                           req.headers.contains("forwarded") ||
                           req.headers.contains("cf-connecting-ip") ||
                           req.headers.contains("tailscale-funnel-request");
    return localProxy || forwarded ? NetClassify::Kind::Public : kind;
}
} // namespace StreamClientPolicy
