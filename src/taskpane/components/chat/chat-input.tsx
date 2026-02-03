import { Send, Square } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "./chat-context";

export function ChatInput() {
  const { sendMessage, state, abort } = useChat();
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    }
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [adjustHeight]);

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || state.isStreaming) return;
    setInput("");
    await sendMessage(trimmed);
  }, [input, state.isStreaming, sendMessage]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="border-t border-(--chat-border) p-3 bg-(--chat-bg)" style={{ fontFamily: "var(--chat-font-mono)" }}>
      {state.error && <div className="text-(--chat-error) text-xs mb-2 px-1">{state.error}</div>}
      {state.error && state.debug.requestId && (
        <details className="text-[11px] text-(--chat-text-secondary) mb-2 px-1">
          <summary className="cursor-pointer select-none">Debug details</summary>
          <div className="mt-2 space-y-2">
            <div>Request ID: {state.debug.requestId}</div>
            {state.debug.provider && <div>Provider: {state.debug.provider}</div>}
            {state.debug.model && <div>Model: {state.debug.model}</div>}
            {state.debug.baseUrl && <div>Base URL: {state.debug.baseUrl}</div>}
            {state.debug.payloadSize !== undefined && <div>Payload size: {state.debug.payloadSize} chars</div>}
            {state.debug.payloadPreview && (
              <pre className="whitespace-pre-wrap bg-(--chat-bg-secondary) border border-(--chat-border) p-2 text-[10px] max-h-48 overflow-y-auto">
                {state.debug.payloadPreview}
              </pre>
            )}
          </div>
        </details>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={state.providerConfig ? "Type a message..." : "Configure API key in settings"}
          disabled={!state.providerConfig}
          rows={1}
          className={`
            flex-1 resize-none bg-(--chat-input-bg) text-(--chat-text-primary)
            text-sm px-3 py-2 border border-(--chat-border)
            placeholder:text-(--chat-text-muted)
            focus:outline-none focus:border-(--chat-border-active)
            disabled:opacity-50 disabled:cursor-not-allowed
          `}
          style={{
            borderRadius: "var(--chat-radius)",
            fontFamily: "var(--chat-font-mono)",
            minHeight: "36px",
          }}
        />
        {state.isStreaming ? (
          <button
            type="button"
            onClick={abort}
            className={`
              p-2 border border-(--chat-error) bg-(--chat-bg-secondary)
              text-(--chat-error)
              hover:bg-(--chat-error) hover:text-(--chat-bg)
              transition-colors
            `}
            style={{ borderRadius: "var(--chat-radius)" }}
          >
            <Square size={16} />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!state.providerConfig || !input.trim()}
            className={`
              p-2 border border-(--chat-border) bg-(--chat-bg-secondary)
              text-(--chat-text-secondary)
              hover:bg-(--chat-bg-tertiary) hover:text-(--chat-text-primary)
              hover:border-(--chat-border-active)
              disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-(--chat-bg-secondary)
              transition-colors
            `}
            style={{ borderRadius: "var(--chat-radius)" }}
          >
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
