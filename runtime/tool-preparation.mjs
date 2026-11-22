// Observe only the lifecycle of argument streaming. Never forward or retain
// partial argument strings, tool names, IDs, or provider-specific payloads.
export function createToolPreparation(emit) {
  const pending = new Set();
  let active = false;

  function clear() {
    active = false;
    if (!pending.size) return;
    pending.clear();
    emit({ type: "tool_preparation", count: 0 });
  }

  function observe(event) {
    if (event.type === "message_start" && event.message.role === "assistant") {
      clear();
      active = true;
      return;
    }
    if ((event.type === "message_end" && event.message.role === "assistant")
        || ["auto_retry_start", "agent_end", "turn_end"].includes(event.type)) {
      clear();
      return;
    }
    if (!active || event.type !== "message_update") return;
    const part = event.assistantMessageEvent;
    const index = part?.contentIndex;
    if (!Number.isSafeInteger(index) || index < 0) return;
    const before = pending.size;
    if (part.type === "toolcall_end") pending.delete(index);
    else if (part.type === "toolcall_start" && pending.size < 64) pending.add(index);
    // Argument deltas do not trigger work or UI notifications per chunk.
    if (pending.size !== before) emit({ type: "tool_preparation", count: pending.size });
  }

  return { observe, clear };
}
