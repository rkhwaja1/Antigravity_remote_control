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
const { approvePairing, revokeAllSessions, getActiveSessions } = await import("./auth_manager.mjs");
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
    assert.ok(verifySuccessRes.json.token.startsWith("ag_sec_"));
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

    console.log("\n🎉 ALL 12 END-TO-END TESTS PASSED SUCCESSFULLY (12/12)!");
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
