#pragma once
class HttpServer;
class AuthManager;
class ComputerManager;
class SessionPool;
void registerAdminUserRoutes(HttpServer& server, AuthManager& auth, ComputerManager& computers,
                             SessionPool& pool);
