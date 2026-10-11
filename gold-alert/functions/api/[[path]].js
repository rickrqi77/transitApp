/**
 * Proxy /api/* from alertdata.pages.dev to the gold-alert Worker.
 */
const WORKER_ORIGIN = "https://gold-alert.rick-rqi-apple.workers.dev";

export async function onRequest(context) {
  const incoming = context.request;
  const src = new URL(incoming.url);
  const dest = WORKER_ORIGIN + src.pathname + src.search;

  const headers = new Headers(incoming.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", src.host);

  const init = {
    method: incoming.method,
    headers,
    redirect: "follow",
  };

  if (incoming.method !== "GET" && incoming.method !== "HEAD") {
    init.body = incoming.body;
  }

  return fetch(dest, init);
}
