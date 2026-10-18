# Lessons & Learned Patterns

## General
- When building mobile remote features, ensure responsive touch targets (minimum 44px) and smooth modal bottom sheets.
- Ensure state updates broadcast over Server-Sent Events (SSE) so all connected devices update in real-time.
- Always preserve active state on reconnect or page reload via local persistence (`workspaces.json`).

## Mobile Remote Payloads & Conversation Ingestion
- When a user sends a prompt directive from mobile (phone/iPad): do not just acknowledge log receipt. Immediately display and execute the directive in the active conversation window and stream full results back to mobile so the user sees the output.
- Process targeting on macOS: Antigravity IDE has bundle ID `com.google.antigravity-ide` and runs as process `Electron` (not process `"Antigravity"` which is the 2.0 desktop app). Any AppleScript or OS automation must target `application id "com.google.antigravity-ide"` or process `whose bundle identifier is "com.google.antigravity-ide"`.
- Never truncate execution output payloads (e.g. slicing to 300 characters in `server.mjs`); return the full response to the mobile client so the user has the complete output.

