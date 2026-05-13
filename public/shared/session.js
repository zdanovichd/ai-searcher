const ACCESS_KEY = "ais_access_token";

export function getAccessToken() {
  return localStorage.getItem(ACCESS_KEY);
}

export function setAccessToken(token) {
  localStorage.setItem(ACCESS_KEY, token);
}

export function clearAccessToken() {
  localStorage.removeItem(ACCESS_KEY);
}

export async function refreshAccessToken() {
  const res = await fetch("/api/auth/refresh", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error("refresh_failed");
  const data = await res.json();
  if (data.accessToken) setAccessToken(data.accessToken);
  return data.accessToken;
}

export async function authFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res = await fetch(url, { ...options, headers, credentials: "include" });
  if (res.status === 401) {
    try {
      await refreshAccessToken();
      headers.Authorization = `Bearer ${getAccessToken()}`;
      res = await fetch(url, { ...options, headers, credentials: "include" });
    } catch {
      clearAccessToken();
      window.location.href = "/login";
      throw new Error("unauthorized");
    }
  }
  return res;
}

export async function requireAuthPage() {
  if (!getAccessToken()) {
    try {
      await refreshAccessToken();
    } catch {
      window.location.href = "/login";
      return null;
    }
  }
  return getAccessToken();
}

export async function logout() {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  clearAccessToken();
  window.location.href = "/login";
}
