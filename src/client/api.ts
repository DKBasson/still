export type AccountStatus = "pending" | "approved" | "rejected" | "suspended" | "banned";
export type Role = "user" | "moderator" | "admin";

export type Me = {
  id: string;
  email: string;
  emailVerified: boolean;
  username: string;
  bio: string;
  avatarUrl: string | null;
  accountStatus: AccountStatus;
  role: Role;
  statusReason: string | null;
  suspendedUntil: string | null;
};

export type Post = {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  width: number;
  height: number;
  likeCount: number;
  likedByMe: boolean;
  imageUrl: string;
  mine: boolean;
  author: { id: string; username: string; avatarUrl: string | null };
};

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  if (body && !(body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (method !== "GET" && method !== "HEAD") {
    headers.set("x-still-request", "1");
    if (body == null) {
      headers.set("content-type", "application/json");
      body = "{}";
    }
  }
  const response = await fetch(path, { ...init, method, headers, body, credentials: "include" });
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => ({}))) as {
    message?: string;
    code?: string;
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data.error?.code ?? data.code ?? "error",
      data.error?.message ?? data.message ?? "Something went wrong.",
    );
  }
  return data as T;
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "long", year: "numeric" }).format(new Date(value));
}
