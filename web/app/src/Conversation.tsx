import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Bubble, Marker, Message, MessageScroller } from '@/components/ui/message';
import { CodeBlock } from '@/components/ui/code-block';
import { CreaturePresence, type CreaturePresenceValue } from './components/CreaturePresence';
import {
  httpTransport,
  mergeTranscript,
  type TranscriptMessage,
  type WebTransport,
} from './transport';

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
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
            <CodeBlock code={code} language={match[1]} />
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
  const client = useQueryClient();
  const scroller = useRef<HTMLDivElement>(null);
  const scrollPosition = useRef<{ height: number; top: number } | undefined>(undefined);
  const didInitialPosition = useRef(false);
  const [creature, setCreature] = useState<CreaturePresenceValue>();
  const [announcement, setAnnouncement] = useState('');
  const transcript = useInfiniteQuery({
    queryKey: ['transcript'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => transport.readTranscript(pageParam),
    getPreviousPageParam: (firstPage) => {
      const oldest = firstPage.messages.at(-1)?.sequence;
      return firstPage.messages.length === 50 ? oldest : undefined;
    },
    getNextPageParam: () => undefined,
  });
  const messages = useMemo(
    () => sortTranscript(transcript.data?.pages.map((page) => page.messages) ?? []),
    [transcript.data]
  );
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
        setAnnouncement(
          message.role === 'assistant' ? t('newAssistantMessage') : t('newOwnerMessage')
        );
        client.setQueryData(['transcript'], (current: typeof transcript.data) => {
          if (!current) return current;
          const all = sortTranscript(current.pages.map((page) => page.messages));
          const merged = mergeTranscript(all, message);
          return {
            ...current,
            pages: [{ ...current.pages[0], messages: merged }, ...current.pages.slice(1)],
          };
        });
      },
      (state) => {
        setCreature(state);
        onState?.(state);
      }
    );
  }, [client, transcript.data?.pages.at(-1)?.cursor, transport, onState, t]);

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

  const lastOwnerSequence = [...messages]
    .reverse()
    .find((message) => message.role === 'user')?.sequence;
  const virtualItems = scroller.current?.clientHeight
    ? virtualizer.getVirtualItems()
    : messages.map((_, index) => ({ index, start: index * 96 }));
  const dateLabel = (message: TranscriptMessage) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(
      new Date(message.createdAt)
    );

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label={t('conversation')}>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <Avatar className="bg-primary text-primary-foreground">
          <AvatarFallback className="bg-primary text-primary-foreground">l</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">lifemodel</span>
          <CreaturePresence value={creature} />
        </div>
      </header>
      <MessageScroller
        ref={scroller}
        data-testid="transcript-scroller"
        aria-label={t('conversationMessages')}
        className="min-h-0 flex-1"
        onScroll={(event) => {
          if (event.currentTarget.scrollTop <= 20) readEarlier();
        }}
      >
        {transcript.isPending ? (
          <p className="p-4 text-sm text-muted-foreground">{t('loading')}</p>
        ) : null}
        {transcript.isError ? (
          <p role="alert" className="p-4">
            {t('transcriptError')}
          </p>
        ) : null}
        {transcript.isFetchingPreviousPage ? (
          <p className="p-2 text-center text-xs text-muted-foreground">{t('loadingEarlier')}</p>
        ) : null}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
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
                <Message className={owner ? 'justify-end' : 'justify-start'}>
                  {!owner ? (
                    <Avatar className="mt-1">
                      <AvatarFallback>l</AvatarFallback>
                    </Avatar>
                  ) : null}
                  <div className="flex min-w-0 flex-col">
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
                  </div>
                </Message>
              </div>
            );
          })}
        </div>
        {creature?.state === 'thinking' ? (
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
      </MessageScroller>
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
