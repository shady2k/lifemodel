import * as React from 'react';
import { cn } from 'cn';

export function InputGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="input-group"
      className={cn(
        'flex items-end gap-2 rounded-xl border bg-background p-2 focus-within:ring-2 focus-within:ring-ring/50',
        className
      )}
      {...props}
    />
  );
}

export function InputGroupTextarea(props: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="input-group-textarea"
      className="max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-base outline-none placeholder:text-muted-foreground md:text-sm"
      {...props}
    />
  );
}

export function InputGroupButton({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      data-slot="input-group-button"
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground outline-none hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
        className
      )}
      {...props}
    />
  );
}
