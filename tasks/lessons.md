# Lessons & Learned Patterns

## General
- When building mobile remote features, ensure responsive touch targets (minimum 44px) and smooth modal bottom sheets.
- Ensure state updates broadcast over Server-Sent Events (SSE) so all connected devices update in real-time.
- Always preserve active state on reconnect or page reload via local persistence (`workspaces.json`).
