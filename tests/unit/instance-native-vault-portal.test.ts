import { test } from "vitest";
import assert from "node:assert/strict";
import {
  InstanceNativeVaultPortal,
  type PortalRequest,
  type PortalResponse,
  type NativeService,
} from "../integration/helpers/instance-native-vault-portal.js";

const account = {
  accountEmail: "fixture@example.test",
  accountPassword: "synthetic-password",
};
const credentials = {
  PORTAL_MODEL_API_KEY: "madeup-model-secret",
  TELEGRAM_BOT_TOKEN: "123456:madeup-telegram-secret",
};
const service: NativeService = {
  name: "telegram",
  host: "api.telegram.org",
  auth: { type: "passthrough" },
  substitutions: [{
    key: "TELEGRAM_BOT_TOKEN",
    placeholder: "__telegram_token__",
    in: ["path"],
  }],
};

function response(
  body: unknown,
  headers: PortalResponse["headers"] = {},
  status = 200,
): PortalResponse {
  return { status, body, headers };
}

function fixture(replies: PortalResponse[]) {
  const requests: PortalRequest[] = [];
  const client = new InstanceNativeVaultPortal(async request => {
    requests.push(request);
    const next = replies.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  }, "synthetic-loader");
  return { client, requests };
}

function loginReply(headers: PortalResponse["headers"] = {
  "sEt-CoOkIe": [
    "unrelated=ignored; Path=/",
    "av_session=actual-session; Path=/; HttpOnly; SameSite=Strict",
  ],
}) {
  return response({
    token: "must-not-return-token",
    expires_at: "2030-01-01T00:00:00Z",
  }, headers);
}

const meReply = () => response({
  email: account.accountEmail,
  role: "owner",
  type: "user",
  is_owner: true,
});

test("uses fixed host, actual cookies, pinned bodies and public results", async () => {
  const { client, requests } = fixture([
    loginReply(), meReply(),
    response({ set: Object.keys(credentials), secret: "never-return" }),
    response({ vault: "lifemodel", upserted: [service.name], services_count: 1 }),
  ]);
  assert.deepEqual(await client.login(account), {
    email: account.accountEmail, role: "owner",
  });
  assert.deepEqual(await client.setCredentials(credentials), {
    set: ["PORTAL_MODEL_API_KEY", "TELEGRAM_BOT_TOKEN"],
  });
  assert.equal(await client.upsertServices([service]), undefined);
  assert.deepEqual(requests.map(r => [r.method, r.path, r.body]), [
    ["POST", "/v1/auth/login", {
      email: account.accountEmail, password: account.accountPassword,
    }],
    ["GET", "/v1/auth/me", undefined],
    ["POST", "/v1/credentials", { vault: "lifemodel", credentials }],
    ["POST", "/v1/vaults/lifemodel/services", { services: [service] }],
  ]);
  requests.forEach((r, index) => {
    assert.equal(r.host, "vault.localhost");
    assert.deepEqual(r.headers, {
      "Content-Type": "application/json",
      Cookie: "lm_session=synthetic-loader" +
        (index ? "; av_session=actual-session" : ""),
    });
    assert.ok(!Object.keys(r.headers).some(k => /authorization|csrf/i.test(k)));
  });
});

test("accepts a single Set-Cookie string", async () => {
  const { client, requests } = fixture([
    loginReply({ "SET-COOKIE": "av_session=single; Path=/" }), meReply(),
  ]);
  await client.login(account);
  assert.equal(requests[1].headers.Cookie,
    "lm_session=synthetic-loader; av_session=single");
});

test("refuses all mutation before verified authentication", async () => {
  const { client, requests } = fixture([]);
  await assert.rejects(client.setCredentials(credentials),
    /^Error: Vault portal status=0 path=\/v1\/credentials$/);
  await assert.rejects(client.upsertServices([service]),
    /^Error: Vault portal status=0 path=\/v1\/vaults\/lifemodel\/services$/);
  assert.equal(requests.length, 0);
});

test("missing or ambiguous account cookie fails closed", async () => {
  for (const headers of [
    {},
    { "Set-Cookie": "other=not-av-session" },
    { "Set-Cookie": ["av_session=one", "av_session=two"] },
  ]) {
    const { client, requests } = fixture([loginReply(headers)]);
    await assert.rejects(client.login(account),
      /^Error: Vault portal status=200 path=\/v1\/auth\/login$/);
    await assert.rejects(client.setCredentials(credentials));
    assert.equal(requests.length, 1);
  }
});

test("requires matching email and owner role", async () => {
  for (const body of [
    { email: "other@example.test", role: "owner" },
    { email: account.accountEmail, role: "member" },
    { error: "synthetic-password must-not-return-token" },
  ]) {
    const { client, requests } = fixture([loginReply(), response(body)]);
    await assert.rejects(client.login(account),
      /^Error: Vault portal status=200 path=\/v1\/auth\/me$/);
    await assert.rejects(client.upsertServices([service]));
    assert.equal(requests.length, 2);
  }
});

test("API rejection and malformed JSON never echo response secrets", async () => {
  for (const reply of [
    response("synthetic-password must-not-return-token", {}, 403),
    response("{synthetic-password must-not-return-token"),
  ]) {
    const { client } = fixture([reply]);
    await assert.rejects(client.login(account), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message,
        /^Vault portal status=(403|200) path=\/v1\/auth\/login$/);
      return true;
    });
  }
});

test("transport failures are sanitized", async () => {
  const client = new InstanceNativeVaultPortal(async () => {
    throw new Error("synthetic-password must-not-return-token");
  }, "synthetic-loader");
  await assert.rejects(client.login(account),
    /^Error: Vault portal status=0 path=\/v1\/auth\/login$/);
});

test("credential proof must contain exactly the expected keys", async () => {
  const { client } = fixture([
    loginReply(), meReply(),
    response({ set: ["TELEGRAM_BOT_TOKEN"], secret: "madeup-model-secret" }),
  ]);
  await client.login(account);
  await assert.rejects(client.setCredentials(credentials),
    /^Error: Vault portal status=200 path=\/v1\/credentials$/);
});

for (const status of [401, 403]) {
  test(`revokes authenticated state on ${status} until verified login`, async () => {
    const { client, requests } = fixture([
      loginReply(), meReply(), response({ error: "fixture-secret" }, {}, status),
      loginReply(), meReply(), response({ set: Object.keys(credentials) }),
    ]);
    await client.login(account);
    await assert.rejects(client.setCredentials(credentials), /Vault portal status=/);
    const before = requests.length;
    await assert.rejects(client.setCredentials(credentials));
    await assert.rejects(client.upsertServices([service]));
    assert.equal(requests.length, before);
    await client.login(account);
    assert.equal(requests[before].headers.Cookie, "lm_session=synthetic-loader");
    await client.setCredentials(credentials);
  });
}
