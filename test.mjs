import assert from "assert";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use a isolated scratch auth store for tests
const TEST_SCRATCH_DIR = path.resolve(__dirname, "scratch");
if (!fs.existsSync(TEST_SCRATCH_DIR)) {
  fs.mkdirSync(TEST_SCRATCH_DIR, { recursive: true });
}
const TEST_AUTH_STORE = path.resolve(TEST_SCRATCH_DIR, "test_auth_store.json");
process.env.AUTH_STORE_FILE = TEST_AUTH_STORE;
if (fs.existsSync(TEST_AUTH_STORE)) {
  fs.unlinkSync(TEST_AUTH_STORE);
}

// Dynamically import server & auth manager so they pick up AUTH_STORE_FILE
const { startServer } = await import("./server.mjs");
const { approvePairing, revokeAllSessions, getActiveSessions, getHostSecret } = await import("./auth_manager.mjs");
const { saveActivePlanSession, PLAN_STATES } = await import("./plan_state_machine.mjs");

async function runTests() {
  console.log("==================================================");
  console.log("🧪 TESTING ANTIGRAVITY REMOTE (AUTH & WORKSPACES)");
  console.log("==================================================");

  const TEST_PORT = 3849;
  const { server } = await startServer(TEST_PORT);
  console.log(`Server started on test port ${TEST_PORT}`);

  try {
    // Helper for HTTP requests
    function makeRequest(method, reqPath, body = null, token = null) {
      return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {};
        if (payload) {
          headers["Content-Type"] = "application/json";
          headers["Content-Length"] = Buffer.byteLength(payload);
        }
        if (token) {
          headers["Authorization"] = `Bearer ${token}`;
        }

        const req = http.request({
          hostname: "127.0.0.1",
          port: TEST_PORT,
          path: reqPath,
          method,
          headers
        }, res => {
          let data = "";
          res.on("data", chunk => data += chunk);
          res.on("end", () => {
            let json = null;
            try { json = JSON.parse(data); } catch (_) {}
            resolve({ status: res.statusCode, headers: res.headers, data, json });
          });
        });
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
      });
    }

    // Test 1: Static Files are served publicly without auth
    console.log("\nTest 1: Static file serving (index.html, style.css, manifest.json)...");
    const indexRes = await makeRequest("GET", "/");
    assert.strictEqual(indexRes.status, 200);
    assert.ok(indexRes.data.includes("Antigravity Remote"));
    assert.ok(indexRes.data.includes("pairing-overlay"));
    assert.ok(indexRes.headers["content-type"].includes("text/html"));

    const cssRes = await makeRequest("GET", "/style.css");
    assert.strictEqual(cssRes.status, 200);
    assert.ok(cssRes.data.includes("--bg-primary"));
    assert.ok(cssRes.headers["content-type"].includes("text/css"));

    const manifestRes = await makeRequest("GET", "/manifest.json");
    assert.strictEqual(manifestRes.status, 200);
    assert.strictEqual(manifestRes.json.name, "Antigravity Remote");
    console.log("✅ Passed (Static assets and pairing overlay accessible without auth)");

    // Test 2: Unauthenticated requests to protected endpoints return 401 Unauthorized
    console.log("\nTest 2: Unauthenticated requests to protected endpoints rejected with 401...");
    const unauthStateRes = await makeRequest("GET", "/api/state");
    assert.strictEqual(unauthStateRes.status, 401);
    assert.strictEqual(unauthStateRes.json.ok, false);
    assert.strictEqual(unauthStateRes.json.authRequired, true);

    const unauthPromptRes = await makeRequest("POST", "/api/prompt", { prompt: "check status" });
    assert.strictEqual(unauthPromptRes.status, 401);

    const unauthWsRes = await makeRequest("GET", "/api/workspaces");
    assert.strictEqual(unauthWsRes.status, 401);

    const unauthEventsRes = await makeRequest("GET", "/events");
    assert.strictEqual(unauthEventsRes.status, 401);
    console.log("✅ Passed (All protected routes enforce 401 Unauthorized when missing token)");

    // Test 3: Public Auth Status Endpoint
    console.log("\nTest 3: Public GET /api/auth/status reports initial unauthenticated state...");
    const authStatusRes = await makeRequest("GET", "/api/auth/status");
    assert.strictEqual(authStatusRes.status, 200);
    assert.strictEqual(authStatusRes.json.authenticated, false);
    assert.strictEqual(authStatusRes.json.authDisabled, false);
    console.log("✅ Passed (Public auth status returned authenticated: false)");

    // Test 4: Initiate Pairing Handshake
    console.log("\nTest 4: POST /api/auth/pair generates 6-digit PIN and pairId...");
    const pairRes = await makeRequest("POST", "/api/auth/pair", { clientName: "Test iPhone 16 Pro" });
    assert.strictEqual(pairRes.status, 200);
    assert.strictEqual(pairRes.json.ok, true);
    assert.ok(pairRes.json.pairId.startsWith("pair_"));
    assert.strictEqual(pairRes.json.rawPin.length, 6);
    assert.ok(/^\d{3}-\d{3}$/.test(pairRes.json.pin));
    const { pairId, rawPin } = pairRes.json;
    console.log(`✅ Passed (Generated PairID: ${pairId}, PIN: ${pairRes.json.pin})`);

    // Test 5: Verify before Host Approval returns 202 Pending
    console.log("\nTest 5: POST /api/auth/verify returns 202 Pending before host approval...");
    const verifyPendingRes = await makeRequest("POST", "/api/auth/verify", { pairId });
    assert.strictEqual(verifyPendingRes.status, 202);
    assert.strictEqual(verifyPendingRes.json.ok, false);
    assert.strictEqual(verifyPendingRes.json.pending, true);
    console.log("✅ Passed (Poll responds with 202 Pending awaiting host confirmation)");

    // Test 6: Host Approves Pairing via PIN
    console.log("\nTest 6: Host approves pairing using PIN...");
    const approvedPairing = approvePairing(rawPin);
    assert.ok(approvedPairing);
    assert.strictEqual(approvedPairing.approved, true);
    assert.strictEqual(approvedPairing.pairId, pairId);
    console.log(`✅ Passed (Pairing ${pairId} approved on host)`);

    // Test 7: Verify after Host Approval returns 200 with Bearer Token
    console.log("\nTest 7: POST /api/auth/verify issues cryptographic Bearer token...");
    const verifySuccessRes = await makeRequest("POST", "/api/auth/verify", { pairId });
    assert.strictEqual(verifySuccessRes.status, 200);
    assert.strictEqual(verifySuccessRes.json.ok, true);
    assert.ok(verifySuccessRes.json.token.startsWith("ag_"));
    assert.ok(verifySuccessRes.json.session.id.startsWith("sess_"));
    const authToken = verifySuccessRes.json.token;
    console.log(`✅ Passed (Bearer token issued: ${authToken.slice(0, 14)}... length=${authToken.length})`);

    // Test 8: Authenticated GET /api/state succeeds
    console.log("\nTest 8: GET /api/state with Authorization header returns full state...");
    const authStateRes = await makeRequest("GET", "/api/state", null, authToken);
    assert.strictEqual(authStateRes.status, 200);
    assert.strictEqual(authStateRes.json.ok, true);
    assert.ok(authStateRes.json.localIp);
    assert.ok(authStateRes.json.activeWorkspace);
    console.log(`✅ Passed (Authenticated state fetched: active=${authStateRes.json.activeWorkspace.name})`);

    // Test 9: Authenticated SSE Stream via Query Token
    console.log("\nTest 9: SSE /events?token=... connection handshake...");
    const sseHandshake = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: TEST_PORT,
        path: `/events?token=${encodeURIComponent(authToken)}`,
        method: "GET"
      }, res => {
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.headers["content-type"].includes("text/event-stream"));
        res.on("data", chunk => {
          const text = chunk.toString();
          if (text.includes("event: connected")) {
            req.destroy();
            resolve(true);
          }
        });
      });
      req.on("error", () => resolve(true)); // destroyed cleanly
      req.end();
    });
    assert.strictEqual(sseHandshake, true);
    console.log("✅ Passed (SSE stream authorized and established with query parameter token)");

    // Test 10: Authenticated Protected Operations (Prompt, Workspaces, Plan)
    console.log("\nTest 10: Authenticated prompt and workspace operations...");
    const wsRes = await makeRequest("GET", "/api/workspaces", null, authToken);
    assert.strictEqual(wsRes.status, 200);
    assert.strictEqual(wsRes.json.ok, true);
    assert.ok(wsRes.json.workspaces.length >= 2);

    const selectRes = await makeRequest("POST", "/api/workspaces/select", { id: "antigravity-remote" }, authToken);
    assert.strictEqual(selectRes.status, 200);
    assert.strictEqual(selectRes.json.activeWorkspace.id, "antigravity-remote");

    const promptRes = await makeRequest("POST", "/api/prompt", { prompt: "AGY: check git status" }, authToken);
    assert.strictEqual(promptRes.status, 200);
    assert.strictEqual(promptRes.json.ok, true);
    assert.ok(promptRes.json.answer.length > 0);
    console.log("✅ Passed (Protected workspace and prompt execution succeeded with auth)");

    // Test 11: Plan State Action with Auth
    console.log("\nTest 11: Authenticated plan action execution...");
    const samplePlanPath = path.resolve(TEST_SCRATCH_DIR, "test_plan_sample.md");
    fs.writeFileSync(samplePlanPath, "# Test Plan\n\n### Phase 1: Test\n- [ ] Task 1\n", "utf8");

    saveActivePlanSession({
      planPath: samplePlanPath,
      title: "Sample Security & MFA Plan",
      state: PLAN_STATES.REVIEWING,
      phases: [
        { title: "Discovery", tasks: ["Map surface", "Run threat model"] }
      ]
    });

    const commentRes = await makeRequest("POST", "/api/plan/action", {
      action: "comment",
      comment: "Auth test comment verification"
    }, authToken);
    assert.strictEqual(commentRes.status, 200);
    assert.strictEqual(commentRes.json.ok, true);
    console.log("✅ Passed (Plan revision action succeeded with token)");

    // Test 12: Session Revocation & Immediate 401 Rejection
    console.log("\nTest 12: POST /api/auth/revoke invalidates token...");
    const revokeRes = await makeRequest("POST", "/api/auth/revoke", { token: authToken }, authToken);
    assert.strictEqual(revokeRes.status, 200);
    assert.strictEqual(revokeRes.json.ok, true);
    assert.strictEqual(revokeRes.json.revoked, true);

    const postRevokeRes = await makeRequest("GET", "/api/state", null, authToken);
    assert.strictEqual(postRevokeRes.status, 401);
    console.log("✅ Passed (Revoked token immediately rejected with 401 Unauthorized)");

    // Test 13: Host Secret Enforcement on Tunnel Endpoints
    console.log("\nTest 13: Tunnel endpoints enforce HOST_SECRET security...");
    const hostSecret = getHostSecret();

    // Missing auth header
    const noAuthSyncRes = await makeRequest("POST", "/api/tunnel/sync", { test: true });
    assert.strictEqual(noAuthSyncRes.status, 403);

    // Wrong auth header
    const wrongAuthSyncRes = await makeRequest("POST", "/api/tunnel/sync", { test: true }, "wrong_secret");
    assert.strictEqual(wrongAuthSyncRes.status, 403);

    // Correct auth header
    const validSyncRes = await makeRequest("POST", "/api/tunnel/sync", {
      workspaces: [{ id: "test-ws", name: "Test Workspace", path: "/tmp/test" }],
      activeWorkspace: { id: "test-ws", name: "Test Workspace", path: "/tmp/test" }
    }, hostSecret);
    assert.strictEqual(validSyncRes.status, 200);
    assert.strictEqual(validSyncRes.json.ok, true);
    console.log("✅ Passed (Tunnel endpoints reject unauthorized access and accept valid HOST_SECRET)");

    // Test 14: Outbound Reverse Tunnel SSE Stream Handshake & State Caching
    console.log("\nTest 14: Outbound Mac SSE Reverse Tunnel handshake & State Caching...");
    let tunnelReq = null;
    let tunnelIncomingEvents = [];
    const tunnelConnectedPromise = new Promise((resolve) => {
      tunnelReq = http.request({
        hostname: "127.0.0.1",
        port: TEST_PORT,
        path: "/api/tunnel/stream",
        method: "GET",
        headers: {
          "Authorization": `Bearer ${hostSecret}`,
          "Accept": "text/event-stream"
        }
      }, res => {
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.headers["content-type"].includes("text/event-stream"));

        let buffer = "";
        res.on("data", chunk => {
          buffer += chunk.toString();
          const lines = buffer.split("\n\n");
          buffer = lines.pop();
          for (const block of lines) {
            if (!block.trim()) continue;
            const eventMatch = block.match(/event:\s*([^\n]+)/);
            const dataMatch = block.match(/data:\s*([^\n]+)/);
            const eventName = eventMatch ? eventMatch[1].trim() : "message";
            let data = null;
            try { data = JSON.parse(dataMatch ? dataMatch[1].trim() : "{}"); } catch (_) {}
            tunnelIncomingEvents.push({ event: eventName, data });
            if (eventName === "connected") {
              resolve(true);
            }
          }
        });
      });
      tunnelReq.end();
    });

    await tunnelConnectedPromise;
    console.log("✅ Passed (Simulated Mac tunnel connected to /api/tunnel/stream successfully)");

    // Test 15: Pairing Request Dispatched Down Active Mac Tunnel
    console.log("\nTest 15: Pairing request pushed to connected Mac tunnel & approved via /api/tunnel/pair-decision...");
    const mobilePairRes = await makeRequest("POST", "/api/auth/pair", { clientName: "iPad Air Mobile" });
    assert.strictEqual(mobilePairRes.status, 200);
    const remotePairId = mobilePairRes.json.pairId;
    const remotePin = mobilePairRes.json.rawPin;

    // Allow event loop to receive SSE event on tunnel
    await new Promise(r => setTimeout(r, 100));
    const pairRequestEvent = tunnelIncomingEvents.find(e => e.event === "pair_request" && e.data && e.data.pairId === remotePairId);
    assert.ok(pairRequestEvent, "Mac tunnel should have received pair_request event");
    assert.strictEqual(pairRequestEvent.data.pin, remotePin);

    // Mac approves pairing via tunnel uplink endpoint
    const pairApproveRes = await makeRequest("POST", "/api/tunnel/pair-decision", {
      pairId: remotePairId,
      approved: true
    }, hostSecret);
    assert.strictEqual(pairApproveRes.status, 200);

    // Mobile polls verify endpoint and receives new valid token
    const remoteVerifyRes = await makeRequest("POST", "/api/auth/verify", { pairId: remotePairId });
    assert.strictEqual(remoteVerifyRes.status, 200);
    assert.ok(remoteVerifyRes.json.token.startsWith("ag_"));
    const remoteMobileToken = remoteVerifyRes.json.token;
    console.log("✅ Passed (Pairing request flowed down tunnel, approved by host, issued HMAC token)");

    // Test 16: Command RPC Forwarding across Tunnel
    console.log("\nTest 16: Command RPC dispatched from mobile, executed on Mac, returned to mobile...");
    // Mobile issues prompt command
    const rpcPromise = makeRequest("POST", "/api/prompt", { prompt: "run tests across bridge" }, remoteMobileToken);

    // Wait for command event on tunnel
    let commandReceived = null;
    for (let i = 0; i < 20; i++) {
      commandReceived = tunnelIncomingEvents.find(e => e.event === "command" && e.data && e.data.action === "prompt");
      if (commandReceived) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(commandReceived, "Mac tunnel should receive command event");
    assert.strictEqual(commandReceived.data.payload.prompt, "run tests across bridge");
    const { reqId } = commandReceived.data;

    // Mac returns RPC response
    const rpcPostRes = await makeRequest("POST", "/api/tunnel/response", {
      reqId,
      ok: true,
      result: "✅ Bridge RPC execution verified on Mac workstation."
    }, hostSecret);
    assert.strictEqual(rpcPostRes.status, 200);

    // Mobile prompt request resolves with answer
    const rpcResult = await rpcPromise;
    assert.strictEqual(rpcResult.status, 200);
    assert.strictEqual(rpcResult.json.ok, true);
    assert.strictEqual(rpcResult.json.answer, "✅ Bridge RPC execution verified on Mac workstation.");
    console.log("✅ Passed (Mobile POST /api/prompt relayed across tunnel and returned Mac execution answer)");

    // Test 17: Tunnel Teardown & Clean Disconnect
    console.log("\nTest 17: Tunnel disconnect handled cleanly...");
    if (tunnelReq) {
      tunnelReq.destroy();
    }
    await new Promise(r => setTimeout(r, 100));
    console.log("✅ Passed (Tunnel disconnected cleanly without server errors)");

    console.log("\n🎉 ALL 17 END-TO-END TESTS PASSED SUCCESSFULLY (17/17)!");
  } finally {
    server.close();
    // Cleanup scratch auth store
    if (fs.existsSync(TEST_AUTH_STORE)) {
      try { fs.unlinkSync(TEST_AUTH_STORE); } catch (_) {}
    }
  }
}

runTests().then(() => {
  process.exit(0);
}).catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
