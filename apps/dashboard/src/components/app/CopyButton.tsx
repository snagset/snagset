import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Copies `text`; the icon says so for a moment. `label` is the accessible name and, when `withText`, the visible one. */
export function CopyButton({
  text,
  label = "Copy",
  withText = false,
  size = "icon-sm",
  className,
}: {
  text: string;
  label?: string;
  withText?: boolean;
  size?: "icon-sm" | "sm";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size={withText ? "sm" : size}
      className={className}
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {withText && (copied ? "Copied" : label)}
    </Button>
  );
}
