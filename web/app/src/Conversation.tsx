import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { Send, CornerUpLeft } from 'lucide-react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { isExpired, scheduleNotSent } from './send-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Message } from '@/components/ui/message';
import { Bubble } from '@/components/ui/bubble';
import { Marker } from '@/components/ui/marker';
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { CodeBlock, CodeBlockContent, CodeBlockLine } from '@/components/ui/code-block';
import { useHighlightedCode } from '@/hooks/use-highlighted-code';
import { freshCreatureState, type CreaturePresenceValue } from './components/CreaturePresence';
import {
  httpTransport,
  mergeTranscript,
  type TranscriptMessage,
  type WebTransport,
} from './transport';

function uuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function HighlightedCode({ code, language }: { code: string; language: string }) {
  const lines = useHighlightedCode(code, language);
  return (
    <CodeBlock>
      <CodeBlockContent>
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

function MessageText({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => {
          const safeHref = safeHttpUrl(href);
          return safeHref ? (
            <a href={safeHref} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ) : (
            <span>{children}</span>
          );
        },
        img: () => null,
        code: ({ className, children, ...props }) => {
          const match = /language-([\w-]+)/.exec(className ?? '');
          const codeText = Array.isArray(children)
            ? children.filter((child): child is string => typeof child === 'string').join('')
            : typeof children === 'string'
              ? children
              : '';
          const code = codeText.replace(/\n$/, '');
          return match ? (
            <HighlightedCode code={code} language={match[1]} />
          ) : (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function sortTranscript(pages: TranscriptMessage[][]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const page of pages) for (const message of page) messages.push(message);
  const merged = new Map<string, TranscriptMessage>();
  const clients = new Map<string, string>();
  for (const message of messages) {
    const clientMatch = message.clientId ? clients.get(message.clientId) : undefined;
    const key = clientMatch ?? message.sequence;
    const prior = merged.get(key);
    merged.set(key, prior ? { ...prior, ...message } : message);
    if (message.clientId) clients.set(message.clientId, key);
  }
  return [...merged.values()].sort((a, b) =>
    BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0
  );
}

function ConversationContent({
  transport,
  onState,
}: {
  transport: WebTransport;
  onState?: (state: CreaturePresenceValue) => void;
}) {
  const { t, i18n } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const scrollPosition = useRef<{ height: number; top: number } | undefined>(undefined);
  const didInitialPosition = useRef(false);
  const [creature, setCreature] = useState<CreaturePresenceValue>();
  const [now, setNow] = useState(Date.now());
  const [liveTail, setLiveTail] = useState<TranscriptMessage[]>([]);
  const [hasEarlierByCursor, setHasEarlierByCursor] = useState<Record<string, boolean>>({});
  const [announcement, setAnnouncement] = useState('');
  const [draft, setDraft] = useState('');
  type PendingMessage = TranscriptMessage & {
    status?: 'sending' | 'failed';
    mintedAt: number;
    failureReason?: string;
  };
  const [optimistic, setOptimistic] = useState<PendingMessage[]>([]);
  const [reply, setReply] = useState<TranscriptMessage | undefined>();
  const transcript = useInfiniteQuery({
    queryKey: ['transcript'],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const page = await transport.readTranscript(pageParam);
      setHasEarlierByCursor((current) => ({
        ...current,
        [page.cursor]: page.messages.length === 50,
      }));
      return page;
    },
    getPreviousPageParam: (firstPage) => {
      const oldest = firstPage.messages.at(-1)?.sequence;
      return hasEarlierByCursor[firstPage.cursor] && oldest ? oldest : undefined;
    },
    getNextPageParam: () => undefined,
  });
  const durableRows = useMemo(
    () =>
      sortTranscript([...(transcript.data?.pages.map((page) => page.messages) ?? []), liveTail]),
    [transcript.data, liveTail]
  );
  const messages = useMemo(
    () => sortTranscript([optimistic, durableRows]),
    [optimistic, durableRows]
  );
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);
  const freshCreature = freshCreatureState(creature, now);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 96,
    overscan: 8,
    initialRect: { width: 800, height: 640 },
    getItemKey: (index) => messages[index]?.sequence ?? index,
  });

  useEffect(() => {
    const latest = transcript.data?.pages.at(-1);
    if (!latest) return;
    return transport.subscribe(
      latest.cursor,
      (message) => {
        setLiveTail((rows) => mergeTranscript(rows, message));
        if (message.clientId)
          setOptimistic((rows) => rows.filter((row) => row.clientId !== message.clientId));
        setAnnouncement(
          message.role === 'assistant' ? t('newAssistantMessage') : t('newOwnerMessage')
        );
      },
      (state) => {
        setCreature(state);
        onState?.(state);
      }
    );
  }, [transcript.data?.pages.at(-1)?.cursor, transport, onState, t]);

  useLayoutEffect(() => {
    if (!scroller.current || !transcript.data) return;
    if (scrollPosition.current) {
      const element = scroller.current;
      element.scrollTop =
        scrollPosition.current.top + element.scrollHeight - scrollPosition.current.height;
      scrollPosition.current = undefined;
    } else if (!didInitialPosition.current && messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
      didInitialPosition.current = true;
    }
  }, [messages.length, transcript.data, virtualizer]);

  const readEarlier = () => {
    if (!transcript.hasPreviousPage || transcript.isFetchingPreviousPage || !scroller.current)
      return;
    scrollPosition.current = {
      height: scroller.current.scrollHeight,
      top: scroller.current.scrollTop,
    };
    void transcript.fetchPreviousPage();
  };

  const lastOwnerSequence = [...durableRows]
    .reverse()
    .find((message) => message.role === 'user')?.sequence;
  const virtualItems = scroller.current?.clientHeight
    ? virtualizer.getVirtualItems()
    : messages.map((_, index) => ({ index, start: index * 96 }));
  const send = async (
    text: string,
    replyTo?: TranscriptMessage,
    retry?: { id: string; mintedAt: number; failureReason?: string }
  ) => {
    const id =
      retry && retry.failureReason === 'network' && !isExpired(retry.mintedAt, Date.now())
        ? retry.id
        : uuidV7();
    const mintedAt = retry && id === retry.id ? retry.mintedAt : Date.now();
    const item: PendingMessage = {
      sequence: String(Date.now()),
      clientId: id,
      role: 'user',
      text,
      createdAt: new Date().toISOString(),
      ...(replyTo
        ? {
            replyTo: {
              sequence: replyTo.sequence,
              role: replyTo.role,
              excerpt: replyTo.text.slice(0, 280),
            },
          }
        : {}),
      status: 'sending',
      mintedAt,
    };
    setOptimistic((current) =>
      current.some((row) => row.clientId === id) ? current : [...current, item]
    );
    const expiration = scheduleNotSent(window.setTimeout.bind(window), () => {
      setOptimistic((current) =>
        current.map((row) =>
          row.clientId === id ? { ...row, status: 'failed', failureReason: 'expired' } : row
        )
      );
    });
    const submit = () =>
      transport.sendMessage({ id, text, ...(replyTo ? { replyTo: replyTo.sequence } : {}) });
    try {
      let result;
      try {
        result = await submit();
      } catch {
        result = await submit();
      }
      if (result === 'accepted') {
        window.clearTimeout(expiration);
        setOptimistic((current) =>
          current.map((row) => (row.clientId === id ? { ...row, status: undefined } : row))
        );
      } else {
        window.clearTimeout(expiration);
        const failureReason = result === 'stale' ? 'stale' : 'conflict';
        setOptimistic((current) =>
          current.map((row) =>
            row.clientId === id ? { ...row, status: 'failed', failureReason } : row
          )
        );
      }
    } catch {
      window.clearTimeout(expiration);
      setOptimistic((current) =>
        current.map((row) =>
          row.clientId === id ? { ...row, status: 'failed', failureReason: 'network' } : row
        )
      );
    }
  };

  const submitDraft = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    const binding = reply;
    setReply(undefined);
    void send(text, binding);
  };

  const dateLabel = (message: TranscriptMessage) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(
      new Date(message.createdAt)
    );

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label={t('conversation')}>
      <MessageScrollerProvider>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport
            ref={scroller}
            data-testid="transcript-scroller"
            aria-label={t('conversationMessages')}
            onScroll={(event) => {
              if (event.currentTarget.scrollTop <= 20) readEarlier();
            }}
          >
            <MessageScrollerContent>
              {transcript.isPending ? (
                <p className="p-4 text-sm text-muted-foreground">{t('loading')}</p>
              ) : null}
              {transcript.isError ? (
                <p role="alert" className="p-4">
                  {t('transcriptError')}
                </p>
              ) : null}
              {transcript.isFetchingPreviousPage ? (
                <p className="p-2 text-center text-xs text-muted-foreground">
                  {t('loadingEarlier')}
                </p>
              ) : null}
              <div
                style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
              >
                {virtualItems.map((virtualRow) => {
                  const message = messages[virtualRow.index];
                  if (!message) return null;
                  const previous = messages[virtualRow.index - 1];
                  const owner = message.role === 'user';
                  return (
                    <div
                      key={message.sequence}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${String(virtualRow.start)}px)`,
                      }}
                    >
                      {!previous || dateLabel(previous) !== dateLabel(message) ? (
                        <Marker>{dateLabel(message)}</Marker>
                      ) : null}
                      <Message className={`group ${owner ? 'justify-end' : 'justify-start'}`}>
                        {!owner ? (
                          <Avatar className="mt-1">
                            <AvatarFallback>l</AvatarFallback>
                          </Avatar>
                        ) : null}
                        <div className="flex min-w-0 flex-col">
                          {message.replyTo ? (
                            <Marker className="justify-start gap-1 border-l-2 pl-2 text-left">
                              <CornerUpLeft aria-hidden="true" className="size-3" />
                              {message.replyTo.excerpt}
                            </Marker>
                          ) : null}
                          <Bubble
                            className={
                              owner
                                ? 'bg-accent text-accent-foreground'
                                : 'bg-secondary text-secondary-foreground'
                            }
                          >
                            <MessageText text={message.text} />
                          </Bubble>
                          <time
                            className="px-2 pt-1 text-xs text-muted-foreground"
                            dateTime={message.createdAt}
                          >
                            {new Intl.DateTimeFormat(i18n.language, {
                              hour: '2-digit',
                              minute: '2-digit',
                            }).format(new Date(message.createdAt))}
                          </time>
                          {owner && message.sequence === lastOwnerSequence ? (
                            <span
                              className="px-2 pt-1 text-right text-xs text-muted-foreground"
                              data-testid="read-receipt"
                            >
                              {t('readAt', {
                                time: new Intl.DateTimeFormat(i18n.language, {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                }).format(new Date(message.createdAt)),
                              })}
                            </span>
                          ) : null}
                          <div className="flex items-center gap-2 px-2 pt-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              aria-label={`${t('replyTo')} ${message.text.slice(0, 80)}`}
                              onClick={() => {
                                setReply(message);
                              }}
                            >
                              {t('reply')}
                            </Button>
                            {message.clientId &&
                            optimistic.find((row) => row.clientId === message.clientId)?.status ===
                              'failed' ? (
                              <>
                                <span className="text-xs text-destructive">
                                  {t('notSentRetry')}
                                </span>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  aria-label={t('retrySending')}
                                  onClick={() => {
                                    const failed = optimistic.find(
                                      (row) => row.clientId === message.clientId
                                    );
                                    if (failed)
                                      void send(
                                        failed.text,
                                        failed.replyTo
                                          ? {
                                              sequence: failed.replyTo.sequence,
                                              role: failed.replyTo.role,
                                              text: failed.replyTo.excerpt,
                                              createdAt: failed.createdAt,
                                            }
                                          : undefined,
                                        {
                                          id: failed.clientId!,
                                          mintedAt: failed.mintedAt,
                                          failureReason: failed.failureReason,
                                        }
                                      );
                                  }}
                                >
                                  {t('retry')}
                                </Button>
                              </>
                            ) : null}
                          </div>
                        </div>
                      </Message>
                    </div>
                  );
                })}
              </div>
              {freshCreature?.state === 'thinking' ? (
                <Message className="justify-start" aria-label={t('thinking')}>
                  <Avatar className="mt-1">
                    <AvatarFallback>l</AvatarFallback>
                  </Avatar>
                  <Bubble className="bg-secondary text-secondary-foreground" aria-hidden="true">
                    •••
                  </Bubble>
                </Message>
              ) : null}
              <div aria-live="polite" className="sr-only" data-testid="live-announcement">
                {announcement}
              </div>
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
      <form
        className="shrink-0 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          submitDraft();
        }}
      >
        <InputGroup>
          {reply ? (
            <InputGroupAddon align="block-start">
              <Badge variant="secondary" className="max-w-full gap-1">
                <CornerUpLeft aria-hidden="true" className="size-3 shrink-0" />
                <span className="truncate">{reply.text.slice(0, 280)}</span>
              </Badge>
              <InputGroupButton
                type="button"
                aria-label={t('cancelReply')}
                className="ml-auto"
                onClick={() => {
                  setReply(undefined);
                }}
              >
                ×
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
          <InputGroupTextarea
            aria-label={t('message')}
            placeholder={t('writeMessage')}
            value={draft}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submitDraft();
              }
            }}
          />
          <InputGroupAddon align="block-end">
            <span className="ml-1 text-xs text-muted-foreground">
              Enter {t('send')} · Shift+Enter
            </span>
            <InputGroupButton
              type="submit"
              aria-label={t('send')}
              disabled={!draft.trim()}
              variant="default"
              className="ml-auto"
            >
              <Send aria-hidden="true" className="size-4" />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  );
}

export function Conversation({
  transport = httpTransport,
  onState,
}: {
  transport?: WebTransport;
  onState?: (state: CreaturePresenceValue) => void;
}) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  return (
    <QueryClientProvider client={client}>
      <ConversationContent transport={transport} onState={onState} />
    </QueryClientProvider>
  );
}
