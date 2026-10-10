export const VAULT_HOST = "vault.localhost" as const;

export interface PortalRequest {
  host: typeof VAULT_HOST;
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  headers: Record<string, string>;
}

export interface PortalResponse {
  status: number;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export type PortalTransport =
  (request: PortalRequest) => Promise<PortalResponse>;

export interface PublicPortalAccount {
  accountEmail: string;
  accountPassword: string;
}

export type NativeService = Record<string, unknown> & {
  name: string;
  host: string;
  auth: Record<string, unknown>;
};

export interface PortalIdentity {
  email: string;
  role: "owner";
}

const cookieValue = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;

function failure(status: number, path: string): Error {
  return new Error(`Vault portal status=${status} path=${path}`);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(response: PortalResponse, path: string): Record<string, unknown> {
  let value = response.body;
  try {
    if (typeof value === "string") value = JSON.parse(value);
  } catch {
    throw failure(response.status, path);
  }
  if (!object(value)) throw failure(response.status, path);
  return value;
}

function sessionCookie(response: PortalResponse, path: string): string {
  const values: string[] = [];
  for (const [name, value] of Object.entries(response.headers)) {
    if (name.toLowerCase() !== "set-cookie" || value === undefined) continue;
    values.push(...(Array.isArray(value) ? value : [value]));
  }
  const sessions = values
    .map(value => /^av_session=([^;]*)(?:;|$)/.exec(value.trim()))
    .filter((match): match is RegExpExecArray => match !== null);
  if (sessions.length !== 1 || !cookieValue.test(sessions[0][1])) {
    throw failure(response.status, path);
  }
  return sessions[0][1];
}

// lmSession is the synthetic loader cookie VALUE, not a Cookie header.
// The transport must honor this DTO without redirects, ambient cookies,
// automatic retries, authentication headers, or response/request logging.
export class InstanceNativeVaultPortal {
  private avSession: string | undefined;
  private authenticated = false;

  constructor(
    private readonly transport: PortalTransport,
    private readonly lmSession: string,
  ) {
    if (!cookieValue.test(lmSession)) throw failure(0, "/v1/auth/login");
  }

  private async request(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<PortalResponse> {
    const cookie = `lm_session=${this.lmSession}` +
      (this.avSession ? `; av_session=${this.avSession}` : "");
    let response: PortalResponse;
    try {
      response = await this.transport({
        host: VAULT_HOST,
        path,
        method,
        body,
        headers: { "Content-Type": "application/json", Cookie: cookie },
      });
    } catch {
      throw failure(0, path);
    }
    if (!Number.isInteger(response.status) ||
        response.status < 200 || response.status >= 300) {
      if (response.status === 401 || response.status === 403) {
        this.authenticated = false;
        this.avSession = undefined;
      }
      throw failure(Number.isInteger(response.status) ? response.status : 0, path);
    }
    return response;
  }

  async login(account: PublicPortalAccount): Promise<PortalIdentity> {
    this.authenticated = false;
    this.avSession = undefined;
    try {
      const path = "/v1/auth/login";
      const response = await this.request(path, "POST", {
        email: account.accountEmail,
        password: account.accountPassword,
      });
      json(response, path); // Never return or retain the login token body.
      this.avSession = sessionCookie(response, path);
      const mePath = "/v1/auth/me";
      const me = json(await this.request(mePath, "GET"), mePath);
      if (me.email !== account.accountEmail || me.role !== "owner") {
        throw failure(200, mePath);
      }
      this.authenticated = true;
      return { email: account.accountEmail, role: "owner" };
    } catch (error) {
      this.avSession = undefined;
      throw error;
    }
  }

  async setCredentials(
    credentials: { PORTAL_MODEL_API_KEY: string; TELEGRAM_BOT_TOKEN: string },
  ): Promise<{ set: string[] }> {
    const path = "/v1/credentials";
    if (!this.authenticated) throw failure(0, path);
    const result = json(await this.request(path, "POST", {
      vault: "lifemodel", credentials,
    }), path);
    const expected = ["PORTAL_MODEL_API_KEY", "TELEGRAM_BOT_TOKEN"];
    if (!Array.isArray(result.set) || result.set.length !== expected.length ||
        !expected.every(key => (result.set as unknown[]).includes(key))) {
      throw failure(200, path);
    }
    return { set: [...expected] };
  }

  async upsertServices(services: NativeService[]): Promise<void> {
    const path = "/v1/vaults/lifemodel/services";
    if (!this.authenticated) throw failure(0, path);
    json(await this.request(path, "POST", { services }), path);
  }
}
