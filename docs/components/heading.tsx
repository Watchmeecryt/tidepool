"use client";
import { buttonVariants } from "fumadocs-ui/components/ui/button";
import { CopyCheckIcon, LinkIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";

type Level = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

/**
 * Same markup as fumadocs-ui's Heading, except the copy-anchor button has an aria-label (no hidden text node)
 * and sits inside <span data-nosnippet>, so "Copy Anchor Link" never shows up in search snippets or extracted text.
 */
function Heading({
  as: As,
  ...props
}: { as: Level } & React.ComponentProps<"h2">) {
  const [copied, setCopied] = useState(false);
  if (!props.id) return <As {...props} />;
  const onCopy = () => {
    const url = new URL(window.location.href);
    url.hash = props.id as string;
    navigator.clipboard.writeText(url.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <As
      {...props}
      className={cn(
        "group/heading flex scroll-m-28 flex-row items-center gap-1",
        props.className,
      )}
    >
      <a data-card="" href={`#${props.id}`}>
        {props.children}
      </a>
      <span data-nosnippet className="inline-flex">
        <button
          type="button"
          aria-live="polite"
          aria-label={copied ? "Copied anchor link" : "Copy anchor link"}
          onClick={onCopy}
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-xs" }),
            "not-prose shrink-0 text-fd-muted-foreground opacity-0 transition-opacity group-hover/heading:opacity-100",
          )}
        >
          {copied ? <CopyCheckIcon /> : <LinkIcon />}
        </button>
      </span>
    </As>
  );
}

// Individual exports: a 'use client' module's exports are client references, which cannot be spread as an object.
export const H1 = (props: React.ComponentProps<"h1">) => (
  <Heading as="h1" {...props} />
);
export const H2 = (props: React.ComponentProps<"h2">) => (
  <Heading as="h2" {...props} />
);
export const H3 = (props: React.ComponentProps<"h3">) => (
  <Heading as="h3" {...props} />
);
export const H4 = (props: React.ComponentProps<"h4">) => (
  <Heading as="h4" {...props} />
);
export const H5 = (props: React.ComponentProps<"h5">) => (
  <Heading as="h5" {...props} />
);
export const H6 = (props: React.ComponentProps<"h6">) => (
  <Heading as="h6" {...props} />
);
