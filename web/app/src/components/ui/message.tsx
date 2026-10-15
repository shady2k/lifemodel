import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from 'cn';

export const MessageScroller = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function MessageScroller({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn('h-full overflow-y-auto overscroll-contain', className)}
        {...props}
      />
    );
  }
);

export function Message({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <article className={cn('flex w-full gap-3 px-4 py-2', className)} {...props} />;
}

export function Bubble({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('min-w-0 max-w-[min(80%,48rem)] rounded-2xl px-4 py-3', className)}
      {...props}
    />
  );
}

export function Marker({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-center py-4 text-xs text-muted-foreground',
        className
      )}
      {...props}
    />
  );
}
