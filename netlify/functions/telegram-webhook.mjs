const WEBSITE_URL = "https://shamsacademycoin.netlify.app";
const POSTER_URL = `${WEBSITE_URL}/assets/shams-academy-poster.png`;
const MINI_APP_URL = `${WEBSITE_URL}/ShamsAcademy.html`;
const WELCOME_CAPTION =
  "kelajakdagi yo'lingni biz bilan boshla hamda koinlar bilan maqsadlaringizga erishing!!!";

export async function handleWebhook(
  request,
  {
    env = process.env,
    fetchImpl = fetch,
  } = {},
) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  const botToken = env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!botToken || !webhookSecret) {
    console.error("Telegram bot environment variables are not configured.");
    return new Response("Bot configuration is incomplete", { status: 500 });
  }

  if (
    request.headers.get("x-telegram-bot-api-secret-token") !== webhookSecret
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update;
  try {
    update = await request.json();
  } catch (error) {
    console.error("Telegram webhook received invalid JSON:", error);
    return new Response("Invalid JSON", { status: 400 });
  }

  const message = update?.message;
  const senderId = message?.from?.id;
  const isPrivateChat = message?.chat?.type === "private";
  const isStartCommand =
    typeof message?.text === "string" &&
    /^\/start(?:@\w+)?(?:\s+\S.*)?$/i.test(message.text.trim());

  if (!isPrivateChat || !Number.isSafeInteger(senderId) || !isStartCommand) {
    return new Response("OK");
  }

  let telegramResponse;
  try {
    telegramResponse = await fetchImpl(
      `https://api.telegram.org/bot${botToken}/sendPhoto`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: message.chat.id,
          photo: POSTER_URL,
          caption: WELCOME_CAPTION,
          reply_markup: {
            inline_keyboard: [
              [{ text: "OPENBOT", web_app: { url: MINI_APP_URL } }],
            ],
          },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error) {
    console.error("Could not send the welcome advertisement to Telegram:", error);
    return new Response("Telegram request failed", { status: 502 });
  }

  let telegramResult;
  try {
    telegramResult = await telegramResponse.json();
  } catch (error) {
    console.error("Telegram returned an unreadable sendPhoto response:", error);
    return new Response("Telegram returned an invalid response", { status: 502 });
  }

  if (!telegramResult || typeof telegramResult !== "object") {
    console.error("Telegram returned an invalid sendPhoto response.");
    return new Response("Telegram returned an invalid response", { status: 502 });
  }

  if (!telegramResponse.ok || !telegramResult.ok) {
    console.error(
      "Telegram sendPhoto failed:",
      telegramResult.description || `HTTP ${telegramResponse.status}`,
    );
    return new Response("Telegram could not send the advertisement", {
      status: 502,
    });
  }

  return new Response("OK");
}

export default function telegramWebhook(request) {
  return handleWebhook(request);
}

export const config = {
  path: "/api/telegram-webhook",
  method: ["POST"],
};
