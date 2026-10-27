// Copy beside the pinned legacy-migration/sessions/lib/{ids,messages}.ts, then run with Bun.
import assert from "node:assert/strict";
import { parseMessagesFromConversation } from "./messages";

const messages = parseMessagesFromConversation(
  [
    { role: "user", ts: 1792746000000, content: "PRIVATE_PROMPT_MARKER" },
    {
      role: "assistant",
      ts: 1792746001000,
      content: "PRIVATE_RESPONSE_MARKER",
    },
  ],
  "roo:synthetic-task",
  "/synthetic/project",
  { ts: 1792746000000 },
);
assert.equal(messages[0].sessionID, "ses_migrated_f5dbf77874216ac1a5284fb467");
assert.equal(messages[1].id, "msg_migrated_f758f8d4791834fcff462a083d");
assert.deepEqual(messages[1].data.tokens, {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});
console.log(JSON.stringify(messages, null, 2));
