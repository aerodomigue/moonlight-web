#pragma once
#include "AuthConfig.h"
#include <QJsonObject>
#include <optional>

namespace OidcToken {
std::optional<QJsonObject> verifyLogout(const QByteArray& jwt, const QJsonObject& jwks,
                                        const AuthConfig& config, qint64 now);
std::optional<QJsonObject> verify(const QByteArray& jwt, const QJsonObject& jwks,
                                  const AuthConfig& config, const QString& nonce, qint64 now);
} // namespace OidcToken
