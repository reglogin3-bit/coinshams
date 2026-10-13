import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handler } from "../netlify/functions/coin-api.mjs";

const env = {
  NETLIFY_DB_URL: "postgres://test:test@localhost/test",
  SUPERADMIN_SETUP_KEY: "one-time-test-setup-key",
};
const DEAD_SESSION_PATTERN = /avval tizimga kiring|sessiya tugagan|Hisob ma’lumoti topilmadi/i;

function createDatabase({ role = "student" } = {}) {
  const statements = [];
  let account;
  let sessionHash;
  const query = async (text, values = []) => {
    statements.push({ text, values });
    if (text.includes("insert into user_profiles")) {
      account = {
        id: "user-123",
        username: values[0],
        email: values[1],
        full_name: values[2],
        role: values[4],
        cash_balance: 0,
        coin_balance: 0,
        is_blocked: false,
        created_at: "2026-01-01T00:00:00.000Z",
        password_hash: values[3],
      };
      return { rows: [{ ...account }] };
    }
    if (text.includes("update user_profiles")) {
      account.username = values[0];
      account.email = values[0];
      account.password_hash = values[1];
      return { rows: [] };
    }
    if (text.includes("insert into user_sessions")) {
      sessionHash = values[0];
      return { rows: [] };
    }
    if (text.includes("select 1 from user_profiles where role = 'admin'")) {
      return { rows: [] };
    }
    if (text.includes("from user_sessions s join user_profiles")) {
      return { rows: account ? [{
        ...account,
        role,
        session_hash: sessionHash,
      }] : [] };
    }
    if (text.includes("select id, username, full_name, role, is_blocked, password_hash")) {
      return { rows: account ? [{ ...account, role }] : [] };
    }
    if (text.includes("select password_hash from user_profiles")) {
      return { rows: account ? [{ password_hash: account.password_hash }] : [] };
    }
    if (text.startsWith("select cash_per_coin")) return { rows: [{ cash_per_coin: 5 }] };
    if (text.startsWith("select id,cash_delta")) return { rows: [] };
    return { rows: [] };
  };
  const connection = {
    query,
    release() {},
  };
  return {
    statements,
    pool: { query, async connect() { return connection; } },
  };
}

function request(route, { method = "GET", body, cookie } = {}) {
  return new Request(`https://site.example/api/coin/${route}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("coin API reports missing Netlify Database configuration explicitly", async () => {
  const response = await handler(request("me"));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Netlify bazasi sozlanmagan/i);
});

test("email registration stores a password hash and an opaque server-side session", async () => {
  const database = createDatabase();
  const response = await handler(request("register", {
    method: "POST",
    body: {
      fullName: "Test User",
      email: "test@example.com",
      password: "securepass123",
      adminSetupKey: env.SUPERADMIN_SETUP_KEY,
    },
  }), { env, database });

  assert.equal(response.status, 201);
  assert.equal((await response.json()).user.role, "admin");
  const accountInsert = database.statements.find((entry) => entry.text.includes("insert into user_profiles"));
  assert.equal(accountInsert.values[0], "test@example.com");
  assert.equal(accountInsert.values[1], "test@example.com");
  assert.match(accountInsert.values[3], /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.notEqual(accountInsert.values[3], "securepass123");
  const sessionInsert = database.statements.find((entry) => entry.text.includes("insert into user_sessions"));
  assert.match(sessionInsert.values[0], /^[a-f0-9]{64}$/);
  assert.match(response.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
});

test("email registration without the setup key cannot claim superadmin", async () => {
  const database = createDatabase();
  const response = await handler(request("register", {
    method: "POST",
    body: { fullName: "Test User", email: "student@example.com", password: "securepass123" },
  }), { env, database });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).user.role, "student");
});

test("login accepts email and sets a secure session cookie", async () => {
  const database = createDatabase();
  await handler(request("register", {
    method: "POST",
    body: { fullName: "Test User", email: "test@example.com", password: "securepass123" },
  }), { env, database });

  const response = await handler(request("login", {
    method: "POST",
    body: { email: "TEST@example.com", password: "securepass123" },
  }), { env, database });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.username, "test@example.com");
  assert.match(response.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
});

test("incorrect login is rejected without creating a session", async () => {
  const database = createDatabase();
  await handler(request("register", {
    method: "POST",
    body: { fullName: "Test User", email: "test@example.com", password: "securepass123" },
  }), { env, database });
  const response = await handler(request("login", {
    method: "POST",
    body: { email: "test@example.com", password: "wrongpass123" },
  }), { env, database });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /noto‘g‘ri/i);
});

test("profile allows changing email and password only after current-password verification", async () => {
  const database = createDatabase();
  await handler(request("register", {
    method: "POST",
    body: { fullName: "Test User", email: "test@example.com", password: "securepass123" },
  }), { env, database });
  const login = await handler(request("login", {
    method: "POST",
    body: { email: "test@example.com", password: "securepass123" },
  }), { env, database });
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const response = await handler(request("profile/credentials", {
    method: "PATCH",
    cookie,
    body: { email: "new@example.com", currentPassword: "securepass123", newPassword: "anotherpass123" },
  }), { env, database });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).email, "new@example.com");
  assert.ok(database.statements.some((entry) => entry.text.includes("delete from user_sessions")));
});

test("students cannot change administrator reward orders", async () => {
  const database = createDatabase({ role: "student" });
  await handler(request("register", {
    method: "POST",
    body: { fullName: "Test User", email: "test@example.com", password: "securepass123" },
  }), { env, database });
  const login = await handler(request("login", {
    method: "POST",
    body: { email: "test@example.com", password: "securepass123" },
  }), { env, database });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const response = await handler(request("admin/reward-orders/00000000-0000-4000-8000-000000000123", {
    method: "PATCH",
    cookie,
    body: { status: "delivered" },
  }), { env, database });
  assert.equal(response.status, 403);
});

test("unauthenticated /me returns a message the client recognizes as an expired session", async () => {
  const response = await handler(request("me"), { env, database: createDatabase() });
  assert.equal(response.status, 401);
  const { error } = await response.json();
  assert.match(error, DEAD_SESSION_PATTERN);
});

test("the app's expired-session regex matches the API login error message", () => {
  const html = readFileSync(
    fileURLToPath(new URL("../ShamsAcademy.html", import.meta.url)),
    "utf8",
  );
  assert.match("Avval tizimga kiring.", DEAD_SESSION_PATTERN);
  const occurrences = html.match(/avval tizimga kiring\|sessiya tugagan\|Hisob ma’lumoti topilmadi/gi) || [];
  assert.ok(occurrences.length >= 2);
});

test("header login and registration buttons use the same primary style", () => {
  const html = readFileSync(
    fileURLToPath(new URL("../ShamsAcademy.html", import.meta.url)),
    "utf8",
  );
  assert.match(html, /class="btn sa-btn-primary btn-sm px-3" href="#\/Account\/Login"/);
  assert.match(html, /class="btn sa-btn-primary btn-sm px-3" href="#\/Account\/Register"/);
});

test("registration and profile forms use Netlify email auth without a remember-me checkbox", () => {
  const html = readFileSync(
    fileURLToPath(new URL("../ShamsAcademy.html", import.meta.url)),
    "utf8",
  );
  assert.match(html, /for="rgEmail">Email/);
  assert.match(html, /for="profileEmail">Email/);
  assert.match(html, /for="rgAdminKey">Superadmin sozlash kaliti/);
  assert.match(html, /SA\.saveCredentials\(\)/);
  assert.doesNotMatch(html, /id="lgRemember"/);
  const registrationHandler = html.match(/  register: async function \(\) \{([\s\S]*?)\n  \},\n  logout:/)?.[1];
  assert.ok(registrationHandler);
  assert.doesNotMatch(registrationHandler, /DB\.passwords\[uid\] = pass|DB\.users\.push/);
});
