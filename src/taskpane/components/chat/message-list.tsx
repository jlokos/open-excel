import { code } from "@streamdown/code";
import { ArrowRight, Brain, CheckCircle2, ChevronDown, ChevronRight, Loader2, Wrench, XCircle } from "lucide-react";
import type { AnchorHTMLAttributes } from "react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { navigateTo } from "../../../lib/excel/api";
import { type ChatMessage, type MessagePart, useChat } from "./chat-context";

function ThinkingBlock({ thinking, isStreaming }: { thinking: string; isStreaming?: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="mb-3 border border-(--chat-border) bg-(--chat-bg-secondary) rounded-lg overflow-hidden shadow-[var(--chat-shadow-soft)]">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium text-(--chat-accent) hover:bg-(--chat-bg-tertiary) transition-colors"
      >
        {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Brain size={10} />
        thinking
        {isStreaming && <span className="animate-pulse ml-1">...</span>}
      </button>
      {isExpanded && (
        <div className="px-3 py-2 text-xs text-(--chat-text-muted) whitespace-pre-wrap break-words border-t border-(--chat-border) max-h-24 overflow-y-auto">
          {thinking}
        </div>
      )}
    </div>
  );
}

type ToolCallPart = Extract<MessagePart, { type: "toolCall" }>;
type ImagePart = Extract<MessagePart, { type: "image" }>;

function ToolCallBlock({ part }: { part: ToolCallPart }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const explanation = (part.args as { explanation?: string })?.explanation;

  const statusIcon = {
    pending: <Loader2 size={10} className="animate-spin text-(--chat-text-muted)" />,
    running: <Loader2 size={10} className="animate-spin text-(--chat-accent)" />,
    complete: <CheckCircle2 size={10} className="text-green-500" />,
    error: <XCircle size={10} className="text-red-500" />,
  }[part.status];

  return (
    <div className="mt-3 mb-3 border border-(--chat-border) bg-(--chat-bg-secondary) rounded-lg overflow-hidden shadow-[var(--chat-shadow-soft)]">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-[11px] font-medium text-(--chat-text-secondary) hover:bg-(--chat-bg-tertiary) transition-colors ${explanation ? "normal-case" : "uppercase"}`}
      >
        {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Wrench size={10} />
        <span className="flex-1 text-left font-medium">{explanation || part.name}</span>
        {statusIcon}
      </button>
      {isExpanded && (
        <div className="border-t border-(--chat-border)">
          <div className="px-3 py-2 text-xs">
            <div className="text-(--chat-text-muted) text-[10px] uppercase mb-1">args</div>
            <div className="markdown-content max-h-32 overflow-y-auto [&_[data-streamdown=code-block]]:my-0 [&_[data-streamdown=code-block]]:border-0">
              <Streamdown plugins={{ code }}>{`\`\`\`json\n${JSON.stringify(part.args, null, 2)}\n\`\`\``}</Streamdown>
            </div>
          </div>
          {part.result && (
            <div className="px-3 py-2 text-xs border-t border-(--chat-border)">
              <div className="text-(--chat-text-muted) text-[10px] uppercase mb-1">
                {part.status === "error" ? "error" : "result"}
              </div>
              <div
                className={`markdown-content max-h-40 overflow-y-auto [&_[data-streamdown=code-block]]:my-0 [&_[data-streamdown=code-block]]:border-0 ${part.status === "error" ? "[&_code]:!text-red-400" : ""}`}
              >
                <Streamdown plugins={{ code }}>{`\`\`\`json\n${part.result}\n\`\`\``}</Streamdown>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ImageBlock({ part }: { part: ImagePart }) {
  const src = `data:${part.mimeType};base64,${part.data}`;
  return (
    <div className="mt-2 border border-(--chat-border) bg-(--chat-bg-secondary) p-1" style={{ borderRadius: "var(--chat-radius)" }}>
      <img src={src} alt={part.name ?? "attachment"} className="max-h-48 max-w-full object-contain" loading="lazy" />
      {part.name && <div className="mt-1 text-[10px] text-(--chat-text-muted) truncate">{part.name}</div>}
    </div>
  );
}

function LoadingIndicator() {
  return (
    <div
      className="flex items-center gap-2 text-(--chat-accent) text-sm"
      style={{ fontFamily: "var(--chat-font-sans)" }}
    >
      <span className="h-2 w-2 rounded-full bg-(--chat-accent) animate-pulse" />
      <span>Reasoning...</span>
    </div>
  );
}

function parseCitationUri(href: string): { sheetId: number; range?: string } | null {
  if (!href.startsWith("#cite:")) return null;
  const path = href.slice("#cite:".length);
  const bangIdx = path.indexOf("!");
  if (bangIdx === -1) {
    const sheetId = Number.parseInt(path, 10);
    return Number.isNaN(sheetId) ? null : { sheetId };
  }
  const sheetId = Number.parseInt(path.slice(0, bangIdx), 10);
  const range = path.slice(bangIdx + 1);
  return Number.isNaN(sheetId) ? null : { sheetId, range };
}

function CitationLink({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const citation = href ? parseCitationUri(href) : null;

  if (!citation) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  }

  return (
    <button
      type="button"
      className="text-(--chat-accent) hover:underline cursor-pointer"
      onClick={() => {
        navigateTo(citation.sheetId, citation.range).catch((err) => {
          console.error("[Citation] Navigation failed:", err);
        });
      }}
    >
      {children}
    </button>
  );
}

const markdownComponents = { a: CitationLink };

function MarkdownContent({ text, isAnimating }: { text: string; isAnimating?: boolean }) {
  return (
    <div className="markdown-content">
      <Streamdown plugins={{ code }} components={markdownComponents} isAnimating={isAnimating}>
        {text}
      </Streamdown>
    </div>
  );
}

function renderParts(parts: MessagePart[], isStreaming: boolean, messageId: string) {
  const lastPart = parts[parts.length - 1];
  const isStreamingThinking = isStreaming && lastPart?.type === "thinking";
  const isStreamingText = isStreaming && lastPart?.type === "text";

  return parts.map((part, idx) => {
    const key = part.type === "toolCall" ? part.id : `${messageId}-${part.type}-${idx}`;
    const isLastPart = idx === parts.length - 1;
    if (part.type === "thinking") {
      return <ThinkingBlock key={key} thinking={part.thinking} isStreaming={isStreamingThinking && isLastPart} />;
    }
    if (part.type === "image") {
      return <ImageBlock key={key} part={part} />;
    }
    if (part.type === "toolCall") {
      return <ToolCallBlock key={key} part={part} />;
    }
    return <MarkdownContent key={key} text={part.text} isAnimating={isStreamingText && isLastPart} />;
  });
}

function UserBubble({ message }: { message: ChatMessage }) {
  return (
    <div
      className="ml-6 max-w-[85%] px-4 py-3 text-sm leading-relaxed bg-(--chat-user-bg) border border-(--chat-border) shadow-[var(--chat-shadow-soft)]"
      style={{ borderRadius: "var(--chat-radius)", fontFamily: "var(--chat-font-sans)" }}
    >
      {renderParts(message.parts, false, message.id)}
    </div>
  );
}

function AssistantBubble({ messages, isStreaming }: { messages: ChatMessage[]; isStreaming: boolean }) {
  const allParts: { part: MessagePart; messageId: string; isLast: boolean }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isLastMessage = i === messages.length - 1;
    for (let j = 0; j < msg.parts.length; j++) {
      allParts.push({
        part: msg.parts[j],
        messageId: msg.id,
        isLast: isLastMessage && j === msg.parts.length - 1,
      });
    }
  }

  return (
    <div className="text-sm leading-relaxed max-w-[90%]" style={{ fontFamily: "var(--chat-font-sans)" }}>
      {allParts.map(({ part, messageId, isLast }, idx) => {
        const key = part.type === "toolCall" ? part.id : `${messageId}-${part.type}-${idx}`;
        if (part.type === "thinking") {
          return <ThinkingBlock key={key} thinking={part.thinking} isStreaming={isStreaming && isLast} />;
        }
        if (part.type === "image") {
          return <ImageBlock key={key} part={part} />;
        }
        if (part.type === "toolCall") {
          return <ToolCallBlock key={key} part={part} />;
        }
        return (
          <MarkdownContent key={key} text={part.text} isAnimating={isStreaming && isLast && part.type === "text"} />
        );
      })}
      {isStreaming && allParts.length === 0 && <span className="animate-pulse">▊</span>}
    </div>
  );
}

type MessageGroup = { type: "user"; message: ChatMessage } | { type: "assistant"; messages: ChatMessage[] };

function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentAssistantGroup: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (currentAssistantGroup.length > 0) {
        groups.push({ type: "assistant", messages: currentAssistantGroup });
        currentAssistantGroup = [];
      }
      groups.push({ type: "user", message: msg });
    } else {
      currentAssistantGroup.push(msg);
    }
  }

  if (currentAssistantGroup.length > 0) {
    groups.push({ type: "assistant", messages: currentAssistantGroup });
  }

  return groups;
}

export function MessageList() {
  const { state, sendMessage } = useChat();
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      shouldAutoScroll.current = distanceFromBottom < 100;
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - trigger scroll on message/streaming changes
  useEffect(() => {
    if (containerRef.current && shouldAutoScroll.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [state.messages, state.isStreaming]);

  if (state.messages.length === 0) {
    const suggestions = ["Build a 3-statement model", "Create a debt payoff plan", "Build a family tree"];
    const canSend = Boolean(state.providerConfig) && !state.isStreaming;
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-6"
        style={{ fontFamily: "var(--chat-font-sans)" }}
      >
        <div className="space-y-2">
          <div className="text-2xl font-semibold tracking-tight text-(--chat-text-primary)">OpenExcel</div>
          <div className="text-(--chat-text-secondary) text-sm max-w-[260px]">
            Ask anything about your spreadsheet or start with a template.
          </div>
        </div>
        <div className="w-full max-w-[260px] space-y-2">
          {suggestions.map((prompt) => (
            <button
              key={prompt}
              type="button"
              disabled={!canSend}
              onClick={() => {
                void sendMessage(prompt);
              }}
              className="w-full flex items-center justify-between gap-3 px-4 py-2 rounded-full border border-(--chat-border) bg-(--chat-bg-secondary) text-sm text-(--chat-text-secondary) shadow-[var(--chat-shadow-soft)] transition-colors hover:border-(--chat-accent) hover:text-(--chat-text-primary) disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="text-left">{prompt}</span>
              <ArrowRight size={14} className="text-(--chat-text-muted)" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  const groups = groupMessages(state.messages);
  const lastMessage = state.messages[state.messages.length - 1];
  const showLoading = state.isStreaming && lastMessage?.role === "user";
  const lastGroup = groups[groups.length - 1];
  const isStreamingAssistant = state.isStreaming && lastGroup?.type === "assistant";

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto p-6 space-y-4"
      style={{
        scrollbarWidth: "thin",
        scrollbarColor: "var(--chat-scrollbar) transparent",
      }}
    >
      {groups.map((group, i) => {
        if (group.type === "user") {
          return <UserBubble key={group.message.id} message={group.message} />;
        }
        const groupKey = group.messages.map((m) => m.id).join("-");
        return (
          <AssistantBubble
            key={groupKey}
            messages={group.messages}
            isStreaming={isStreamingAssistant && i === groups.length - 1}
          />
        );
      })}
      {showLoading && <LoadingIndicator />}
    </div>
  );
}
