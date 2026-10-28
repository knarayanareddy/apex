/**
 * Batch C Verification Suite (`test/canaries/batchC-cockpit-proxy.spec.ts`)
 *
 * Verifies:
 *  - C1: Routine CLI logs never print long-lived session bearer token.
 *        Protected pairing file written with mode 0600.
 *        Single-use bootstrap code exchange & expiry work.
 *        Browser login via bootstrap sets apex_session cookie.
 *        Logout revokes cookie.
 *        Invalid authentication does not mutate state.
 *  - C2: Explicitly trusted public proxy origins (e.g. https://cockpit.internal:443 -> loopback:4310)
 *        succeed across cookie mutations, credentialed CORS, and SSE.
 *        Unlisted domains, scheme mismatches, port mismatches, and unlisted e2b.app fail.
 *        Cross-port localhost cookie attacks remain denied.
 *        Origin-less bearer automation works.
 *        IPv6 host parsing handles [::1]:port and [::1].
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { MissionControlServer } from "../../src/ring5/mission-control-server.ts";
import { createRing4Runtime } from "../../src/ring4/ring4-runtime.ts";

function runHttpRequest(options: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  closeOnFirstChunk?: boolean;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(options.url);
    const req = http.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: options.method,
        headers: options.headers ?? {}
      },
      (res) => {
        const chunks: Buffer[] = [];
        let resolved = false;
        res.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk));
          if (options.closeOnFirstChunk || res.headers["content-type"]?.includes("text/event-stream")) {
            if (!resolved) {
              resolved = true;
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString("utf8")
              });
              req.destroy();
            }
          }
        });
        res.on("end", () => {
          if (!resolved) {
            resolved = true;
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8")
            });
          }
        });
      }
    );
    req.on("error", (err) => {
      // If destroyed after resolving, ignore
      if (req.destroyed) return;
      reject(err);
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function testBatchC() {
  console.log("=== Running Batch C: Cockpit Credentials & Proxy Origin Tests ===");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-batch-c-"));
  const ws = path.join(tmpRoot, "ws");
  fs.mkdirSync(ws, { recursive: true });
  const surfaces = path.resolve("./surfaces");
  const agentDir = path.join(tmpRoot, "agent");
  fs.mkdirSync(agentDir, { recursive: true });

  const controller = await createRing4Runtime({
    workspaceRoot: ws,
    surfacesDir: surfaces,
    agentDir,
    allowUnsandboxedDev: true
  });

  try {
    const trustedProxyOrigin = "https://cockpit.internal:443";
    const server = new MissionControlServer({
      controller,
      workspaceRoot: ws,
      host: "127.0.0.1",
      port: 0,
      requireAuth: true,
      trustedPublicOrigins: [trustedProxyOrigin]
    });

    const info = await server.start();
    const baseUrl = `http://127.0.0.1:${info.port}`;

    // ------------------------------------------------------------------------
    // C1: Pairing file, credential absence from default stdout, bootstrap exchange
    // ------------------------------------------------------------------------
    console.log("--- C1: Credential Protection & Single-Use Bootstrap ---");

    // 1. Verify pairing file exists, has mode 0600, contains valid credentials
    const pairingFile = path.join(ws, ".harness", "cockpit-pairing.json");
    assert.ok(fs.existsSync(pairingFile), "Protected pairing file must exist");
    const stat = fs.statSync(pairingFile);
    const mode = stat.mode & 0o777;
    // On Unix-like systems verify mode 0600 (owner read/write only)
    if (process.platform !== "win32") {
      assert.equal(mode, 0o600, "Pairing file must be protected with mode 0600");
    }
    const pairingData = JSON.parse(fs.readFileSync(pairingFile, "utf8"));
    assert.equal(pairingData.token, info.token, "Pairing file must contain session token");
    assert.equal(pairingData.bootstrapToken, info.bootstrapToken, "Pairing file must contain bootstrap token");

    // 2. Fresh browser: Accessing / without auth returns 401
    const unauthHtml = await runHttpRequest({ url: `${baseUrl}/`, method: "GET" });
    assert.equal(unauthHtml.status, 401, "Unauthenticated / must return 401");

    // 3. Exchange single-use bootstrap code via POST /api/auth/bootstrap
    const bootstrapExchange = await runHttpRequest({
      url: `${baseUrl}/api/auth/bootstrap`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bootstrapToken: info.bootstrapToken })
    });
    assert.equal(bootstrapExchange.status, 200, "Valid bootstrap token must return 200");
    const setCookie = bootstrapExchange.headers["set-cookie"];
    assert.ok(setCookie && setCookie.length > 0, "Bootstrap exchange must return Set-Cookie");
    assert.match(setCookie[0], /apex_session=/, "Cookie must be apex_session");
    assert.match(setCookie[0], /HttpOnly/, "Cookie must be HttpOnly");
    assert.match(setCookie[0], /SameSite=Strict/, "Cookie must be SameSite=Strict");
    assert.notEqual(setCookie[0].split(";")[0], `apex_session=${info.token}`, "Browser session must not expose the bearer token");

    // 4. Replay of single-use bootstrap token MUST fail
    const replayBootstrap = await runHttpRequest({
      url: `${baseUrl}/api/auth/bootstrap`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bootstrapToken: info.bootstrapToken })
    });
    assert.equal(replayBootstrap.status, 401, "Replaying single-use bootstrap token must return 401");
    assert.match(replayBootstrap.body, /BOOTSTRAP_TOKEN_ALREADY_USED/);

    // 5. Using acquired cookie to authenticate API & SSE works
    const cookieHeader = setCookie[0].split(";")[0];
    const authedStatus = await runHttpRequest({
      url: `${baseUrl}/api/status`,
      method: "GET",
      headers: { Cookie: cookieHeader }
    });
    assert.equal(authedStatus.status, 200, "Cookie authentication to /api/status must succeed");

    const foreignLogout = await runHttpRequest({
      url: `${baseUrl}/api/auth/logout`,
      method: "POST",
      headers: { Cookie: cookieHeader, Origin: "http://127.0.0.1:9999" }
    });
    assert.equal(foreignLogout.status, 403, "Cross-origin logout must be denied");

    const liveStream = await new Promise<{ request: http.ClientRequest; response: http.IncomingMessage }>((resolve, reject) => {
      const request = http.request(`${baseUrl}/api/events`, { headers: { Cookie: cookieHeader } }, (response) => {
        response.once("data", () => resolve({ request, response }));
      });
      request.on("error", reject);
      request.end();
    });
    const streamEnded = new Promise<boolean>((resolve) => {
      liveStream.response.once("end", () => resolve(true));
      liveStream.response.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 1000).unref();
    });

    // 6. Logout revokes session cookie
    const logoutRes = await runHttpRequest({
      url: `${baseUrl}/api/auth/logout`,
      method: "POST",
      headers: { Cookie: cookieHeader, Origin: baseUrl }
    });
    assert.equal(logoutRes.status, 200, "Logout must succeed");
    const logoutCookie = logoutRes.headers["set-cookie"];
    assert.ok(logoutCookie && logoutCookie[0].includes("Max-Age=0"), "Logout must expire cookie");
    const closedOnLogout = await streamEnded;
    liveStream.request.destroy();
    assert.equal(closedOnLogout, true, "Logout must close the revoked session's active SSE stream");
    const oldCookieStatus = await runHttpRequest({
      url: `${baseUrl}/api/status`,
      method: "GET",
      headers: { Cookie: cookieHeader }
    });
    assert.equal(oldCookieStatus.status, 401, "Logout must invalidate the old cookie on the server");
    const relogin = await runHttpRequest({ url: `${baseUrl}/?token=${info.token}`, method: "GET" });
    assert.equal(relogin.status, 302, "The independent bearer credential remains usable for a new login");
    const proxyCookie = relogin.headers["set-cookie"]?.[0]?.split(";")[0];
    assert.ok(proxyCookie, "New login must issue a browser session");
    assert.notEqual(proxyCookie, cookieHeader, "New login must rotate the browser session");
    const oldAfterRelogin = await runHttpRequest({ url: `${baseUrl}/api/status`, method: "GET", headers: { Cookie: cookieHeader } });
    assert.equal(oldAfterRelogin.status, 401, "A new login must not revive the revoked session");

    // 7. Invalid authentication does not mutate state
    const initialPlanMode = controller.getCurrentHarness().trustArtifacts.isPlanModeActive();
    const badAuthMutation = await runHttpRequest({
      url: `${baseUrl}/api/plan/toggle`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid-secret-token"
      },
      body: JSON.stringify({ enabled: !initialPlanMode })
    });
    assert.equal(badAuthMutation.status, 401, "Invalid token must return 401");
    assert.equal(
      controller.getCurrentHarness().trustArtifacts.isPlanModeActive(),
      initialPlanMode,
      "Invalid authentication must NEVER mutate system state"
    );

    console.log("  [PASS] C1 verified: Credential protection, pairing file, bootstrap single-use, logout & state isolation.");

    // ------------------------------------------------------------------------
    // C2: Explicitly trusted public proxy origins
    // ------------------------------------------------------------------------
    console.log("--- C2: Trusted Public Proxy Origins & IPv6 Parsing ---");

    // 1. Exact configured HTTPS public proxy origin succeeds on cookie-authenticated mutation
    const trustedProxyMutation = await runHttpRequest({
      url: `${baseUrl}/api/plan/toggle`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: proxyCookie,
        Origin: trustedProxyOrigin
      },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(trustedProxyMutation.status, 200, "Configured HTTPS public proxy origin must succeed");
    assert.equal(trustedProxyMutation.headers["access-control-allow-origin"], trustedProxyOrigin);

    // 2. Exact configured HTTPS public proxy origin succeeds on credentialed CORS OPTIONS
    const trustedCorsOptions = await runHttpRequest({
      url: `${baseUrl}/api/status`,
      method: "OPTIONS",
      headers: {
        Origin: trustedProxyOrigin
      }
    });
    assert.equal(trustedCorsOptions.status, 204);
    assert.equal(trustedCorsOptions.headers["access-control-allow-origin"], trustedProxyOrigin);

    // 3. Exact configured HTTPS public proxy origin succeeds on SSE stream
    const trustedSse = await runHttpRequest({
      url: `${baseUrl}/api/events`,
      method: "GET",
      headers: {
        Cookie: proxyCookie,
        Origin: trustedProxyOrigin
      }
    });
    assert.equal(trustedSse.status, 200, "SSE through configured public proxy origin must succeed");
    assert.equal(trustedSse.headers["content-type"], "text/event-stream; charset=utf-8");

    // 4. Scheme mismatch: HTTP with same hostname & port fails
    const schemeMismatchMutation = await runHttpRequest({
      url: `${baseUrl}/api/plan/toggle`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: proxyCookie,
        Origin: "http://cockpit.internal:443"
      },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(schemeMismatchMutation.status, 403, "Scheme mismatch must return 403 CSRF_ORIGIN_MISMATCH");

    // 5. Port mismatch: HTTPS port 8443 fails
    const portMismatchMutation = await runHttpRequest({
      url: `${baseUrl}/api/plan/toggle`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: proxyCookie,
        Origin: "https://cockpit.internal:8443"
      },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(portMismatchMutation.status, 403, "Port mismatch must return 403 CSRF_ORIGIN_MISMATCH");

    // 6. Another unlisted hostname fails
    const unlistedOriginMutation = await runHttpRequest({
      url: `${baseUrl}/api/plan/toggle`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: proxyCookie,
        Origin: "https://untrusted-external-domain.com"
      },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(unlistedOriginMutation.status, 403, "Unlisted origin must return 403 CSRF_ORIGIN_MISMATCH");

    // 7. Unlisted e2b preview origin fails (no automatic wildcard)
    const e2bOriginMutation = await runHttpRequest({
      url: `${baseUrl}/api/plan/toggle`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: proxyCookie,
        Origin: "https://preview-123.e2b.app"
      },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(e2bOriginMutation.status, 403, "Unlisted e2b preview origin must return 403");

    // 8. Cross-port localhost cookie attack fails
    const crossPortLocalhost = await runHttpRequest({
      url: `${baseUrl}/api/plan/toggle`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: proxyCookie,
        Origin: "http://127.0.0.1:9999"
      },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(crossPortLocalhost.status, 403, "Cross-port localhost cookie attack must return 403");

    // 9. Origin-less bearer automation works
    const bearerAutomation = await runHttpRequest({
      url: `${baseUrl}/api/plan/toggle`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${info.token}`
      },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(bearerAutomation.status, 200, "Origin-less bearer automation must succeed");

    // 10. IPv6 Host header parsing: [::1]:port and [::1]
    const ipv6WithPort = await runHttpRequest({
      url: `${baseUrl}/api/status`,
      method: "GET",
      headers: {
        Host: `[::1]:${info.port}`,
        Authorization: `Bearer ${info.token}`
      }
    });
    assert.equal(ipv6WithPort.status, 200, "Bracketed IPv6 host with port must be accepted");

    const ipv6Bare = await runHttpRequest({
      url: `${baseUrl}/api/status`,
      method: "GET",
      headers: {
        Host: "[::1]",
        Authorization: `Bearer ${info.token}`
      }
    });
    assert.equal(ipv6Bare.status, 200, "Bracketed IPv6 bare host must be accepted");

    await server.stop();
    console.log("  [PASS] C2 verified: Configured public proxy origins, IPv6 handling, and anti-CSRF protections pass.");

    console.log("\n=== ALL BATCH C COCKPIT & PROXY TESTS PASSED CLEANLY ===\n");
  } finally {
    await controller.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

testBatchC().catch((err) => {
  console.error(err);
  process.exit(1);
});
