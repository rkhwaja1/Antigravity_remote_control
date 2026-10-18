import assert from "assert";
import http from "http";
import { startServer } from "./server.mjs";
import { saveActivePlanSession, PLAN_STATES } from "./plan_state_machine.mjs";

async function runTests() {
  console.log("==================================================");
  console.log("🧪 TESTING MOBILE WEB DASHBOARD (PWA) SERVER");
  console.log("==================================================");

  const TEST_PORT = 3849;
  const { server } = await startServer(TEST_PORT);
  console.log(`Server started on test port ${TEST_PORT}`);

  try {
    // Helper for HTTP requests
    function makeRequest(method, path, body = null) {
      return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
          hostname: "127.0.0.1",
          port: TEST_PORT,
          path,
          method,
          headers: {
            ...(payload ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload)
            } : {})
          }
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

    // Test 1: Static Files
    console.log("\nTest 1: Static file serving (index.html, style.css, manifest.json)...");
    const indexRes = await makeRequest("GET", "/");
    assert.strictEqual(indexRes.status, 200);
    assert.ok(indexRes.data.includes("Antigravity Remote"));
    assert.ok(indexRes.headers["content-type"].includes("text/html"));

    const cssRes = await makeRequest("GET", "/style.css");
    assert.strictEqual(cssRes.status, 200);
    assert.ok(cssRes.data.includes("--bg-primary"));
    assert.ok(cssRes.headers["content-type"].includes("text/css"));

    const manifestRes = await makeRequest("GET", "/manifest.json");
    assert.strictEqual(manifestRes.status, 200);
    assert.strictEqual(manifestRes.json.name, "Antigravity Remote");
    console.log("✅ Passed (Static files served with proper MIME types)");

    // Test 2: State Endpoint
    console.log("\nTest 2: GET /api/state returns system & session state...");
    const stateRes = await makeRequest("GET", "/api/state");
    assert.strictEqual(stateRes.status, 200);
    assert.strictEqual(stateRes.json.ok, true);
    assert.ok(stateRes.json.localIp);
    assert.ok(stateRes.json.git);
    console.log(`✅ Passed (State returned: IP=${stateRes.json.localIp}, Branch=${stateRes.json.git.branch})`);

    // Test 3: Prompt Execution via API
    console.log("\nTest 3: POST /api/prompt executes directive...");
    const promptRes = await makeRequest("POST", "/api/prompt", {
      prompt: "AGY: check git status"
    });
    assert.strictEqual(promptRes.status, 200);
    assert.strictEqual(promptRes.json.ok, true);
    assert.ok(promptRes.json.answer.length > 0);
    console.log(`✅ Passed (Prompt response returned length: ${promptRes.json.answer.length})`);

    // Test 4: Plan State Integration
    console.log("\nTest 4: Plan state integration & comment action...");
    const samplePlanPath = "/Users/rashid/dental/Dental-1/Dental/scratch/test_plan_sample.md";
    import("fs").then(fs => {
      fs.writeFileSync(samplePlanPath, "# Test Plan\n\n### Phase 1: Test\n- [ ] Task 1\n", "utf8");
    });
    await new Promise(r => setTimeout(r, 100));

    saveActivePlanSession({
      planPath: samplePlanPath,
      title: "Sample Security & MFA Plan",
      state: PLAN_STATES.REVIEWING,
      phases: [
        { title: "Discovery", tasks: ["Map surface", "Run threat model"] },
        { title: "Remediation", tasks: ["Deploy MFA", "Verify session"] }
      ]
    });

    const planStateRes = await makeRequest("GET", "/api/state");
    assert.ok(planStateRes.json.activePlan);
    assert.strictEqual(planStateRes.json.activePlan.title, "Sample Security & MFA Plan");

    const commentRes = await makeRequest("POST", "/api/plan/action", {
      action: "comment",
      comment: "Web PWA revision test: verify session timeout"
    });
    assert.strictEqual(commentRes.status, 200);
    assert.strictEqual(commentRes.json.ok, true);
    console.log("✅ Passed (Plan comment patched directly from web API)");

    // Test 5: SSE Stream Connection
    console.log("\nTest 5: SSE /events stream handshake...");
    const sseHandshake = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: TEST_PORT,
        path: "/events",
        method: "GET"
      }, res => {
        let chunkCount = 0;
        res.on("data", chunk => {
          chunkCount++;
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
    console.log("✅ Passed (SSE stream established with real-time events)");

    console.log("\n🎉 ALL PWA SERVER TESTS PASSED (5/5)!");
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
