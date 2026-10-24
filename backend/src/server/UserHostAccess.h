#pragma once
class HttpServer;
class AuthManager;
class ComputerManager;
class SessionPool;
void installUserHostAccess(HttpServer& server, AuthManager& auth, ComputerManager& computers,
                           SessionPool& pool);
