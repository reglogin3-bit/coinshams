import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getDatabase } from "@netlify/database";

const API_PREFIX = "/api/coin";
const SESSION_COOKIE = "shams_coin_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const WEEKDAYS = new Set([0, 1, 2, 3, 4, 5, 6]);
const scrypt = promisify(scryptCallback);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function readCookie(request, name) {
  const cookies = request.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function setSessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function requiredConfig(env, database) {
  const connectionString = env.NETLIFY_DB_URL?.trim();
  if (!connectionString) {
    throw new ApiError(503, "Netlify bazasi sozlanmagan. Administrator Netlify sozlamalarini tekshirsin.");
  }
  return {
    db: database || getDatabase({ connectionString }),
    superadminSetupKey: env.SUPERADMIN_SETUP_KEY?.trim() || "",
  };
}

const TABLE_COLUMNS = {
  user_profiles: ["id", "username", "full_name", "email", "password_hash", "role", "cash_balance", "coin_balance", "is_blocked", "created_at"],
  user_sessions: ["session_hash", "user_id", "expires_at", "created_at"],
  coin_settings: ["id", "cash_per_coin", "attendance_cash", "attendance_coins", "auto_attendance_reward", "updated_at"],
  coin_rewards: ["id", "title", "description", "cost_coins", "icon", "is_active", "created_at"],
  reward_orders: ["id", "user_id", "reward_id", "coins_spent", "status", "created_at"],
  study_groups: ["id", "name", "description", "created_by", "created_at"],
  group_members: ["group_id", "user_id", "added_at"],
  group_schedules: ["id", "group_id", "subject", "day_of_week", "start_time", "time_zone", "interval_days", "anchor_date", "created_at"],
  group_sessions: ["id", "group_id", "schedule_id", "subject", "starts_at", "status", "marked_by", "completed_at", "created_at"],
  attendance: ["session_id", "user_id", "present", "marked_by", "marked_at"],
  wallet_transactions: ["id", "user_id", "cash_delta", "coin_delta", "description", "attendance_session_id", "created_at"],
};

function splitSelect(select) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < select.length; i += 1) {
    if (select[i] === "(") depth += 1;
    else if (select[i] === ")") depth -= 1;
    else if (select[i] === "," && depth === 0) {
      parts.push(select.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(select.slice(start));
  return parts;
}

function makeWhere(table, params) {
  const clauses = [];
  const values = [];
  for (const [key, raw] of params) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    if (!TABLE_COLUMNS[table].includes(key)) throw new ApiError(400, "So‘rov filtri noto‘g‘ri.");
    const separator = raw.indexOf(".");
    const operation = separator < 0 ? "eq" : raw.slice(0, separator);
    const value = separator < 0 ? raw : raw.slice(separator + 1);
    const normalizedValue = operation === "is" && value === "null"
      ? null
      : value;
    if (!["eq", "neq", "ilike", "is", "gt", "gte", "lt", "lte"].includes(operation)) {
      throw new ApiError(400, "So‘rov filtri qo‘llab-quvvatlanmaydi.");
    }
    if (operation === "is") {
      if (!["null", "true", "false"].includes(value)) throw new ApiError(400, "So‘rov filtri noto‘g‘ri.");
      clauses.push(`${key} is ${value}`);
      continue;
    }
    values.push(normalizedValue);
    const placeholder = `$${values.length}`;
    clauses.push(operation === "ilike"
      ? `lower(${key}) = lower(${placeholder})`
      : `${key} ${({ eq: "=", neq: "<>", is: "is", gt: ">", gte: ">=", lt: "<", lte: "<=" })[operation]} ${placeholder}`);
  }
  return { sql: clauses.length ? ` where ${clauses.join(" and ")}` : "", values };
}

function projection(table, select) {
  if (select === "*") return "*";
  if (table === "group_members" && select.includes("user_profiles(")) {
    return "group_id, user_id, added_at, (select json_build_object('id', p.id, 'full_name', p.full_name, 'role', p.role, 'cash_balance', p.cash_balance, 'coin_balance', p.coin_balance, 'email', coalesce(p.email, p.username)) from user_profiles p where p.id = group_members.user_id) as user_profiles";
  }
  if (table === "reward_orders" && select.includes("user_profiles(")) {
    return "id, user_id, coins_spent, status, created_at, (select json_build_object('full_name', p.full_name, 'email', coalesce(p.email, p.username)) from user_profiles p where p.id = reward_orders.user_id) as user_profiles, (select json_build_object('title', r.title) from coin_rewards r where r.id = reward_orders.reward_id) as coin_rewards";
  }
  if (table === "reward_orders" && select.includes("coin_rewards(")) {
    return "id, user_id, reward_id, coins_spent, status, created_at, (select json_build_object('title', r.title) from coin_rewards r where r.id = reward_orders.reward_id) as coin_rewards";
  }
  const columns = splitSelect(select);
  if (columns.some((column) => !TABLE_COLUMNS[table].includes(column))) {
    throw new ApiError(400, "So‘ralgan ustun qo‘llab-quvvatlanmaydi.");
  }
  return columns.join(", ");
}

async function dbRequest(config, path, { method = "GET", body, prefer } = {}) {
  const separator = path.indexOf("?");
  const resource = separator < 0 ? path : path.slice(0, separator);
  const params = new URLSearchParams(separator < 0 ? "" : path.slice(separator + 1));
  try {
    if (resource.startsWith("rpc/")) {
      const args = body || {};
      const calls = {
        exchange_user_balance: ["select * from exchange_user_balance($1, $2, $3)", [args.p_user_id, args.p_direction, args.p_amount]],
        redeem_coin_reward: ["select redeem_coin_reward($1, $2) as result", [args.p_user_id, args.p_reward_id]],
        update_reward_order_status: ["select update_reward_order_status($1, $2) as result", [args.p_order_id, args.p_status]],
        apply_manual_group_reward: ["select apply_manual_group_reward($1, $2, $3, $4, $5) as result", [args.p_group_id, args.p_cash_amount, args.p_coin_amount, args.p_user_ids, args.p_description]],
        submit_group_attendance: ["select submit_group_attendance($1, $2, $3::jsonb) as result", [args.p_session_id, args.p_marked_by, JSON.stringify(args.p_attendance)]],
      };
      const call = calls[resource.slice(4)];
      if (!call) throw new ApiError(404, "API amali topilmadi.");
      const result = await config.db.pool.query(call[0], call[1]);
      return resource.endsWith("exchange_user_balance") ? result.rows : result.rows[0]?.result;
    }
    const table = resource;
    if (!TABLE_COLUMNS[table]) throw new ApiError(404, "Jadval topilmadi.");
    const { sql: where, values } = makeWhere(table, params);
    if (method === "GET") {
      const order = params.get("order");
      const orderSql = order ? ` order by ${order.split(",").map((item) => {
        const [column, direction = "asc"] = item.split(".");
        if (!TABLE_COLUMNS[table].includes(column) || !["asc", "desc"].includes(direction)) {
          throw new ApiError(400, "Saralash so‘rovi noto‘g‘ri.");
        }
        return `${column} ${direction}`;
      }).join(", ")}` : "";
      const limit = params.get("limit");
      const offset = params.get("offset");
      const limitSql = limit ? ` limit ${Math.min(1000, Math.max(1, Number(limit)))}` : "";
      const offsetSql = offset ? ` offset ${Math.max(0, Number(offset))}` : "";
      const result = await config.db.pool.query(
        `select ${projection(table, params.get("select") || "*")} from ${table}${where}${orderSql}${limitSql}${offsetSql}`,
        values,
      );
      return result.rows;
    }
    if (method === "POST") {
      const entries = Object.entries(body || {});
      if (!entries.length || entries.some(([key]) => !TABLE_COLUMNS[table].includes(key))) {
        throw new ApiError(400, "Yozuv ma’lumotlari noto‘g‘ri.");
      }
      const columns = entries.map(([key]) => key);
      const result = await config.db.pool.query(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")})${prefer ? " returning *" : ""}`,
        entries.map(([, value]) => value),
      );
      return result.rows;
    }
    if (method === "PATCH") {
      const entries = Object.entries(body || {});
      if (!entries.length || entries.some(([key]) => !TABLE_COLUMNS[table].includes(key))) {
        throw new ApiError(400, "Yangilash ma’lumotlari noto‘g‘ri.");
      }
      const updateValues = entries.map(([, value]) => value);
      const shiftedWhere = where.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + updateValues.length}`);
      const result = await config.db.pool.query(
        `update ${table} set ${entries.map(([key], i) => `${key} = $${i + 1}`).join(", ")}${shiftedWhere}${prefer ? " returning *" : ""}`,
        [...updateValues, ...values],
      );
      return result.rows;
    }
    if (method === "DELETE") {
      await config.db.pool.query(`delete from ${table}${where}`, values);
      return [];
    }
    throw new ApiError(405, "So‘rov usuli qo‘llab-quvvatlanmaydi.");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.code === "23505") throw new ApiError(409, "Bu qiymat avval ro‘yxatdan o‘tgan.");
    if (error.code === "23503") throw new ApiError(400, "Bog‘langan ma’lumot topilmadi.");
    if (error.code === "23514" || error.code === "22P02" || error.code === "P0001") {
      throw new ApiError(400, error.message || "Yuborilgan ma’lumot noto‘g‘ri.");
    }
    console.error("Netlify Database query failed:", error);
    throw new ApiError(502, "Netlify bazasiga so‘rovni bajarib bo‘lmadi.");
  }
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

async function verifyPassword(password, encoded) {
  const [algorithm, saltHex, hashHex] = String(encoded || "").split(":");
  if (algorithm !== "scrypt" || !/^[a-f0-9]{32}$/i.test(saltHex || "") || !/^[a-f0-9]{128}$/i.test(hashHex || "")) {
    return false;
  }
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

async function createSession(config, userId) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();
  await config.db.pool.query(
    "insert into user_sessions (session_hash, user_id, expires_at) values ($1, $2, $3)",
    [hashToken(token), userId, expiresAt],
  );
  return token;
}

async function bodyJson(request) {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "So‘rov ma’lumoti noto‘g‘ri.");
  }
}

function requireString(value, label, maxLength = 160) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new ApiError(400, `${label} noto‘g‘ri.`);
  }
  return value.trim();
}

function requireAmount(value, label, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ApiError(400, `${label} musbat butun son bo‘lishi kerak.`);
  }
  return value;
}

async function authenticate(request, config) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) throw new ApiError(401, "Avval tizimga kiring.");
  const result = await config.db.pool.query(
    `select p.id, p.username, p.full_name, coalesce(p.email, p.username) as email,
      p.role, p.cash_balance, p.coin_balance, p.is_blocked, p.created_at
     from user_sessions s join user_profiles p on p.id = s.user_id
     where s.session_hash = $1 and s.expires_at > now()
     limit 1`,
    [hashToken(token)],
  );
  const profile = result.rows[0];
  if (!profile) throw new ApiError(401, "Sessiya tugagan. Qaytadan kiring.");
  if (profile.is_blocked) throw new ApiError(403, "Hisobingiz bloklangan.");

  return { profile, token };
}

function requireRole(user, roles) {
  if (!roles.includes(user.profile.role)) {
    throw new ApiError(403, "Bu amal uchun ruxsat yo‘q.");
  }
}

async function groupForUser(config, groupId, user) {
  const groups = await dbRequest(
    config,
    `study_groups?select=id,name,description,created_by,created_at&id=eq.${encodeURIComponent(groupId)}&limit=1`,
  );
  const group = groups?.[0];
  if (!group) throw new ApiError(404, "Guruh topilmadi.");
  if (user.profile.role === "admin") return group;
  if (user.profile.role !== "teacher" || group.created_by !== user.profile.id) {
    throw new ApiError(403, "Bu guruhni boshqarishga ruxsat yo‘q.");
  }
  return group;
}

async function groupMembers(config, groupId) {
  return dbRequest(
    config,
    `group_members?select=user_id,added_at,user_profiles(id,full_name,role,cash_balance,coin_balance,email)&group_id=eq.${encodeURIComponent(groupId)}&order=added_at.asc`,
  );
}

async function routeApi(request, config, route) {
  const url = new URL(request.url);
  const method = request.method;

  if (route === "register" && method === "POST") {
    const body = await bodyJson(request);
    const fullName = requireString(body.fullName, "Ism-familiya");
    if (fullName.split(/\s+/).filter(Boolean).length < 2) {
      throw new ApiError(400, "Haqiqiy ism va familiyangizni kiriting.");
    }
    const email = requireString(body.email || body.username, "Email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError(400, "Email formati noto‘g‘ri.");
    }
    const username = email;
    const password = requireString(body.password, "Parol", 256);
    if (password.length < 8 || !/[0-9]/.test(password)) {
      throw new ApiError(400, "Parol kamida 8 belgi va bitta raqamdan iborat bo‘lsin.");
    }
    const setupKey = typeof body.adminSetupKey === "string" ? body.adminSetupKey : "";
    const requestAdmin = !!config.superadminSetupKey && setupKey.length > 0 &&
      timingSafeEqual(
        createHash("sha256").update(setupKey).digest(),
        createHash("sha256").update(config.superadminSetupKey).digest(),
      );
    const connection = await config.db.pool.connect();
    let profile;
    try {
      await connection.query("begin");
      let role = "student";
      if (requestAdmin) {
        await connection.query("lock table user_profiles in exclusive mode");
        const { rows } = await connection.query("select 1 from user_profiles where role = 'admin' limit 1");
        if (rows.length) throw new ApiError(409, "Superadmin allaqachon sozlangan.");
        role = "admin";
      } else if (setupKey) {
        throw new ApiError(403, "Superadmin sozlash kaliti noto‘g‘ri.");
      }
      const inserted = await connection.query(
        `insert into user_profiles (username, email, full_name, password_hash, role)
         values ($1, $2, $3, $4, $5)
         returning id, username, full_name, email, role, cash_balance, coin_balance, is_blocked, created_at`,
        [username, email, fullName, await hashPassword(password), role],
      );
      profile = inserted.rows[0];
      await connection.query("commit");
    } catch (error) {
      await connection.query("rollback");
      if (error instanceof ApiError) throw error;
      if (error.code === "23505") throw new ApiError(409, "Bu email allaqachon ro‘yxatdan o‘tgan.");
      throw error;
    } finally {
      connection.release();
    }
    const token = await createSession(config, profile.id);
    return json(
      { message: "Hisob yaratildi.", user: profile },
      201,
      { "set-cookie": setSessionCookie(token) },
    );
  }

  if (route === "login" && method === "POST") {
    const body = await bodyJson(request);
    const email = requireString(body.email || body.username, "Email", 254).toLowerCase();
    const password = requireString(body.password, "Parol", 256);
    const identifier = email;
    const result = await config.db.pool.query(
      `select id, username, full_name, role, is_blocked, password_hash
       from user_profiles
       where lower(username) = $1 or lower(email) = $1
       limit 1`,
      [identifier],
    );
    const profile = result.rows[0];
    if (!profile || !(await verifyPassword(password, profile.password_hash))) {
      throw new ApiError(401, "Email yoki parol noto‘g‘ri.");
    }
    if (profile.is_blocked) throw new ApiError(403, "Hisobingiz bloklangan.");
    const token = await createSession(config, profile.id);
    return json(
      { message: "Tizimga kirdingiz.", user: { ...profile, password_hash: undefined } },
      200,
      { "set-cookie": setSessionCookie(token) },
    );
  }

  if (route === "logout" && method === "POST") {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) {
      await config.db.pool.query("delete from user_sessions where session_hash = $1", [hashToken(token)]);
    }
    return json({ message: "Tizimdan chiqdingiz." }, 200, { "set-cookie": clearSessionCookie() });
  }

  const user = await authenticate(request, config);
  const headers = {
    "cache-control": "no-store",
  };

  if (route === "me" && method === "GET") {
    const settings = await dbRequest(config, "coin_settings?select=cash_per_coin,attendance_cash,attendance_coins,auto_attendance_reward&id=eq.true&limit=1");
    const transactions = await dbRequest(config, `wallet_transactions?select=id,cash_delta,coin_delta,description,created_at&user_id=eq.${encodeURIComponent(user.profile.id)}&order=created_at.desc&limit=100`);
    return json({ user: user.profile, settings: settings?.[0] || null, transactions: transactions || [] }, 200, headers);
  }

  if (route === "profile/credentials" && method === "PATCH") {
    const body = await bodyJson(request);
    const email = requireString(body.email || body.username, "Email", 254).toLowerCase();
    const currentPassword = requireString(body.currentPassword, "Amaldagi parol", 256);
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "Email formati noto‘g‘ri.");
    if (newPassword && (newPassword.length < 8 || !/[0-9]/.test(newPassword))) {
      throw new ApiError(400, "Yangi parol kamida 8 belgi va bitta raqamdan iborat bo‘lsin.");
    }
    const { rows } = await config.db.pool.query(
      "select password_hash from user_profiles where id = $1",
      [user.profile.id],
    );
    if (!rows[0] || !(await verifyPassword(currentPassword, rows[0].password_hash))) {
      throw new ApiError(401, "Amaldagi parol noto‘g‘ri.");
    }
    try {
      await config.db.pool.query(
        `update user_profiles
         set username = $1, email = $1, password_hash = $2
         where id = $3`,
        [email, newPassword ? await hashPassword(newPassword) : rows[0].password_hash, user.profile.id],
      );
    } catch (error) {
      if (error.code === "23505") throw new ApiError(409, "Bu email allaqachon ro‘yxatdan o‘tgan.");
      throw error;
    }
    if (newPassword) {
      await config.db.pool.query(
        "delete from user_sessions where user_id = $1 and session_hash <> $2",
        [user.profile.id, hashToken(user.token)],
      );
    }
    return json({ message: "Profil ma’lumotlari yangilandi.", email }, 200, headers);
  }

  if (route === "wallet/exchange" && method === "POST") {
    const body = await bodyJson(request);
    const direction = body.direction;
    if (!["cash_to_coin", "coin_to_cash"].includes(direction)) {
      throw new ApiError(400, "Ayrboshlash yo‘nalishi noto‘g‘ri.");
    }
    const amount = requireAmount(body.amount, "Miqdor");
    const result = await dbRequest(config, "rpc/exchange_user_balance", {
      method: "POST",
      body: { p_user_id: user.profile.id, p_direction: direction, p_amount: amount },
    });
    return json({ result }, 200, headers);
  }

  if (route === "rewards" && method === "GET") {
    const rewards = await dbRequest(config, "coin_rewards?select=id,title,description,cost_coins,icon,is_active,created_at&is_active=eq.true&order=cost_coins.asc");
    const orders = await dbRequest(config, `reward_orders?select=id,reward_id,coins_spent,status,created_at,coin_rewards(title)&user_id=eq.${encodeURIComponent(user.profile.id)}&order=created_at.desc&limit=100`);
    return json({ rewards: rewards || [], orders: orders || [] }, 200, headers);
  }

  if (route === "rewards/redeem" && method === "POST") {
    const body = await bodyJson(request);
    const rewardId = requireAmount(body.rewardId, "Mukofot");
    const order = await dbRequest(config, "rpc/redeem_coin_reward", {
      method: "POST",
      body: { p_user_id: user.profile.id, p_reward_id: rewardId },
    });
    return json({ orderId: order }, 201, headers);
  }

  if (route === "admin/rewards" && method === "GET") {
    requireRole(user, ["admin"]);
    return json(await dbRequest(config, "coin_rewards?select=*&order=cost_coins.asc"), 200, headers);
  }

  if (route === "admin/rewards" && method === "POST") {
    requireRole(user, ["admin"]);
    const body = await bodyJson(request);
    const result = await dbRequest(config, "coin_rewards", {
      method: "POST",
      body: {
        title: requireString(body.title, "Mukofot nomi"),
        description: typeof body.description === "string" ? body.description.trim().slice(0, 500) : "",
        cost_coins: requireAmount(body.costCoins, "Koin narxi"),
        icon: typeof body.icon === "string" && /^bi-[a-z0-9-]{2,50}$/.test(body.icon) ? body.icon : "bi-gift",
        is_active: true,
      },
      prefer: "return=representation",
    });
    return json(result?.[0] || {}, 201, headers);
  }

  if (route === "admin/reward-orders" && method === "GET") {
    requireRole(user, ["admin"]);
    const orders = await dbRequest(config, "reward_orders?select=id,user_id,coins_spent,status,created_at,user_profiles(full_name,email),coin_rewards(title)&order=created_at.desc&limit=500");
    return json(orders || [], 200, headers);
  }

  const adminOrderMatch = route.match(/^admin\/reward-orders\/([0-9a-f-]+)$/i);
  if (adminOrderMatch && method === "PATCH") {
    requireRole(user, ["admin"]);
    const body = await bodyJson(request);
    if (!["delivered", "cancelled"].includes(body.status)) {
      throw new ApiError(400, "Buyurtma holati noto‘g‘ri.");
    }
    const result = await dbRequest(config, `rpc/update_reward_order_status`, {
      method: "POST",
      body: { p_order_id: adminOrderMatch[1], p_status: body.status },
    });
    return json({ orderId: result }, 200, headers);
  }

  const adminRewardMatch = route.match(/^admin\/rewards\/(\d+)$/);
  if (adminRewardMatch && method === "PATCH") {
    requireRole(user, ["admin"]);
    const body = await bodyJson(request);
    const patch = {};
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== "boolean") throw new ApiError(400, "Mukofot holati noto‘g‘ri.");
      patch.is_active = body.isActive;
    }
    if (body.title !== undefined) patch.title = requireString(body.title, "Mukofot nomi");
    if (body.description !== undefined) patch.description = String(body.description).trim().slice(0, 500);
    if (body.costCoins !== undefined) patch.cost_coins = requireAmount(body.costCoins, "Koin narxi");
    const rows = await dbRequest(config, `coin_rewards?id=eq.${adminRewardMatch[1]}`, {
      method: "PATCH", body: patch, prefer: "return=representation",
    });
    if (!rows?.length) throw new ApiError(404, "Mukofot topilmadi.");
    return json(rows[0], 200, headers);
  }

  if (route === "admin/settings" && method === "GET") {
    requireRole(user, ["admin"]);
    const rows = await dbRequest(config, "coin_settings?select=*&id=eq.true&limit=1");
    return json(rows?.[0] || {}, 200, headers);
  }

  if (route === "admin/settings" && method === "PATCH") {
    requireRole(user, ["admin"]);
    const body = await bodyJson(request);
    const patch = {
      updated_at: new Date().toISOString(),
    };
    if (body.cashPerCoin !== undefined) patch.cash_per_coin = requireAmount(body.cashPerCoin, "Ayrboshlash kursi");
    if (body.attendanceCash !== undefined) patch.attendance_cash = requireAmount(body.attendanceCash, "Davomat cash miqdori", { allowZero: true });
    if (body.attendanceCoins !== undefined) patch.attendance_coins = requireAmount(body.attendanceCoins, "Davomat koin miqdori", { allowZero: true });
    if (body.autoAttendanceReward !== undefined) {
      if (typeof body.autoAttendanceReward !== "boolean") throw new ApiError(400, "Avtomatik mukofot sozlamasi noto‘g‘ri.");
      patch.auto_attendance_reward = body.autoAttendanceReward;
    }
    const rows = await dbRequest(config, "coin_settings?id=eq.true", {
      method: "PATCH", body: patch, prefer: "return=representation",
    });
    return json(rows?.[0] || {}, 200, headers);
  }

  if (route === "admin/teachers" && method === "GET") {
    requireRole(user, ["admin"]);
    const teachers = await dbRequest(config, "user_profiles?select=id,full_name,email,role,created_at&role=eq.teacher&order=created_at.desc");
    return json(teachers || [], 200, headers);
  }

  if (route === "admin/teachers" && method === "POST") {
    requireRole(user, ["admin"]);
    const body = await bodyJson(request);
    const username = requireString(body.email || body.username, "Email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) throw new ApiError(400, "Email formati noto‘g‘ri.");
    const matches = await dbRequest(
      config,
      `user_profiles?select=id,full_name,email,username&username=ilike.${encodeURIComponent(username)}&limit=1`,
    );
    const candidate = matches?.[0];
    if (!candidate) throw new ApiError(404, "Bu email bilan foydalanuvchi topilmadi. Avval ro‘yxatdan o‘tsin.");
    const rows = await dbRequest(config, `user_profiles?id=eq.${encodeURIComponent(candidate.id)}`, {
      method: "PATCH", body: { role: "teacher" }, prefer: "return=representation",
    });
    return json(rows?.[0] || {}, 200, headers);
  }

  if (route === "admin/teachers" && method === "DELETE") {
    requireRole(user, ["admin"]);
    const id = url.searchParams.get("userId");
    if (!id || id === user.profile.id) throw new ApiError(400, "O‘qituvchi hisobi noto‘g‘ri.");
    await dbRequest(config, `user_profiles?id=eq.${encodeURIComponent(id)}&role=eq.teacher`, {
      method: "PATCH", body: { role: "student" }, prefer: "return=representation",
    });
    return json({ message: "O‘qituvchi roli olib tashlandi." }, 200, headers);
  }

  if (route === "admin/users" && method === "GET") {
    requireRole(user, ["admin"]);
    const users = await dbRequest(config, "user_profiles?select=id,full_name,email,role,cash_balance,coin_balance,is_blocked,created_at&order=created_at.desc&limit=500");
    return json(users || [], 200, headers);
  }

  if (route === "groups" && method === "GET") {
    requireRole(user, ["admin", "teacher"]);
    const query = user.profile.role === "admin"
      ? "study_groups?select=*&order=created_at.desc"
      : `study_groups?select=*&created_by=eq.${encodeURIComponent(user.profile.id)}&order=created_at.desc`;
    return json(await dbRequest(config, query), 200, headers);
  }

  if (route === "groups" && method === "POST") {
    requireRole(user, ["admin", "teacher"]);
    const body = await bodyJson(request);
    const group = {
      name: requireString(body.name, "Guruh nomi"),
      description: typeof body.description === "string" ? body.description.trim().slice(0, 500) : "",
      created_by: user.profile.id,
    };
    const result = await dbRequest(config, "study_groups", {
      method: "POST", body: group, prefer: "return=representation",
    });
    return json(result?.[0] || {}, 201, headers);
  }

  const groupMatch = route.match(/^groups\/([^/]+)(?:\/(members|candidates|schedules|sessions|reward))?$/);
  if (groupMatch) {
    requireRole(user, ["admin", "teacher"]);
    const groupId = groupMatch[1];
    await groupForUser(config, groupId, user);
    const action = groupMatch[2] || "";

    if (action === "members" && method === "GET") {
      return json(await groupMembers(config, groupId), 200, headers);
    }
    if (action === "members" && method === "POST") {
      const body = await bodyJson(request);
      const userId = requireString(body.userId, "Foydalanuvchi");
      const rows = await dbRequest(config, "user_profiles?select=id&order=created_at.desc&limit=1000");
      if (!rows?.some((profile) => profile.id === userId)) throw new ApiError(404, "Foydalanuvchi topilmadi.");
      const result = await dbRequest(config, "group_members", {
        method: "POST", body: { group_id: groupId, user_id: userId }, prefer: "return=representation",
      });
      return json(result?.[0] || {}, 201, headers);
    }
    if (action === "members" && method === "DELETE") {
      const userId = url.searchParams.get("userId");
      if (!userId) throw new ApiError(400, "Foydalanuvchi ko‘rsatilmagan.");
      await dbRequest(config, `group_members?group_id=eq.${encodeURIComponent(groupId)}&user_id=eq.${encodeURIComponent(userId)}`, { method: "DELETE" });
      return json({ message: "Guruh a’zosi olib tashlandi." }, 200, headers);
    }
    if (action === "candidates" && method === "GET") {
      const members = await dbRequest(config, `group_members?select=user_id&group_id=eq.${encodeURIComponent(groupId)}`);
      const existingIds = new Set((members || []).map((member) => member.user_id));
      const candidates = await dbRequest(config, "user_profiles?select=id,full_name,email&role=eq.student&is_blocked=eq.false&order=full_name.asc&limit=1000");
      return json((candidates || []).filter((candidate) => !existingIds.has(candidate.id)), 200, headers);
    }
    if (action === "schedules" && method === "GET") {
      return json(await dbRequest(config, `group_schedules?select=*&group_id=eq.${encodeURIComponent(groupId)}&order=day_of_week,start_time`), 200, headers);
    }
    if (action === "schedules" && method === "POST") {
      const body = await bodyJson(request);
      const day = body.dayOfWeek;
      if (!WEEKDAYS.has(day)) throw new ApiError(400, "Hafta kuni noto‘g‘ri.");
      if (typeof body.startTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.startTime)) {
        throw new ApiError(400, "Mashg‘ulot vaqti noto‘g‘ri.");
      }
      const intervalDays = body.intervalDays;
      if (![1, 2, 7, 14].includes(intervalDays)) throw new ApiError(400, "Takrorlanish oralig‘i noto‘g‘ri.");
      const result = await dbRequest(config, "group_schedules", {
        method: "POST",
        body: {
          group_id: groupId,
          subject: requireString(body.subject, "Fan nomi"),
          day_of_week: day,
          start_time: body.startTime,
          time_zone: "Asia/Tashkent",
          interval_days: intervalDays,
          anchor_date: requireString(body.anchorDate, "Boshlanish sanasi"),
        },
        prefer: "return=representation",
      });
      return json(result?.[0] || {}, 201, headers);
    }
    if (action === "schedules" && method === "DELETE") {
      const scheduleId = url.searchParams.get("scheduleId");
      if (!scheduleId) throw new ApiError(400, "Jadval yozuvi ko‘rsatilmagan.");
      await dbRequest(config, `group_schedules?id=eq.${encodeURIComponent(scheduleId)}&group_id=eq.${encodeURIComponent(groupId)}`, { method: "DELETE" });
      return json({ message: "Jadval yozuvi o‘chirildi." }, 200, headers);
    }
    if (action === "sessions" && method === "GET") {
      return json(await dbRequest(config, `group_sessions?select=*&group_id=eq.${encodeURIComponent(groupId)}&order=starts_at.desc&limit=100`), 200, headers);
    }
    if (action === "sessions" && method === "POST") {
      const body = await bodyJson(request);
      const scheduleId = requireString(body.scheduleId, "Jadval");
      const sessionDate = requireString(body.sessionDate, "Mashg‘ulot sanasi");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
        throw new ApiError(400, "Mashg‘ulot sanasi noto‘g‘ri.");
      }
      const schedules = await dbRequest(
        config,
        `group_schedules?select=id,group_id,subject,day_of_week,start_time,interval_days,anchor_date&id=eq.${encodeURIComponent(scheduleId)}&group_id=eq.${encodeURIComponent(groupId)}&limit=1`,
      );
      const schedule = schedules?.[0];
      if (!schedule) throw new ApiError(404, "Tanlangan jadval topilmadi.");
      const occurrence = new Date(`${sessionDate}T00:00:00Z`);
      const anchor = new Date(`${schedule.anchor_date}T00:00:00Z`);
      const dayDifference = Math.floor((occurrence.getTime() - anchor.getTime()) / 86_400_000);
      if (Number.isNaN(occurrence.getTime()) || dayDifference < 0 ||
          dayDifference % Number(schedule.interval_days) !== 0 ||
          ([7, 14].includes(Number(schedule.interval_days)) &&
           occurrence.getUTCDay() !== Number(schedule.day_of_week))) {
        throw new ApiError(400, "Tanlangan sana ushbu guruh jadvaliga mos kelmaydi.");
      }
      const result = await dbRequest(config, "group_sessions", {
        method: "POST",
        body: {
          group_id: groupId,
          schedule_id: schedule.id,
          subject: schedule.subject,
          starts_at: `${sessionDate}T${schedule.start_time}+05:00`,
        },
        prefer: "return=representation",
      });
      return json(result?.[0] || {}, 201, headers);
    }
    if (action === "reward" && method === "POST") {
      const body = await bodyJson(request);
      if (!Array.isArray(body.userIds) || body.userIds.some((id) => typeof id !== "string")) {
        throw new ApiError(400, "Mukofot oluvchilar ro‘yxati noto‘g‘ri.");
      }
      const result = await dbRequest(config, "rpc/apply_manual_group_reward", {
        method: "POST",
        body: {
          p_group_id: groupId,
          p_cash_amount: requireAmount(body.cashAmount, "Cash miqdori", { allowZero: true }),
          p_coin_amount: requireAmount(body.coinAmount, "Koin miqdori", { allowZero: true }),
          p_user_ids: body.userIds.length ? body.userIds : null,
          p_description: requireString(body.description || "Guruhga qo‘lda mukofot berildi", "Izoh"),
        },
      });
      return json({ updatedUsers: result }, 200, headers);
    }

    if (!action && method === "GET") {
      return json({
        group: await groupForUser(config, groupId, user),
        members: await groupMembers(config, groupId),
        schedules: await dbRequest(config, `group_schedules?select=*&group_id=eq.${encodeURIComponent(groupId)}&order=day_of_week,start_time`),
        sessions: await dbRequest(config, `group_sessions?select=*&group_id=eq.${encodeURIComponent(groupId)}&order=starts_at.desc&limit=100`),
      }, 200, headers);
    }
  }

  const attendanceMatch = route.match(/^sessions\/([^/]+)\/attendance$/);
  if (attendanceMatch && method === "POST") {
    requireRole(user, ["admin", "teacher"]);
    const sessionId = attendanceMatch[1];
    const sessions = await dbRequest(config, `group_sessions?select=id,group_id&id=eq.${encodeURIComponent(sessionId)}&limit=1`);
    if (!sessions?.[0]) throw new ApiError(404, "Mashg‘ulot topilmadi.");
    await groupForUser(config, sessions[0].group_id, user);
    const body = await bodyJson(request);
    if (!Array.isArray(body.attendance) || body.attendance.length === 0) {
      throw new ApiError(400, "Davomat ro‘yxati bo‘sh.");
    }
    const result = await dbRequest(config, "rpc/submit_group_attendance", {
      method: "POST",
      body: {
        p_session_id: sessionId,
        p_marked_by: user.profile.id,
        p_attendance: body.attendance,
      },
    });
    return json({ result }, 200, headers);
  }

  throw new ApiError(404, "API manzili topilmadi.");
}

export async function handler(request, { env = process.env, database } = {}) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!["GET", "POST", "PATCH", "DELETE"].includes(request.method)) {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, POST, PATCH, DELETE" },
    });
  }
  try {
    const config = requiredConfig(env, database);
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    const route = path.startsWith(`${API_PREFIX}/`) ? path.slice(API_PREFIX.length + 1) : "";
    return await routeApi(request, config, route);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    console.error("Unexpected coin API error:", error);
    return json({ error: "Kutilmagan server xatosi." }, 500);
  }
}

export default handler;

export const config = {
  path: "/api/coin/*",
  method: ["GET", "POST", "PATCH", "DELETE"],
};
