import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { scriptAttr } from "@snagset/types/names";

/** The one tag there is: the stub, the site, nothing else. */
export function installTag(uid: string): string {
  return `<script src="${location.origin}/snag.js" ${scriptAttr("site")}="${uid}" defer></script>`;
}

export function InstallTag({ uid }: { uid: string }) {
  const [copied, setCopied] = useState(false);
  const tag = installTag(uid);
  return (
    <div className="relative rounded-md border border-border bg-background px-3 py-2.5 pr-11 font-mono text-[12.5px] leading-relaxed">
      <code className="whitespace-pre-wrap break-all">{tag}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute right-1.5 top-1.5"
        aria-label={copied ? "Copied" : "Copy the tag"}
        onClick={() => {
          void navigator.clipboard?.writeText(tag);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}
