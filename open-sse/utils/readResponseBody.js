// Read an upstream body while the pre-response deadline is still active.
// Own the reader so cancellation also releases mocked/non-cooperating bodies;
// Promise.race alone would leave their locked reader and success callbacks alive.
export async function readResponseBody(response, requestDeadline, format = "text") {
  if (!requestDeadline || !response.body?.getReader) {
    const read = () => response[format]();
    return requestDeadline ? requestDeadline.run(read) : read();
  }
  requestDeadline.throwIfAborted();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const onAbort = () => {
    try { Promise.resolve(reader.cancel(requestDeadline.signal.reason)).catch(() => {}); } catch { /* best effort */ }
  };
  requestDeadline.signal.addEventListener("abort", onAbort, { once: true });
  if (requestDeadline.signal.aborted) onAbort();
  try {
    while (true) {
      const { done, value } = await requestDeadline.run(() => reader.read());
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    requestDeadline.throwIfAborted();
    return format === "json" ? JSON.parse(text) : text;
  } finally {
    requestDeadline.signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* non-cooperating reader */ }
  }
}
