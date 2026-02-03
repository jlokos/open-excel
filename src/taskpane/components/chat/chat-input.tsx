import { ImagePlus, Send, Square, X } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { type ImageAttachment, useChat } from "./chat-context";

const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = dataUrl.match(/^data:(.*?);base64,(.*)$/);
  if (!match) throw new Error("Invalid data URL");
  return { mimeType: match[1] || "application/octet-stream", data: match[2] };
}

export function ChatInput() {
  const { sendMessage, state, abort } = useChat();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const supportsImages = Boolean(state.providerConfig && state.modelSupportsImages);

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

  useEffect(() => {
    if (!supportsImages && attachments.length > 0) {
      setAttachments([]);
      setAttachmentError(null);
    }
  }, [supportsImages, attachments.length]);

  const handleFileChange = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      if (!supportsImages) {
        setAttachmentError("Selected model does not support image inputs.");
        return;
      }
      setAttachmentError(null);

      const files = Array.from(fileList);
      const availableSlots = MAX_ATTACHMENTS - attachments.length;
      if (availableSlots <= 0) {
        setAttachmentError(`Up to ${MAX_ATTACHMENTS} images per message.`);
        return;
      }

      const nextAttachments: ImageAttachment[] = [];
      for (const file of files.slice(0, availableSlots)) {
        if (!file.type.startsWith("image/")) {
          setAttachmentError("Only image files are supported.");
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          setAttachmentError(`Images must be under ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB.`);
          continue;
        }
        try {
          const dataUrl = await readFileAsDataUrl(file);
          const { data, mimeType } = parseDataUrl(dataUrl);
          nextAttachments.push({
            id: crypto.randomUUID(),
            name: file.name,
            size: file.size,
            data,
            mimeType: mimeType || file.type || "application/octet-stream",
          });
        } catch (err) {
          console.error("[Chat] Failed to read attachment:", err);
          setAttachmentError("Failed to read image file.");
        }
      }

      if (files.length > availableSlots) {
        setAttachmentError(`Up to ${MAX_ATTACHMENTS} images per message.`);
      }

      if (nextAttachments.length > 0) {
        setAttachments((prev) => [...prev, ...nextAttachments]);
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [attachments.length, supportsImages],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (state.isStreaming) return;
    if (!trimmed && attachments.length === 0) return;
    const pendingAttachments = attachments;
    setInput("");
    setAttachments([]);
    setAttachmentError(null);
    await sendMessage(trimmed, pendingAttachments);
  }, [attachments, input, sendMessage, state.isStreaming]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const canSend = Boolean(state.providerConfig && (input.trim() || attachments.length > 0) && !state.isStreaming);
  const attachDisabled = !state.providerConfig || !supportsImages || state.isStreaming;

  return (
    <div className="border-t border-(--chat-border) p-3 bg-(--chat-bg)" style={{ fontFamily: "var(--chat-font-mono)" }}>
      {state.error && <div className="text-(--chat-error) text-xs mb-2 px-1">{state.error}</div>}
      {attachmentError && <div className="text-(--chat-error) text-xs mb-2 px-1">{attachmentError}</div>}
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
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2 px-1">
          {attachments.map((attachment) => {
            const src = `data:${attachment.mimeType};base64,${attachment.data}`;
            return (
              <div
                key={attachment.id}
                className="relative border border-(--chat-border) bg-(--chat-bg-secondary) p-1"
                style={{ borderRadius: "var(--chat-radius)" }}
              >
                <img
                  src={src}
                  alt={attachment.name ?? "attachment"}
                  className="h-16 w-16 object-cover"
                  loading="lazy"
                />
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment.id)}
                  className="absolute -top-2 -right-2 p-0.5 rounded-full bg-(--chat-bg) border border-(--chat-border) text-(--chat-text-muted) hover:text-(--chat-text-primary)"
                  aria-label="Remove attachment"
                >
                  <X size={10} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => handleFileChange(e.target.files)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={attachDisabled}
          title={
            !state.providerConfig
              ? "Configure an API provider to attach images"
              : !supportsImages
                ? "Selected model does not support images"
                : "Attach image"
          }
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
          <ImagePlus size={16} />
        </button>
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
            disabled={!canSend}
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
