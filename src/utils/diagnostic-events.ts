/** Startup metadata only; never accept error messages, paths or conversation text. */
export function diagnosticEvent(event: "display_ready" | "display_failure" | "application_ready" | "node_failure",
  reason?: "display_not_ready" | "display_spawn_failed" | "startup_failed"): void {
  if (process.env.WHISPLAY_LATENCY_DIAGNOSTICS !== "true") return;
  try { console.log("[Diagnostics] " + JSON.stringify({ event, phase: "startup", ...(reason ? { reason } : {}) })); }
  catch { /* An external diagnostic supervisor still observes child termination. */ }
}

export function diagnosticFailure(error: unknown): void {
  if (process.env.WHISPLAY_LATENCY_DIAGNOSTICS !== "true") return;
  const value = error as { code?: string; name?: string; message?: string };
  const codes: Record<string, string> = { MODULE_NOT_FOUND: "module_missing", ENOENT: "required_file_missing",
    EACCES: "permission_denied", EADDRINUSE: "port_in_use" };
  const message = typeof value?.message === "string" ? value.message : "";
  const reason = typeof value?.code === "string" && Object.prototype.hasOwnProperty.call(codes, value.code) && codes[value.code] ||
    (message.startsWith("Display port 12345 is occupied") ? "display_port_in_use" : "startup_failed");
  try { console.log("[Diagnostics] " + JSON.stringify({ event: "node_failure", phase: "startup", reason })); }
  catch { /* Exit status is still observed by the independent guardian. */ }
}
