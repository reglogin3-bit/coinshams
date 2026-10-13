import assert from "node:assert/strict";
import test from "node:test";
import { handleWebhook } from "../netlify/functions/telegram-webhook.mjs";

const secret = "test-webhook-secret-123";
const env = {
  TELEGRAM_BOT_TOKEN: "123456:test-token",
  TELEGRAM_WEBHOOK_SECRET: secret,
};

function makeRequest(update, options = {}) {
  return new Request("https://example.netlify.app/api/telegram-webhook", {
    method: options.method || "POST",
    headers: options.headers || {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: options.method === "GET" ? undefined : JSON.stringify(update),
  });
}

const startUpdate = {
  message: {
    message_id: 10,
    from: { id: 456 },
    chat: { id: 456, type: "private" },
    text: "/start",
  },
};

test("first private /start sends the poster with one Telegram Mini App button", async () => {
  const sent = [];
  const response = await handleWebhook(makeRequest(startUpdate), {
    env,
    fetchImpl: async (url, options) => {
      sent.push({ url, body: JSON.parse(options.body) });
      return Response.json({ ok: true });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/bot123456:test-token\/sendPhoto$/);
  assert.equal(sent[0].body.chat_id, 456);
  assert.equal(
    sent[0].body.caption,
    "kelajakdagi yo'lingni biz bilan boshla hamda koinlar bilan maqsadlaringizga erishing!!!",
  );
  assert.deepEqual(sent[0].body.reply_markup.inline_keyboard, [
    [
      {
        text: "OPENBOT",
        web_app: {
          url: "https://shamsacademycoin.netlify.app/ShamsAcademy.html",
        },
      },
    ],
  ]);
});

test("repeat /start sends the ad again and leaves the command undeleted", async () => {
  const sent = [];
  const dependencies = {
    env,
    fetchImpl: async (url, options) => {
      sent.push({ url, body: JSON.parse(options.body) });
      return Response.json({ ok: true });
    },
  };

  assert.equal((await handleWebhook(makeRequest(startUpdate), dependencies)).status, 200);
  assert.equal((await handleWebhook(makeRequest(startUpdate), dependencies)).status, 200);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(({ url }) => /\/sendPhoto$/.test(url)));
  assert.ok(
    sent.every(
      ({ body }) =>
        body.reply_markup.inline_keyboard[0][0].text === "OPENBOT",
    ),
  );
});

test("rejects requests without the Telegram webhook secret", async () => {
  const response = await handleWebhook(
    makeRequest(startUpdate, { headers: { "content-type": "application/json" } }),
    { env, fetchImpl: async () => assert.fail("must not send") },
  );

  assert.equal(response.status, 401);
});

test("ignores non-start messages and group chats", async () => {
  let sentCount = 0;
  const dependencies = {
    env,
    fetchImpl: async () => {
      sentCount += 1;
      return Response.json({ ok: true });
    },
  };

  const nonStart = structuredClone(startUpdate);
  nonStart.message.text = "/help";
  const groupStart = structuredClone(startUpdate);
  groupStart.message.chat.type = "group";

  assert.equal((await handleWebhook(makeRequest(nonStart), dependencies)).status, 200);
  assert.equal((await handleWebhook(makeRequest(groupStart), dependencies)).status, 200);
  assert.equal(sentCount, 0);
});

test("rejects methods other than POST", async () => {
  const response = await handleWebhook(makeRequest({}, { method: "GET" }), {
    env,
  });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});
