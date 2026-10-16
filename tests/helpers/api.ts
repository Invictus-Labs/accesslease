/**
 * Minimal HTTP client for the AccessLease API with cookie + CSRF handling. The transport is pluggable so the same
 * assertions run in-process (Fastify `inject`, real routes, real database) and over a real socket against a spawned server.
 */
export interface ApiResponse {
  status: number;
  body: any;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
}

export interface TransportRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string | Buffer;
}

export type Transport = (request: TransportRequest) => Promise<ApiResponse>;

export interface InjectableApp {
  inject(options: { method: any; url: string; headers?: Record<string, string>; payload?: any }): Promise<{ statusCode: number; body: string; headers: Record<string, any> }>;
}

export function injectTransport(app: InjectableApp): Transport {
  return async ({ method, path, headers, body }) => {
    const res = await app.inject({ method, url: path, headers, payload: body });
    return { status: res.statusCode, body: parse(res.body), headers: res.headers, raw: res.body };
  };
}

export function fetchTransport(baseUrl: string): Transport {
  return async ({ method, path, headers, body }) => {
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body as any, redirect: "manual" });
    const raw = await res.text();
    const out: Record<string, string | string[]> = {};
    res.headers.forEach((value, key) => {
      out[key] = value;
    });
    const setCookie = (res.headers as any).getSetCookie?.() as string[] | undefined;
    if (setCookie && setCookie.length > 0) out["set-cookie"] = setCookie;
    return { status: res.status, body: parse(raw), headers: out, raw };
  };
}

function parse(raw: string): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export interface Session {
  email: string;
  cookie: string;
  csrf: string;
  workspaceId?: string;
}

export interface CallOptions {
  /** Override the CSRF token (null omits the header entirely). */
  csrf?: string | null;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  /** Send a raw string body instead of JSON-encoding `body`. */
  rawBody?: string | Buffer;
  contentType?: string;
}

export class ApiClient {
  constructor(
    private readonly transport: Transport,
    private readonly prefix = "/api/v1",
  ) {}

  async call(session: Session | null, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, options: CallOptions = {}): Promise<ApiResponse> {
    const headers: Record<string, string> = { ...options.headers };
    if (session) headers.cookie = session.cookie;
    const csrf = options.csrf === undefined ? session?.csrf : options.csrf;
    if (csrf && method !== "GET") headers["x-csrf-token"] = csrf;
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    let payload: string | Buffer | undefined;
    if (options.rawBody !== undefined) {
      payload = options.rawBody;
      headers["content-type"] = options.contentType ?? "application/json";
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    return this.transport({ method, path: `${this.prefix}${path}`, headers, body: payload });
  }

  async login(email: string, password: string, workspaceId?: string): Promise<Session> {
    const res = await this.call(null, "POST", "/auth/login", { email, password, ...(workspaceId ? { workspace_id: workspaceId } : {}) });
    if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${res.raw.slice(0, 200)}`);
    const setCookie = res.headers["set-cookie"];
    const cookieLine = (Array.isArray(setCookie) ? setCookie : [String(setCookie ?? "")]).find((c) => c.startsWith("accesslease_session="));
    if (!cookieLine) throw new Error("login response carried no accesslease_session cookie");
    return { email, cookie: cookieLine.split(";")[0]!, csrf: res.body.csrf_token, workspaceId };
  }

  get = (session: Session | null, path: string, options?: CallOptions) => this.call(session, "GET", path, undefined, options);
  post = (session: Session | null, path: string, body?: unknown, options?: CallOptions) => this.call(session, "POST", path, body ?? {}, options);
  put = (session: Session | null, path: string, body?: unknown, options?: CallOptions) => this.call(session, "PUT", path, body ?? {}, options);
}
